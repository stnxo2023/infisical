import { ForbiddenError } from "@casl/ability";

import { ActionProjectType, OrgMembershipRole, SecretType, TableName } from "@app/db/schemas";
import {
  ProjectPermissionHoneyTokenActions,
  ProjectPermissionSub
} from "@app/ee/services/permission/project-permission";
import { crypto } from "@app/lib/crypto/cryptography";
import { getConfig as getAppConfig } from "@app/lib/config/env";
import { BadRequestError, NotFoundError, UnauthorizedError } from "@app/lib/errors";
import { removeTrailingSlash } from "@app/lib/fn";
import { logger } from "@app/lib/logger";
import { OrderByDirection, OrgServiceActor } from "@app/lib/types";
import { ActorType } from "@app/services/auth/auth-type";
import { KmsDataKey } from "@app/services/kms/kms-types";
import { fnSecretBulkDelete, fnSecretBulkInsert } from "@app/services/secret-v2-bridge/secret-v2-bridge-fns";
import { SmtpTemplates } from "@app/services/smtp/smtp-service";

import { HoneyTokenEventType, HoneyTokenStatus, HoneyTokenType } from "./honey-token-enums";
import { THoneyTokenProviderHooks } from "./honey-token-provider-hook-types";
import {
  THoneyTokenByIdInput,
  THoneyTokenCreateInput,
  THoneyTokenListInput,
  THoneyTokenUpdateInput
} from "./honey-token-provider-types";
import {
  AwsHoneyTokenConfigSchema,
  AwsHoneyTokenEventMetadataSchema,
  THoneyTokenEventsInput
} from "./honey-token-types";
import {
  getHoneyTokenProviderDefinition,
  getHoneyTokenServiceHooksByType,
  HONEY_TOKEN_PROVIDER_MAP
} from "./honey-token-provider-registry";
import { THoneyTokenServiceFactoryDep } from "./honey-token-service-types";

const TRIGGER_NOTIFICATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

const assertSupportedHoneyTokenType = (type: string): HoneyTokenType => {
  if (Object.prototype.hasOwnProperty.call(HONEY_TOKEN_PROVIDER_MAP, type)) {
    return type as HoneyTokenType;
  }
  throw new BadRequestError({ message: "Unsupported honey token type" });
};

const assertHoneyTokenConnectionType = (type: HoneyTokenType, app: string) => {
  const provider = getHoneyTokenProviderDefinition(type);
  if (app !== provider.connectionApp) {
    throw new BadRequestError({
      message: `Honey Token is not configured for ${provider.name}`
    });
  }
};

export type THoneyTokenServiceFactory = ReturnType<typeof honeyTokenServiceFactory>;

