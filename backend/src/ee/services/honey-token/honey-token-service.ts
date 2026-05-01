import { ForbiddenError } from "@casl/ability";

import { ActionProjectType, SecretType, TableName } from "@app/db/schemas";
import {
  ProjectPermissionActions,
  ProjectPermissionHoneyTokenActions,
  ProjectPermissionSub
} from "@app/ee/services/permission/project-permission";
import { BadRequestError, NotFoundError } from "@app/lib/errors";
import { OrderByDirection, OrgServiceActor } from "@app/lib/types";
import { ActorType } from "@app/services/auth/auth-type";
import { KmsDataKey } from "@app/services/kms/kms-types";
import { fnSecretBulkDelete, fnSecretBulkInsert } from "@app/services/secret-v2-bridge/secret-v2-bridge-fns";

import { HoneyTokenStatus, HoneyTokenType } from "./honey-token-enums";
import { THoneyTokenDeploymentStatus, THoneyTokenProviderHooks } from "./honey-token-provider-hook-types";
import { THoneyTokenByIdInput, THoneyTokenCreateInput } from "./honey-token-provider-types";
import {
  getHoneyTokenProviderDefinition,
  getHoneyTokenServiceHooksByType,
  HONEY_TOKEN_PROVIDER_MAP
} from "./honey-token-provider-registry";
import { THoneyTokenServiceFactoryDep } from "./honey-token-service-types";

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
interface THoneyTokenCreateResult {
  honeyToken: {
    id: string;
    name: string;
    description?: string | null;
    type: string;
    status: string;
    projectId: string;
    secretsMapping: unknown;
    createdAt: Date;
    updatedAt: Date;
  };
  stackDeployment?: THoneyTokenDeploymentStatus;
}

