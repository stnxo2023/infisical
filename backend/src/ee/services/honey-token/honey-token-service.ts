import crypto from "node:crypto";

import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  IAMClient
} from "@aws-sdk/client-iam";
import { ForbiddenError } from "@casl/ability";

import { ActionProjectType, SecretType, TableName } from "@app/db/schemas";
import { TLicenseServiceFactory } from "@app/ee/services/license/license-service";
import { TPermissionServiceFactory } from "@app/ee/services/permission/permission-service-types";
import { ProjectPermissionHoneyTokenActions, ProjectPermissionSub } from "@app/ee/services/permission/project-permission";
import { BadRequestError, NotFoundError } from "@app/lib/errors";
import { logger } from "@app/lib/logger";
import { OrderByDirection, OrgServiceActor } from "@app/lib/types";
import { TAppConnectionDALFactory } from "@app/services/app-connection/app-connection-dal";
import { decryptAppConnection } from "@app/services/app-connection/app-connection-fns";
import { getAwsConnectionConfig } from "@app/services/app-connection/aws";
import { TAwsConnectionConfig } from "@app/services/app-connection/aws/aws-connection-types";
import { ActorType } from "@app/services/auth/auth-type";
import { TFolderCommitServiceFactory } from "@app/services/folder-commit/folder-commit-service";
import { TKmsServiceFactory } from "@app/services/kms/kms-service";
import { KmsDataKey } from "@app/services/kms/kms-types";
import { TProjectBotServiceFactory } from "@app/services/project-bot/project-bot-service";
import { TResourceMetadataDALFactory } from "@app/services/resource-metadata/resource-metadata-dal";
import { TSecretQueueFactory } from "@app/services/secret/secret-queue";
import { TSecretFolderDALFactory } from "@app/services/secret-folder/secret-folder-dal";
import { TSecretTagDALFactory } from "@app/services/secret-tag/secret-tag-dal";
import { TSecretV2BridgeDALFactory } from "@app/services/secret-v2-bridge/secret-v2-bridge-dal";
import { fnSecretBulkDelete, fnSecretBulkInsert } from "@app/services/secret-v2-bridge/secret-v2-bridge-fns";
import { TSecretVersionV2DALFactory } from "@app/services/secret-v2-bridge/secret-version-dal";
import { TSecretVersionV2TagDALFactory } from "@app/services/secret-v2-bridge/secret-version-tag-dal";

import { TSecretSnapshotServiceFactory } from "../secret-snapshot/secret-snapshot-service";
import { THoneyTokenConfigDALFactory } from "./honey-token-config-dal";
import { THoneyTokenDALFactory } from "./honey-token-dal";
import { HoneyTokenStatus, HoneyTokenType } from "./honey-token-enums";
import { THoneyTokenEventDALFactory } from "./honey-token-event-dal";
import { AwsHoneyTokenConfigSchema } from "./honey-token-types";
import {
  parseAwsHoneyTokenDecryptedCredentials,
  TAwsHoneyTokenCredentials
} from "./honey-token-aws-types";

const HONEY_TOKEN_IAM_USER_PREFIX = "inf_ht_";
const CF_COMPLETE_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"]);