export const honeyTokenServiceFactory = ({
  honeyTokenDAL,
  honeyTokenConfigDAL,
  honeyTokenEventDAL,
  permissionService,
  licenseService,
  kmsService,
  appConnectionDAL,
  orgDAL,
  projectDAL,
  smtpService,
  folderDAL,
  projectBotService,
  secretDAL,
  secretVersionDAL,
  secretVersionTagDAL,
  secretTagDAL,
  folderCommitService,
  resourceMetadataDAL,
  snapshotService,
  secretQueueService
}: THoneyTokenServiceFactoryDep) => {
  const honeyTokenProviderHooksByType: Record<HoneyTokenType, THoneyTokenProviderHooks> =
    getHoneyTokenServiceHooksByType({
      honeyTokenDAL,
      honeyTokenConfigDAL,
      honeyTokenEventDAL,
      permissionService,
      licenseService,
      kmsService,
      appConnectionDAL,
      orgDAL,
      projectDAL,
      smtpService,
      folderDAL,
      projectBotService,
      secretDAL,
      secretVersionDAL,
      secretVersionTagDAL,
      secretTagDAL,
      folderCommitService,
      resourceMetadataDAL,
      snapshotService,
      secretQueueService
    });

  const ensurePlanSupportsHoneyTokens = async (orgId: string, action: string) => {
    const plan = await licenseService.getPlan(orgId);
    if (!plan.honeyTokens) {
      throw new BadRequestError({
        message: `Failed to ${action} due to plan restriction. Upgrade plan to use honey tokens.`
      });
    }
    return plan;
  };

  const getProjectPermission = async (projectId: string, actor: OrgServiceActor) =>
    permissionService.getProjectPermission({
      actor: actor.type,
      actorId: actor.id,
      actorAuthMethod: actor.authMethod,
      actorOrgId: actor.orgId,
      actionProjectType: ActionProjectType.SecretManager,
      projectId
    });

  const assertProjectPermission = async ({
    projectId,
    actor,
    action
  }: {
    projectId: string;
    actor: OrgServiceActor;
    action: ProjectPermissionHoneyTokenActions;
  }) => {
    const { permission } = await getProjectPermission(projectId, actor);
    if (permission.can(action, ProjectPermissionSub.HoneyTokens)) {
      return permission;
    }

    ForbiddenError.from(permission).throwUnlessCan(action, ProjectPermissionSub.HoneyTokens);
    return permission;
  };

  const getHoneyTokenWithProjectAccess = async ({
    honeyTokenId,
    actor,
    action
  }: {
    honeyTokenId: string;
    actor: OrgServiceActor;
    action: ProjectPermissionHoneyTokenActions;
  }) => {
    const honeyToken = await honeyTokenDAL.findById(honeyTokenId);
    if (!honeyToken) {
      throw new NotFoundError({ message: `Honey token with ID "${honeyTokenId}" not found` });
    }

    try {
      await assertProjectPermission({ projectId: honeyToken.projectId, actor, action });
    } catch (error) {
      if (error instanceof ForbiddenError) {
        throw new NotFoundError({ message: `Honey token with ID "${honeyTokenId}" not found` });
      }
      throw error;
    }

    return honeyToken;
  };

  const create = async (
    { projectId, type, name, description, secretsMapping, environment, secretPath }: THoneyTokenCreateInput,
    actor: OrgServiceActor
  ) => {
    const providerType = assertSupportedHoneyTokenType(type);
    const providerHooks = honeyTokenProviderHooksByType[providerType];
    if (!providerHooks) {
      throw new BadRequestError({ message: "Unsupported honey token type" });
    }

    const plan = await ensurePlanSupportsHoneyTokens(actor.orgId, "create honey token");

    if (plan.honeyTokenLimit !== null) {
      const honeyTokensCreated = await honeyTokenDAL.countByOrgId(actor.orgId);
      if (honeyTokensCreated >= plan.honeyTokenLimit) {
        throw new BadRequestError({
          message: `Failed to create honey token because your organization has reached its honey token limit (${honeyTokensCreated}/${plan.honeyTokenLimit}).`
        });
      }
    }

    await assertProjectPermission({ projectId, actor, action: ProjectPermissionHoneyTokenActions.Create });

    const { shouldUseSecretV2Bridge } = await projectBotService.getBotKey(projectId);

    if (!shouldUseSecretV2Bridge) {
      throw new BadRequestError({
        message: "Project version does not support honey tokens. Please upgrade your project."
      });
    }

    const orgConfig = await honeyTokenConfigDAL.findOne({
      orgId: actor.orgId,
      type: providerType
    });

    if (!orgConfig?.connectionId) {
      throw new BadRequestError({
        message:
          "No honey token configuration found for this organization. Configure it in Organization Settings first."
      });
    }

    const folder = await folderDAL.findBySecretPath(projectId, environment, secretPath);

    if (!folder) {
      throw new BadRequestError({
        message: `Could not find folder with path "${secretPath}" in environment "${environment}"`
      });
    }

    const existingHoneyToken = await honeyTokenDAL.findOne({ name, folderId: folder.id });

    if (existingHoneyToken) {
      throw new BadRequestError({
        message: `A honey token with the name "${name}" already exists at the path "${secretPath}" in environment "${environment}"`
      });
    }

    const secretKeys = Object.values(secretsMapping);

    if (new Set(secretKeys).size !== secretKeys.length) {
      throw new BadRequestError({
        message: `Secrets mapping keys must be unique. "${secretKeys.join(", ")}" contains duplicate keys.`
      });
    }

    const conflictingSecrets = await secretDAL.find({
      $in: {
        [`${TableName.SecretV2}.key` as "key"]: secretKeys
      },
      [`${TableName.SecretV2}.folderId` as "folderId"]: folder.id,
      [`${TableName.SecretV2}.type` as "type"]: SecretType.Shared
    });

    if (conflictingSecrets.length) {
      throw new BadRequestError({
        message: `The following secrets already exist at the path "${secretPath}": ${conflictingSecrets
          .map(({ key }) => key)
          .join(", ")}`
      });
    }

    const appConnection = await appConnectionDAL.findById(orgConfig.connectionId);

    if (!appConnection) {
      throw new NotFoundError({
        message: `Could not find App Connection with ID ${orgConfig.connectionId}`
      });
    }
    assertHoneyTokenConnectionType(providerType, appConnection.app);
    const { credentials: honeyTokenCredentials, tokenIdentifier } = await providerHooks.createCredentials(appConnection);

    const { encryptor: credentialEncryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId: actor.orgId
    });

    const encryptedCredentials = credentialEncryptor({
      plainText: Buffer.from(JSON.stringify(honeyTokenCredentials))
    }).cipherTextBlob;

    const { encryptor: secretEncryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.SecretManager,
      projectId
    });

    const secretEntries = Object.entries(secretsMapping).map(([credentialField, secretKey]) => {
      const credentialValue = honeyTokenCredentials[credentialField];
      if (credentialValue === undefined) {
        throw new BadRequestError({
          message: `Secrets mapping key "${credentialField}" does not exist in generated credentials for this honey token type`
        });
      }

      return { key: secretKey, value: credentialValue };
    });

    const honeyToken = await honeyTokenDAL.transaction(async (tx) => {
      const createdHoneyToken = await honeyTokenDAL.create(
        {
          name,
          description,
          type: providerType,
          status: HoneyTokenStatus.Active,
          projectId,
          folderId: folder.id,
          connectionId: orgConfig.connectionId,
          encryptedCredentials,
          secretsMapping,
          tokenIdentifier,
          createdByUserId: actor.id
        },
        tx
      );

      await fnSecretBulkInsert({
        folderId: folder.id,
        orgId: actor.orgId,
        inputSecrets: secretEntries.map(({ key, value }) => ({
          key,
          type: SecretType.Shared,
          encryptedValue: secretEncryptor({
            plainText: Buffer.from(value)
          }).cipherTextBlob,
          references: []
        })),
        secretDAL,
        secretVersionDAL,
        secretVersionTagDAL,
        secretTagDAL,
        folderCommitService,
        resourceMetadataDAL,
        actor: {
          type: actor.type as ActorType,
          actorId: actor.id
        },
        tx
      });

      return createdHoneyToken;
    });

    await secretDAL.invalidateSecretCacheByProjectId(projectId);
    await snapshotService.performSnapshot(folder.id);
    await secretQueueService.syncSecrets({
      orgId: actor.orgId,
      secretPath,
      projectId,
      environmentSlug: environment,
      excludeReplication: true
    });

    const stackDeployment = providerHooks.verifyDeployment
      ? await providerHooks.verifyDeployment({
          appConnection,
          connectionId: orgConfig.connectionId,
          orgId: actor.orgId,
          encryptedConfig: orgConfig.encryptedConfig
        })
      : undefined;

    return {
      honeyToken,
      ...(stackDeployment ? { stackDeployment } : {})
    };
  };

  const updateHoneyToken = async (
    { honeyTokenId, name, description, secretsMapping }: THoneyTokenUpdateInput,
    actor: OrgServiceActor
  ) => {
    await ensurePlanSupportsHoneyTokens(actor.orgId, "update honey token");
    const honeyToken = await getHoneyTokenWithProjectAccess({
      honeyTokenId,
      actor,
      action: ProjectPermissionHoneyTokenActions.Create
    });
    const { projectId } = honeyToken;

    if (name && name !== honeyToken.name) {
      const existingHoneyToken = await honeyTokenDAL.findOne({ name, folderId: honeyToken.folderId });

      if (existingHoneyToken) {
        throw new BadRequestError({
          message: `A honey token with the name "${name}" already exists in this path`
        });
      }
    }

    const oldMapping = honeyToken.secretsMapping as Record<string, string>;

    if (secretsMapping) {
      const newSecretKeys = Object.values(secretsMapping);

      if (new Set(newSecretKeys).size !== newSecretKeys.length) {
        throw new BadRequestError({
          message: `Secrets mapping keys must be unique. "${newSecretKeys.join(", ")}" contains duplicate keys.`
        });
      }

      const changedKeys = newSecretKeys.filter((key) => !Object.values(oldMapping).includes(key));

      if (changedKeys.length > 0) {
        const conflictingSecrets = await secretDAL.find({
          $in: {
            [`${TableName.SecretV2}.key` as "key"]: changedKeys
          },
          [`${TableName.SecretV2}.folderId` as "folderId"]: honeyToken.folderId,
          [`${TableName.SecretV2}.type` as "type"]: SecretType.Shared
        });

        if (conflictingSecrets.length) {
          throw new BadRequestError({
            message: `The following secrets already exist: ${conflictingSecrets.map(({ key }) => key).join(", ")}`
          });
        }
      }

      const oldSecretKeys = Object.values(oldMapping);

      const { decryptor } = await kmsService.createCipherPairWithDataKey({
        type: KmsDataKey.Organization,
        orgId: actor.orgId
      });

      const decryptedCredentials = JSON.parse(
        decryptor({ cipherTextBlob: honeyToken.encryptedCredentials }).toString()
      ) as Record<string, string>;

      const { encryptor: secretEncryptor } = await kmsService.createCipherPairWithDataKey({
        type: KmsDataKey.SecretManager,
        projectId
      });

      const secretEntries = Object.entries(secretsMapping).map(([credentialField, secretKey]) => {
        const credentialValue = decryptedCredentials[credentialField];
        if (credentialValue === undefined) {
          throw new BadRequestError({
            message: `Secrets mapping key "${credentialField}" does not exist in stored credentials for this honey token type`
          });
        }

        return { key: secretKey, value: credentialValue };
      });

      await honeyTokenDAL.transaction(async (tx) => {
        await fnSecretBulkDelete({
          folderId: honeyToken.folderId,
          projectId,
          inputSecrets: oldSecretKeys.map((key) => ({ type: SecretType.Shared, secretKey: key })),
          actorId: actor.id,
          secretDAL,
          secretQueueService,
          folderCommitService,
          secretVersionDAL,
          tx
        });

        await fnSecretBulkInsert({
          folderId: honeyToken.folderId,
          orgId: actor.orgId,
          inputSecrets: secretEntries.map(({ key, value }) => ({
            key,
            type: SecretType.Shared,
            encryptedValue: secretEncryptor({
              plainText: Buffer.from(value)
            }).cipherTextBlob,
            references: []
          })),
          secretDAL,
          secretVersionDAL,
          secretVersionTagDAL,
          secretTagDAL,
          folderCommitService,
          resourceMetadataDAL,
          actor: {
            type: actor.type as ActorType,
            actorId: actor.id
          },
          tx
        });
      });
    }

    const updated = await honeyTokenDAL.updateById(honeyTokenId, {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(secretsMapping !== undefined && { secretsMapping })
    });

    await secretDAL.invalidateSecretCacheByProjectId(projectId);
    await snapshotService.performSnapshot(honeyToken.folderId);

    const [folderInfo] = await folderDAL.findSecretPathByFolderIds(projectId, [honeyToken.folderId]);
    if (folderInfo) {
      await secretQueueService.syncSecrets({
        orgId: actor.orgId,
        secretPath: folderInfo.path,
        projectId,
        environmentSlug: folderInfo.environmentSlug,
        excludeReplication: true
      });
    }

    return {
      honeyToken: updated
    };
  };

  const revokeHoneyToken = async ({ honeyTokenId }: THoneyTokenByIdInput, actor: OrgServiceActor) => {
    await ensurePlanSupportsHoneyTokens(actor.orgId, "revoke honey token");
    const honeyToken = await getHoneyTokenWithProjectAccess({
      honeyTokenId,
      actor,
      action: ProjectPermissionHoneyTokenActions.Revoke
    });
    const { projectId } = honeyToken;

    if (honeyToken.status === HoneyTokenStatus.Revoked) {
      throw new BadRequestError({ message: "Honey token is already revoked" });
    }
    const type = assertSupportedHoneyTokenType(honeyToken.type);

    const { decryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId: actor.orgId
    });

    const decryptedCredentials = JSON.parse(
      decryptor({ cipherTextBlob: honeyToken.encryptedCredentials }).toString()
    ) as Record<string, string>;

    const appConnection = await appConnectionDAL.findById(honeyToken.connectionId);

    if (appConnection) {
      assertHoneyTokenConnectionType(type, appConnection.app);
      const providerHooks = honeyTokenProviderHooksByType[type];
      if (!providerHooks) throw new BadRequestError({ message: "Unsupported honey token type" });
      await providerHooks.revokeCredentials({
        appConnection,
        credentials: decryptedCredentials
      });
    }

    const secretKeys = Object.values(honeyToken.secretsMapping as Record<string, string>);

    await honeyTokenDAL.transaction(async (tx) => {
      await fnSecretBulkDelete({
        folderId: honeyToken.folderId,
        projectId,
        inputSecrets: secretKeys.map((key) => ({ type: SecretType.Shared, secretKey: key })),
        actorId: actor.id,
        secretDAL,
        secretQueueService,
        folderCommitService,
        secretVersionDAL,
        tx
      });

      await honeyTokenDAL.updateById(
        honeyTokenId,
        {
          status: HoneyTokenStatus.Revoked,
          revokedAt: new Date(),
          revokedByUserId: actor.id
        },
        tx
      );
    });

    await secretDAL.invalidateSecretCacheByProjectId(projectId);
    await snapshotService.performSnapshot(honeyToken.folderId);

    const [folderInfo] = await folderDAL.findSecretPathByFolderIds(projectId, [honeyToken.folderId]);
    if (folderInfo) {
      await secretQueueService.syncSecrets({
        orgId: actor.orgId,
        secretPath: folderInfo.path,
        projectId,
        environmentSlug: folderInfo.environmentSlug,
        excludeReplication: true
      });
    }

    return { honeyTokenId };
  };

  const resetHoneyToken = async ({ honeyTokenId }: THoneyTokenByIdInput, actor: OrgServiceActor) => {
    const honeyToken = await getHoneyTokenWithProjectAccess({
      honeyTokenId,
      actor,
      action: ProjectPermissionHoneyTokenActions.Reset
    });
    assertSupportedHoneyTokenType(honeyToken.type);

    if (honeyToken.status !== HoneyTokenStatus.Triggered) {
      throw new BadRequestError({ message: "Only triggered honey tokens can be reset" });
    }

    const updated = await honeyTokenDAL.updateById(honeyTokenId, {
      status: HoneyTokenStatus.Active,
      lastResetAt: new Date(),
      lastTriggeredAt: null,
      resetByUserId: actor.id
    });

    return { honeyToken: updated };
  };

  const getDashboardHoneyTokenCount = async (
    {
      projectId,
      environments,
      secretPath,
      search
    }: {
      projectId: string;
      environments: string[];
      secretPath: string;
      search?: string;
    },
    actor: OrgServiceActor
  ) => {
    await getProjectPermission(projectId, actor);

    const folders = await folderDAL.findBySecretPathMultiEnv(projectId, environments, secretPath);
    if (!folders.length) return 0;

    const folderIds = folders.map((f) => f.id);
    return honeyTokenDAL.countByFolderIds(folderIds, search);
  };

  const getOrgHoneyTokenLimit = async ({ projectId }: { projectId: string }, actor: OrgServiceActor) => {
    await assertProjectPermission({ projectId, actor, action: ProjectPermissionHoneyTokenActions.Read });

    const plan = await ensurePlanSupportsHoneyTokens(actor.orgId, "access honey token limits");
    const used = await honeyTokenDAL.countByOrgId(actor.orgId);

    return {
      used,
      limit: plan.honeyTokenLimit
    };
  };

  const getDashboardHoneyTokens = async (
    { projectId, environments, secretPath, search, orderBy, orderDirection, limit, offset }: THoneyTokenListInput,
    actor: OrgServiceActor
  ) => {
    await getProjectPermission(projectId, actor);

    const folders = await folderDAL.findBySecretPathMultiEnv(projectId, environments, secretPath);
    if (!folders.length) return [];

    const folderIds = folders.map((f) => f.id);
    let honeyTokens = await honeyTokenDAL.findByFolderIds(folderIds);

    if (search) {
      honeyTokens = honeyTokens.filter((ht) => ht.name.toLowerCase().includes(search.toLowerCase()));
    }

    if (orderBy === "name") {
      honeyTokens.sort((a, b) => {
        const cmp = a.name.localeCompare(b.name);
        return orderDirection === OrderByDirection.DESC ? -cmp : cmp;
      });
    }

    if (offset !== undefined && limit !== undefined) {
      honeyTokens = honeyTokens.slice(offset, offset + limit);
    }

    return honeyTokens;
  };

  const getCredentials = async ({ honeyTokenId }: THoneyTokenByIdInput, actor: OrgServiceActor) => {
    const honeyToken = await getHoneyTokenWithProjectAccess({
      honeyTokenId,
      actor,
      action: ProjectPermissionHoneyTokenActions.Read
    });

    const type = assertSupportedHoneyTokenType(honeyToken.type);
    const providerHooks = honeyTokenProviderHooksByType[type];
    if (!providerHooks) throw new BadRequestError({ message: "Unsupported honey token type" });

    return {
      type,
      credentials: await providerHooks.getCredentialsForDisplay({
        encryptedCredentials: honeyToken.encryptedCredentials,
        orgId: actor.orgId
      })
    };
  };

  const sendTriggerNotification = async ({
    orgId,
    honeyToken,
    eventMetadata
  }: {
    orgId: string;
    honeyToken: { id: string; name: string; projectId: string };
    eventMetadata: {
      eventName: string;
      eventTime: string;
      sourceIp?: string;
      awsRegion: string;
    };
  }) => {
    try {
      const [project, orgAdmins] = await Promise.all([
        projectDAL.findById(honeyToken.projectId),
        orgDAL.findOrgMembersByRole(orgId, OrgMembershipRole.Admin)
      ]);
      const adminEmails = orgAdmins.map((admin) => admin.user.email).filter(Boolean) as string[];
      if (adminEmails.length === 0 || !project) return;

      const cfg = getAppConfig();
      const siteUrl = removeTrailingSlash(cfg.SITE_URL || "https://app.infisical.com");
      await smtpService.sendMail({
        recipients: adminEmails,
        subjectLine: `Security Alert: Honey Token "${honeyToken.name}" Triggered`,
        template: SmtpTemplates.HoneyTokenTriggered,
        substitutions: {
          honeyTokenName: honeyToken.name,
          projectName: project.name,
          eventName: eventMetadata.eventName,
          eventTime: eventMetadata.eventTime,
          sourceIp: eventMetadata.sourceIp || "Unknown",
          awsRegion: eventMetadata.awsRegion,
          projectUrl: `${siteUrl}/organizations/${orgId}/projects/secret-management/${project.id}/overview?honeyTokenId=${honeyToken.id}`
        }
      });
    } catch (err) {
      logger.error(
        { err, orgId, honeyTokenId: honeyToken.id },
        `Failed to send honey token trigger notification [orgId=${orgId}] [honeyTokenId=${honeyToken.id}]`
      );
    }
  };

  const handleTrigger = async ({
    type,
    orgId,
    signature,
    payload
  }: {
    type: HoneyTokenType;
    orgId: string;
    signature: string | undefined;
    payload: unknown;
  }) => {
    const providerType = assertSupportedHoneyTokenType(type);
    if (providerType !== HoneyTokenType.AWS) {
      throw new BadRequestError({ message: "Unsupported honey token type" });
    }

    if (!signature) throw new UnauthorizedError({ message: "Missing X-Infisical-Signature header" });

    const parts = Object.fromEntries(signature.split(",").map((p) => p.split("="))) as Record<string, string>;
    const timestamp = parts.t;
    const signatureHash = parts.v1;
    if (!timestamp || !signatureHash) {
      throw new UnauthorizedError({
        message: "Invalid X-Infisical-Signature format. Expected t=<timestamp>,v1=<signature>"
      });
    }

    const timestampMs = Number(timestamp) * 1000;
    if (Number.isNaN(timestampMs) || Math.abs(Date.now() - timestampMs) > SIGNATURE_TOLERANCE_MS) {
      throw new UnauthorizedError({ message: "Request timestamp is too old or invalid" });
    }

    const config = await honeyTokenConfigDAL.findOne({ orgId, type: HoneyTokenType.AWS });
    if (!config?.encryptedConfig) {
      throw new NotFoundError({ message: "No honey token configuration found for this organization" });
    }

    const { decryptor } = await kmsService.createCipherPairWithDataKey({ type: KmsDataKey.Organization, orgId });
    const decrypted = decryptor({ cipherTextBlob: config.encryptedConfig });
    const storedConfig = AwsHoneyTokenConfigSchema.parse(JSON.parse(decrypted.toString()) as unknown);

    const bodyString = JSON.stringify(payload);
    const expectedSignature = crypto.nativeCrypto
      .createHmac("sha256", storedConfig.webhookSigningKey)
      .update(`${timestamp}.${bodyString}`)
      .digest("hex");
    const expectedBuf = Buffer.from(expectedSignature, "hex");
    const receivedBuf = Buffer.from(signatureHash, "hex");
    if (
      expectedBuf.byteLength !== receivedBuf.byteLength ||
      !crypto.nativeCrypto.timingSafeEqual(expectedBuf, receivedBuf)
    ) {
      throw new UnauthorizedError({ message: "Invalid webhook signature" });
    }

    const rawEvents = Array.isArray(payload) ? (payload as unknown[]) : [payload];
    /* eslint-disable no-continue */
    for await (const rawEvent of rawEvents) {
      const wrapped = rawEvent as { event?: unknown };
      const parsed = AwsHoneyTokenEventMetadataSchema.safeParse(wrapped.event ?? rawEvent);
      if (!parsed.success) {
        logger.warn(
          { orgId, event: rawEvent, error: parsed.error },
          `Failed to parse honey token event [orgId=${orgId}]`
        );
        continue;
      }
      const honeyToken = await honeyTokenDAL.findOneByTokenIdentifierAndOrgId(parsed.data.accessKeyId, orgId);
      if (!honeyToken) continue;
      if (honeyToken.status === HoneyTokenStatus.Revoked) continue;

      await honeyTokenEventDAL.create({
        honeyTokenId: honeyToken.id,
        eventType: HoneyTokenEventType.AWS,
        metadata: parsed.data
      });
      const updatedToken = await honeyTokenDAL.tryMarkTriggered(
        parsed.data.accessKeyId,
        TRIGGER_NOTIFICATION_COOLDOWN_MS
      );
      if (updatedToken) {
        void sendTriggerNotification({ orgId, honeyToken, eventMetadata: parsed.data });
      }
    }
    /* eslint-enable no-continue */

    return { acknowledged: true };
  };

  const getHoneyTokenById = async ({ honeyTokenId }: THoneyTokenByIdInput, actor: OrgServiceActor) => {
    const honeyToken = await getHoneyTokenWithProjectAccess({
      honeyTokenId,
      actor,
      action: ProjectPermissionHoneyTokenActions.Read
    });

    const allInFolder = await honeyTokenDAL.findByFolderIds([honeyToken.folderId]);
    const match = allInFolder.find((ht) => ht.id === honeyTokenId);

    const openEvents = await honeyTokenEventDAL.countByHoneyTokenId(honeyTokenId, honeyToken.lastResetAt ?? undefined);

    return {
      honeyToken: {
        ...honeyToken,
        environment: match?.environment ?? null,
        folder: match?.folder ?? null,
        openEvents
      }
    };
  };

  const getHoneyTokenEvents = async (
    {
      honeyTokenId,
      offset,
      limit
    }: THoneyTokenEventsInput,
    actor: OrgServiceActor
  ) => {
    const honeyToken = await getHoneyTokenWithProjectAccess({
      honeyTokenId,
      actor,
      action: ProjectPermissionHoneyTokenActions.Read
    });

    const since = honeyToken.lastResetAt ?? undefined;

    const [events, totalCount] = await Promise.all([
      honeyTokenEventDAL.findByHoneyTokenId(honeyTokenId, { since, offset, limit }),
      honeyTokenEventDAL.countByHoneyTokenId(honeyTokenId, since)
    ]);

    return { events, totalCount };
  };

  return {
    create,
    updateHoneyToken,
    revokeHoneyToken,
    resetHoneyToken,
    getCredentials,
    getHoneyTokenById,
    getHoneyTokenEvents,
    getDashboardHoneyTokenCount,
    getOrgHoneyTokenLimit,
    getDashboardHoneyTokens,
    handleTrigger
  };
};