export const honeyTokenServiceFactory = ({
  honeyTokenDAL,
  honeyTokenConfigDAL,
  honeyTokenEventDAL,
  permissionService,
  licenseService,
  kmsService,
  appConnectionDAL,
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

    // Backwards compatibility: older roles may not yet include the new honey-token subject.
    // Fall back to the equivalent secret/folder permission actions.
    const legacyAction = action as ProjectPermissionActions;
    if (
      permission.can(legacyAction, ProjectPermissionSub.Secrets) ||
      permission.can(legacyAction, ProjectPermissionSub.SecretFolders)
    ) {
      return permission;
    }

    ForbiddenError.from(permission).throwUnlessCan(action, ProjectPermissionSub.HoneyTokens);
    return permission;
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

    const honeyToken = await honeyTokenDAL.create({
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
    });

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
      }
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
      honeyToken: {
        id: honeyToken.id,
        name: honeyToken.name,
        description: honeyToken.description,
        type: honeyToken.type,
        status: honeyToken.status,
        projectId: honeyToken.projectId,
        secretsMapping: honeyToken.secretsMapping,
        createdAt: honeyToken.createdAt,
        updatedAt: honeyToken.updatedAt
      },
      ...(stackDeployment ? { stackDeployment } : {})
    };
  };

  const updateHoneyToken = async (
    {
      honeyTokenId,
      projectId,
      name,
      description,
      secretsMapping
    }: {
      honeyTokenId: string;
      projectId: string;
      name?: string;
      description?: string | null;
      secretsMapping?: Record<string, string>;
    },
    actor: OrgServiceActor
  ) => {
    await ensurePlanSupportsHoneyTokens(actor.orgId, "update honey token");
    await assertProjectPermission({ projectId, actor, action: ProjectPermissionHoneyTokenActions.Edit });

    const honeyToken = await honeyTokenDAL.findById(honeyTokenId);

    if (!honeyToken || honeyToken.projectId !== projectId) {
      throw new NotFoundError({ message: `Honey token with ID "${honeyTokenId}" not found` });
    }

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

      await fnSecretBulkDelete({
        folderId: honeyToken.folderId,
        projectId,
        inputSecrets: oldSecretKeys.map((key) => ({ type: SecretType.Shared, secretKey: key })),
        actorId: actor.id,
        secretDAL,
        secretQueueService,
        folderCommitService,
        secretVersionDAL
      });

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
        }
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
      honeyToken: {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        type: updated.type,
        status: updated.status,
        projectId: updated.projectId,
        secretsMapping: updated.secretsMapping,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt
      }
    };
  };

  const revokeHoneyToken = async (
    { honeyTokenId, projectId }: { honeyTokenId: string; projectId: string },
    actor: OrgServiceActor
  ) => {
    await ensurePlanSupportsHoneyTokens(actor.orgId, "revoke honey token");
    await assertProjectPermission({ projectId, actor, action: ProjectPermissionHoneyTokenActions.Delete });

    const honeyToken = await honeyTokenDAL.findById(honeyTokenId);

    if (!honeyToken || honeyToken.projectId !== projectId) {
      throw new NotFoundError({ message: `Honey token with ID "${honeyTokenId}" not found` });
    }

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

    await fnSecretBulkDelete({
      folderId: honeyToken.folderId,
      projectId,
      inputSecrets: secretKeys.map((key) => ({ type: SecretType.Shared, secretKey: key })),
      actorId: actor.id,
      secretDAL,
      secretQueueService,
      folderCommitService,
      secretVersionDAL
    });

    await honeyTokenDAL.updateById(honeyTokenId, {
      status: HoneyTokenStatus.Revoked,
      revokedAt: new Date(),
      revokedByUserId: actor.id
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

  const resetHoneyToken = async (
    { honeyTokenId, projectId }: { honeyTokenId: string; projectId: string },
    actor: OrgServiceActor
  ) => {
    await assertProjectPermission({ projectId, actor, action: ProjectPermissionHoneyTokenActions.Edit });

    const honeyToken = await honeyTokenDAL.findById(honeyTokenId);

    if (!honeyToken || honeyToken.projectId !== projectId) {
      throw new NotFoundError({ message: `Honey token with ID "${honeyTokenId}" not found` });
    }
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
    await assertProjectPermission({ projectId, actor, action: ProjectPermissionHoneyTokenActions.Create });

    const plan = await ensurePlanSupportsHoneyTokens(actor.orgId, "access honey token limits");
    const used = await honeyTokenDAL.countByOrgId(actor.orgId);

    return {
      used,
      limit: plan.honeyTokenLimit
    };
  };

  const getDashboardHoneyTokens = async (
    {
      projectId,
      environments,
      secretPath,
      search,
      orderBy,
      orderDirection,
      limit,
      offset
    }: {
      projectId: string;
      environments: string[];
      secretPath: string;
      search?: string;
      orderBy?: string;
      orderDirection?: OrderByDirection;
      limit?: number;
      offset?: number;
    },
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

  const getCredentials = async ({ honeyTokenId, projectId }: THoneyTokenByIdInput, actor: OrgServiceActor) => {
    await assertProjectPermission({ projectId, actor, action: ProjectPermissionHoneyTokenActions.Read });

    const honeyToken = await honeyTokenDAL.findById(honeyTokenId);

    if (!honeyToken || honeyToken.projectId !== projectId) {
      throw new NotFoundError({ message: `Honey token with ID "${honeyTokenId}" not found` });
    }

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

  const getHoneyTokenById = async (
    { honeyTokenId, projectId }: { honeyTokenId: string; projectId: string },
    actor: OrgServiceActor
  ) => {
    await assertProjectPermission({ projectId, actor, action: ProjectPermissionHoneyTokenActions.Read });

    const honeyToken = await honeyTokenDAL.findById(honeyTokenId);

    if (!honeyToken || honeyToken.projectId !== projectId) {
      throw new NotFoundError({ message: `Honey token with ID "${honeyTokenId}" not found` });
    }

    const allInFolder = await honeyTokenDAL.findByFolderIds([honeyToken.folderId]);
    const match = allInFolder.find((ht) => ht.id === honeyTokenId);

    const openEvents = await honeyTokenEventDAL.countByHoneyTokenId(honeyTokenId, honeyToken.lastResetAt ?? undefined);

    return {
      honeyToken: {
        id: honeyToken.id,
        name: honeyToken.name,
        description: honeyToken.description,
        type: honeyToken.type,
        status: honeyToken.status,
        projectId: honeyToken.projectId,
        folderId: honeyToken.folderId,
        connectionId: honeyToken.connectionId,
        secretsMapping: honeyToken.secretsMapping,
        createdAt: honeyToken.createdAt,
        updatedAt: honeyToken.updatedAt,
        lastResetAt: honeyToken.lastResetAt,
        revokedAt: honeyToken.revokedAt,
        createdByUserId: honeyToken.createdByUserId,
        resetByUserId: honeyToken.resetByUserId,
        revokedByUserId: honeyToken.revokedByUserId,
        environment: match?.environment ?? null,
        folder: match?.folder ?? null,
        openEvents
      }
    };
  };

  const getHoneyTokenEvents = async (
    {
      honeyTokenId,
      projectId,
      offset,
      limit
    }: { honeyTokenId: string; projectId: string; offset?: number; limit?: number },
    actor: OrgServiceActor
  ) => {
    await assertProjectPermission({ projectId, actor, action: ProjectPermissionHoneyTokenActions.Read });

    const honeyToken = await honeyTokenDAL.findById(honeyTokenId);

    if (!honeyToken || honeyToken.projectId !== projectId) {
      throw new NotFoundError({ message: `Honey token with ID "${honeyTokenId}" not found` });
    }

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
    getDashboardHoneyTokens
  };
};