type THoneyTokenServiceFactoryDep = {
  honeyTokenDAL: THoneyTokenDALFactory;
  honeyTokenConfigDAL: THoneyTokenConfigDALFactory;
  honeyTokenEventDAL: Pick<THoneyTokenEventDALFactory, "find" | "countByHoneyTokenId" | "findByHoneyTokenId">;
  permissionService: Pick<TPermissionServiceFactory, "getProjectPermission">;
  licenseService: Pick<TLicenseServiceFactory, "getPlan">;
  kmsService: Pick<TKmsServiceFactory, "createCipherPairWithDataKey">;
  appConnectionDAL: Pick<TAppConnectionDALFactory, "findById">;
  folderDAL: Pick<
    TSecretFolderDALFactory,
    "findBySecretPath" | "findBySecretPathMultiEnv" | "findSecretPathByFolderIds"
  >;
  projectBotService: Pick<TProjectBotServiceFactory, "getBotKey">;
  secretDAL: Pick<
    TSecretV2BridgeDALFactory,
    "insertMany" | "upsertSecretReferences" | "find" | "deleteMany" | "invalidateSecretCacheByProjectId"
  >;
  secretVersionDAL: Pick<TSecretVersionV2DALFactory, "insertMany" | "findLatestVersionMany">;
  secretVersionTagDAL: Pick<TSecretVersionV2TagDALFactory, "insertMany">;
  secretTagDAL: Pick<TSecretTagDALFactory, "saveTagsToSecretV2" | "find">;
  folderCommitService: Pick<TFolderCommitServiceFactory, "createCommit">;
  resourceMetadataDAL: Pick<TResourceMetadataDALFactory, "insertMany">;
  snapshotService: Pick<TSecretSnapshotServiceFactory, "performSnapshot">;
  secretQueueService: Pick<TSecretQueueFactory, "syncSecrets" | "removeSecretReminder">;
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
  const verifyStackDeployment = async ({
    connectionId,
    stackName
  }: {
    connectionId: string;
    stackName: string;
  }): Promise<{ deployed: boolean; status: string | null }> => {
    try {
      const appConnection = await appConnectionDAL.findById(connectionId);
      if (!appConnection) return { deployed: false, status: null };

      const decryptedConnection = await decryptAppConnection(appConnection, kmsService);
      const awsConfig = decryptedConnection as unknown as TAwsConnectionConfig;
      const { credentials: awsCredentials } = await getAwsConnectionConfig(awsConfig);

      const cfn = new CloudFormationClient({ credentials: awsCredentials, region: "us-east-1" });
      const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const stack = res.Stacks?.[0];

      if (!stack) return { deployed: false, status: null };

      return {
        deployed: CF_COMPLETE_STATUSES.has(stack.StackStatus ?? ""),
        status: stack.StackStatus ?? null
      };
    } catch (err) {
      const awsCode = (err as { code?: string }).code;

      if (awsCode === "ValidationError") {
        return { deployed: false, status: null };
      }

      logger.warn({ err, connectionId, stackName }, "Failed to verify honey token CloudFormation stack deployment");
      return { deployed: false, status: null };
    }
  };

  const create = async (
    {
      projectId,
      type,
      name,
      description,
      secretsMapping,
      environment,
      secretPath
    }: {
      projectId: string;
      type: HoneyTokenType;
      name: string;
      description?: string | null;
      secretsMapping: Record<string, string>;
      environment: string;
      secretPath: string;
    },
    actor: OrgServiceActor
  ) => {
    const plan = await licenseService.getPlan(actor.orgId);

    if (!plan.honeyTokens) {
      throw new BadRequestError({
        message: "Failed to create honey token due to plan restriction. Upgrade plan to use honey tokens."
      });
    }

    if (plan.honeyTokenLimit !== null) {
      const honeyTokensCreated = await honeyTokenDAL.countByOrgId(actor.orgId);
      if (honeyTokensCreated >= plan.honeyTokenLimit) {
        throw new BadRequestError({
          message: `Failed to create honey token because your organization has reached its honey token limit (${honeyTokensCreated}/${plan.honeyTokenLimit}).`
        });
      }
    }

    const { permission } = await permissionService.getProjectPermission({
      actor: actor.type,
      actorId: actor.id,
      actorAuthMethod: actor.authMethod,
      actorOrgId: actor.orgId,
      actionProjectType: ActionProjectType.SecretManager,
      projectId
    });

    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionHoneyTokenActions.Create,
      ProjectPermissionSub.HoneyTokens
    );

    const { shouldUseSecretV2Bridge } = await projectBotService.getBotKey(projectId);

    if (!shouldUseSecretV2Bridge) {
      throw new BadRequestError({
        message: "Project version does not support honey tokens. Please upgrade your project."
      });
    }

    const orgConfig = await honeyTokenConfigDAL.findOne({
      orgId: actor.orgId,
      type
    });

    if (!orgConfig?.connectionId) {
      throw new BadRequestError({
        message:
          "No honey token configuration found for this organization. Configure it in Organization Settings first."
      });
    }

    const { decryptor: configDecryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId: actor.orgId
    });
    const stackName = orgConfig.encryptedConfig
      ? AwsHoneyTokenConfigSchema.parse(
          JSON.parse(configDecryptor({ cipherTextBlob: orgConfig.encryptedConfig }).toString()) as unknown
        ).stackName
      : "infisical-honey-tokens";

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

    const decryptedConnection = await decryptAppConnection(appConnection, kmsService);
    const awsConfig = decryptedConnection as unknown as TAwsConnectionConfig;

    const iamUserName = `${HONEY_TOKEN_IAM_USER_PREFIX}${crypto.randomBytes(8).toString("hex")}`;

    const { credentials: awsCredentials, region } = await getAwsConnectionConfig(awsConfig);
    const iam = new IAMClient({ credentials: awsCredentials, region });

    await iam.send(new CreateUserCommand({ UserName: iamUserName }));

    const createKeyRes = await iam.send(new CreateAccessKeyCommand({ UserName: iamUserName }));

    if (!createKeyRes.AccessKey?.AccessKeyId || !createKeyRes.AccessKey?.SecretAccessKey) {
      throw new BadRequestError({ message: "Failed to create AWS access key for honey token" });
    }

    const honeyTokenCredentials = {
      accessKeyId: createKeyRes.AccessKey.AccessKeyId,
      secretAccessKey: createKeyRes.AccessKey.SecretAccessKey,
      iamUserName
    };

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
      type,
      status: HoneyTokenStatus.Active,
      projectId,
      folderId: folder.id,
      connectionId: orgConfig.connectionId,
      encryptedCredentials,
      secretsMapping,
      tokenIdentifier: createKeyRes.AccessKey.AccessKeyId,
      createdByUserId: actor.id
    });

    const { encryptor: secretEncryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.SecretManager,
      projectId
    });

    const secretEntries = [
      { key: secretsMapping.accessKeyId, value: createKeyRes.AccessKey.AccessKeyId },
      { key: secretsMapping.secretAccessKey, value: createKeyRes.AccessKey.SecretAccessKey }
    ];

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

    const stackDeployment = await verifyStackDeployment({
      connectionId: orgConfig.connectionId,
      stackName
    });

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
      stackDeployment
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
    const plan = await licenseService.getPlan(actor.orgId);

    if (!plan.honeyTokens) {
      throw new BadRequestError({
        message: "Failed to update honey token due to plan restriction. Upgrade plan to use honey tokens."
      });
    }

    const { permission } = await permissionService.getProjectPermission({
      actor: actor.type,
      actorId: actor.id,
      actorAuthMethod: actor.authMethod,
      actorOrgId: actor.orgId,
      actionProjectType: ActionProjectType.SecretManager,
      projectId
    });

    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionHoneyTokenActions.Edit, ProjectPermissionSub.HoneyTokens);

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
      ) as { accessKeyId: string; secretAccessKey: string; iamUserName: string };

      const { encryptor: secretEncryptor } = await kmsService.createCipherPairWithDataKey({
        type: KmsDataKey.SecretManager,
        projectId
      });

      const secretEntries = [
        { key: secretsMapping.accessKeyId, value: decryptedCredentials.accessKeyId },
        { key: secretsMapping.secretAccessKey, value: decryptedCredentials.secretAccessKey }
      ];

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
    const plan = await licenseService.getPlan(actor.orgId);

    if (!plan.honeyTokens) {
      throw new BadRequestError({
        message: "Failed to revoke honey token due to plan restriction. Upgrade plan to use honey tokens."
      });
    }

    const { permission } = await permissionService.getProjectPermission({
      actor: actor.type,
      actorId: actor.id,
      actorAuthMethod: actor.authMethod,
      actorOrgId: actor.orgId,
      actionProjectType: ActionProjectType.SecretManager,
      projectId
    });

    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionHoneyTokenActions.Delete,
      ProjectPermissionSub.HoneyTokens
    );

    const honeyToken = await honeyTokenDAL.findById(honeyTokenId);

    if (!honeyToken || honeyToken.projectId !== projectId) {
      throw new NotFoundError({ message: `Honey token with ID "${honeyTokenId}" not found` });
    }

    if (honeyToken.status === HoneyTokenStatus.Revoked) {
      throw new BadRequestError({ message: "Honey token is already revoked" });
    }

    const { decryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId: actor.orgId
    });

    const decryptedCredentials = JSON.parse(
      decryptor({ cipherTextBlob: honeyToken.encryptedCredentials }).toString()
    ) as { accessKeyId: string; secretAccessKey: string; iamUserName: string };

    const appConnection = await appConnectionDAL.findById(honeyToken.connectionId);

    if (appConnection) {
      const decryptedConnection = await decryptAppConnection(appConnection, kmsService);
      const awsConfig = decryptedConnection as unknown as TAwsConnectionConfig;
      const { credentials: awsCredentials, region } = await getAwsConnectionConfig(awsConfig);
      const iam = new IAMClient({ credentials: awsCredentials, region });

      try {
        await iam.send(
          new DeleteAccessKeyCommand({
            UserName: decryptedCredentials.iamUserName,
            AccessKeyId: decryptedCredentials.accessKeyId
          })
        );
      } catch {
        // Access key may already be deleted
      }

      try {
        await iam.send(new DeleteUserCommand({ UserName: decryptedCredentials.iamUserName }));
      } catch {
        // IAM user may already be deleted
      }
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
    const { permission } = await permissionService.getProjectPermission({
      actor: actor.type,
      actorId: actor.id,
      actorAuthMethod: actor.authMethod,
      actorOrgId: actor.orgId,
      actionProjectType: ActionProjectType.SecretManager,
      projectId
    });

    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionHoneyTokenActions.Edit, ProjectPermissionSub.HoneyTokens);

    const honeyToken = await honeyTokenDAL.findById(honeyTokenId);

    if (!honeyToken || honeyToken.projectId !== projectId) {
      throw new NotFoundError({ message: `Honey token with ID "${honeyTokenId}" not found` });
    }

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
    await permissionService.getProjectPermission({
      actor: actor.type,
      actorId: actor.id,
      actorAuthMethod: actor.authMethod,
      actorOrgId: actor.orgId,
      actionProjectType: ActionProjectType.SecretManager,
      projectId
    });

    const folders = await folderDAL.findBySecretPathMultiEnv(projectId, environments, secretPath);
    if (!folders.length) return 0;

    const folderIds = folders.map((f) => f.id);
    return honeyTokenDAL.countByFolderIds(folderIds, search);
  };

  const getOrgHoneyTokenLimit = async ({ projectId }: { projectId: string }, actor: OrgServiceActor) => {
    const { permission } = await permissionService.getProjectPermission({
      actor: actor.type,
      actorId: actor.id,
      actorAuthMethod: actor.authMethod,
      actorOrgId: actor.orgId,
      actionProjectType: ActionProjectType.SecretManager,
      projectId
    });

    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionHoneyTokenActions.Create,
      ProjectPermissionSub.HoneyTokens
    );

    const plan = await licenseService.getPlan(actor.orgId);
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
    await permissionService.getProjectPermission({
      actor: actor.type,
      actorId: actor.id,
      actorAuthMethod: actor.authMethod,
      actorOrgId: actor.orgId,
      actionProjectType: ActionProjectType.SecretManager,
      projectId
    });

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

  const getCredentials = async (
    { honeyTokenId, projectId }: { honeyTokenId: string; projectId: string },
    actor: OrgServiceActor
  ): Promise<{ credentials: TAwsHoneyTokenCredentials }> => {
    const { permission } = await permissionService.getProjectPermission({
      actor: actor.type,
      actorId: actor.id,
      actorAuthMethod: actor.authMethod,
      actorOrgId: actor.orgId,
      actionProjectType: ActionProjectType.SecretManager,
      projectId
    });

    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionHoneyTokenActions.Read, ProjectPermissionSub.HoneyTokens);

    const honeyToken = await honeyTokenDAL.findById(honeyTokenId);

    if (!honeyToken || honeyToken.projectId !== projectId) {
      throw new NotFoundError({ message: `Honey token with ID "${honeyTokenId}" not found` });
    }

    const { decryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId: actor.orgId
    });

    const decryptedCredentials = parseAwsHoneyTokenDecryptedCredentials(
      JSON.parse(decryptor({ cipherTextBlob: honeyToken.encryptedCredentials }).toString()) as unknown
    );

    return {
      credentials: {
        accessKeyId: decryptedCredentials.accessKeyId,
        secretAccessKey: decryptedCredentials.secretAccessKey
      }
    };
  };

  const getHoneyTokenById = async (
    { honeyTokenId, projectId }: { honeyTokenId: string; projectId: string },
    actor: OrgServiceActor
  ) => {
    const { permission } = await permissionService.getProjectPermission({
      actor: actor.type,
      actorId: actor.id,
      actorAuthMethod: actor.authMethod,
      actorOrgId: actor.orgId,
      actionProjectType: ActionProjectType.SecretManager,
      projectId
    });

    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionHoneyTokenActions.Read, ProjectPermissionSub.HoneyTokens);

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
    const { permission } = await permissionService.getProjectPermission({
      actor: actor.type,
      actorId: actor.id,
      actorAuthMethod: actor.authMethod,
      actorOrgId: actor.orgId,
      actionProjectType: ActionProjectType.SecretManager,
      projectId
    });

    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionHoneyTokenActions.Read, ProjectPermissionSub.HoneyTokens);

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
