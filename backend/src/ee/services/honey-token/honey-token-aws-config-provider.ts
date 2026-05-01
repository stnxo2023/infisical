import { crypto } from "@app/lib/crypto/cryptography";

import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { ForbiddenError } from "@casl/ability";

import { OrganizationActionScope } from "@app/db/schemas";
import { BadRequestError } from "@app/lib/errors";
import { logger } from "@app/lib/logger";
import { OrgServiceActor } from "@app/lib/types";
import { TAppConnectionDALFactory } from "@app/services/app-connection/app-connection-dal";
import { decryptAppConnection } from "@app/services/app-connection/app-connection-fns";
import { getAwsConnectionConfig } from "@app/services/app-connection/aws";
import { AwsConnectionSchema } from "@app/services/app-connection/aws/aws-connection-schemas";
import { TAwsConnectionConfig } from "@app/services/app-connection/aws/aws-connection-types";
import { TKmsServiceFactory } from "@app/services/kms/kms-service";
import { KmsDataKey } from "@app/services/kms/kms-types";

import { TLicenseServiceFactory } from "../license/license-service";
import { OrgPermissionActions, OrgPermissionSubjects } from "../permission/org-permission";
import { TPermissionServiceFactory } from "../permission/permission-service-types";
import { THoneyTokenConfigDALFactory } from "./honey-token-config-dal";
import { HoneyTokenType } from "./honey-token-enums";
import { AwsHoneyTokenConfigSchema } from "./honey-token-types";

const CF_COMPLETE_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"]);

export interface THoneyTokenConfigRecord {
  id: string;
  orgId: string;
  type: string;
  connectionId: string;
  createdAt: Date;
  updatedAt: Date;
  encryptedConfig?: Buffer | null;
}

export interface THoneyTokenConfigWithDecrypted {
  id: string | null;
  orgId: string;
  type: string;
  connectionId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  decryptedConfig: { webhookSigningKey: string; stackName: string; awsRegion: string } | null;
}

type TProviderDep = {
  honeyTokenConfigDAL: THoneyTokenConfigDALFactory;
  permissionService: Pick<TPermissionServiceFactory, "getOrgPermission">;
  kmsService: Pick<TKmsServiceFactory, "createCipherPairWithDataKey">;
  licenseService: Pick<TLicenseServiceFactory, "getPlan">;
  appConnectionDAL: Pick<TAppConnectionDALFactory, "findById">;
};

const parseAwsConnectionConfig = (decryptedConnection: unknown): TAwsConnectionConfig => {
  const parsedConnection = AwsConnectionSchema.safeParse(decryptedConnection);
  if (!parsedConnection.success) {
    throw new BadRequestError({
      message: "Invalid AWS App Connection configuration"
    });
  }

  return parsedConnection.data as TAwsConnectionConfig;
};

export const honeyTokenAwsConfigProviderFactory = ({
  honeyTokenConfigDAL,
  permissionService,
  kmsService,
  licenseService,
  appConnectionDAL
}: TProviderDep) => {
  const verifyStackDeployment = async ({
    connectionId: connId,
    stackName,
    awsRegion
  }: {
    connectionId: string;
    stackName: string;
    awsRegion: string;
  }): Promise<{ deployed: boolean; status: string | null }> => {
    try {
      const appConnection = await appConnectionDAL.findById(connId);
      if (!appConnection) {
        return { deployed: false, status: null };
      }

      const decryptedConnection = await decryptAppConnection(appConnection, kmsService);
      const awsConfig = parseAwsConnectionConfig(decryptedConnection);
      const { credentials: awsCredentials } = await getAwsConnectionConfig(awsConfig);

      const cfn = new CloudFormationClient({ credentials: awsCredentials, region: awsRegion });
      const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const stack = res.Stacks?.[0];
      if (!stack) {
        return { deployed: false, status: null };
      }

      return {
        deployed: CF_COMPLETE_STATUSES.has(stack.StackStatus ?? ""),
        status: stack.StackStatus ?? null
      };
    } catch (err) {
      const awsCode = (err as { code?: string }).code;
      if (awsCode === "AccessDenied" || awsCode === "ExpiredToken" || awsCode === "InvalidClientTokenId") {
        throw new BadRequestError({
          message:
            "The AWS App Connection does not have permission to describe CloudFormation stacks. Ensure the connection's IAM role or credentials include the cloudformation:DescribeStacks permission."
        });
      }
      if (awsCode === "ValidationError") return { deployed: false, status: null };
      logger.warn(
        { err, connectionId: connId, stackName, awsRegion },
        `Failed to verify CloudFormation stack [stackName=${stackName}] [awsRegion=${awsRegion}]`
      );
      return { deployed: false, status: null };
    }
  };

  const upsertConfig = async ({
    orgPermission,
    connectionId,
    config
  }: {
    orgPermission: OrgServiceActor;
    connectionId: string;
    config: { webhookSigningKey: string; stackName?: string; awsRegion?: string };
  }): Promise<THoneyTokenConfigRecord> => {
    const { permission } = await permissionService.getOrgPermission({
      scope: OrganizationActionScope.Any,
      actor: orgPermission.type,
      actorId: orgPermission.id,
      orgId: orgPermission.orgId,
      actorAuthMethod: orgPermission.authMethod,
      actorOrgId: orgPermission.orgId
    });
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Edit, OrgPermissionSubjects.Settings);

    const plan = await licenseService.getPlan(orgPermission.orgId);
    if (!plan.honeyTokens) {
      throw new BadRequestError({
        message: "Failed to save honey token configuration due to plan restriction. Upgrade plan to use honey tokens."
      });
    }

    const validatedConfig = AwsHoneyTokenConfigSchema.parse(config);
    const { encryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId: orgPermission.orgId
    });
    const encryptedConfig = encryptor({
      plainText: Buffer.from(JSON.stringify(validatedConfig))
    }).cipherTextBlob;

    const existing = await honeyTokenConfigDAL.findOne({
      orgId: orgPermission.orgId,
      type: HoneyTokenType.AWS
    });
    if (existing) {
      return honeyTokenConfigDAL.updateById(existing.id, { connectionId, encryptedConfig });
    }
    return honeyTokenConfigDAL.create({
      orgId: orgPermission.orgId,
      type: HoneyTokenType.AWS,
      connectionId,
      encryptedConfig
    });
  };

  const testConnection = async ({ orgPermission }: { orgPermission: OrgServiceActor }) => {
    const { permission } = await permissionService.getOrgPermission({
      scope: OrganizationActionScope.Any,
      actor: orgPermission.type,
      actorId: orgPermission.id,
      orgId: orgPermission.orgId,
      actorAuthMethod: orgPermission.authMethod,
      actorOrgId: orgPermission.orgId
    });
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Read, OrgPermissionSubjects.Settings);

    const config = await honeyTokenConfigDAL.findOne({
      orgId: orgPermission.orgId,
      type: HoneyTokenType.AWS
    });
    if (!config?.encryptedConfig || !config.connectionId) {
      throw new BadRequestError({ message: "Honey token configuration not found. Save the configuration first." });
    }

    const { decryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId: orgPermission.orgId
    });
    const decrypted = decryptor({ cipherTextBlob: config.encryptedConfig });
    const storedConfig = AwsHoneyTokenConfigSchema.parse(JSON.parse(decrypted.toString()) as unknown);

    const stackDeployment = await verifyStackDeployment({
      connectionId: config.connectionId,
      stackName: storedConfig.stackName,
      awsRegion: storedConfig.awsRegion
    });
    return {
      isConnected: stackDeployment.deployed,
      status: stackDeployment.status,
      stackName: storedConfig.stackName
    };
  };

  const getConfig = async ({
    orgPermission
  }: {
    orgPermission: OrgServiceActor;
  }): Promise<THoneyTokenConfigWithDecrypted> => {
    const { permission } = await permissionService.getOrgPermission({
      scope: OrganizationActionScope.Any,
      actor: orgPermission.type,
      actorId: orgPermission.id,
      orgId: orgPermission.orgId,
      actorAuthMethod: orgPermission.authMethod,
      actorOrgId: orgPermission.orgId
    });
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Read, OrgPermissionSubjects.Settings);

    const config = await honeyTokenConfigDAL.findOne({
      orgId: orgPermission.orgId,
      type: HoneyTokenType.AWS
    });
    if (!config) {
      return {
        id: null,
        orgId: orgPermission.orgId,
        type: HoneyTokenType.AWS,
        connectionId: null,
        createdAt: null,
        updatedAt: null,
        decryptedConfig: {
          webhookSigningKey: `htk_live_${crypto.randomBytes(24).toString("hex")}`,
          stackName: "infisical-honey-tokens",
          awsRegion: "us-east-1"
        }
      };
    }

    const { decryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId: orgPermission.orgId
    });
    let decryptedConfig: { webhookSigningKey: string; stackName: string; awsRegion: string } | null = null;
    if (config.encryptedConfig) {
      const decrypted = decryptor({ cipherTextBlob: config.encryptedConfig });
      decryptedConfig = AwsHoneyTokenConfigSchema.parse(JSON.parse(decrypted.toString()) as unknown);
    }
    return { ...config, decryptedConfig };
  };

  return { upsertConfig, testConnection, getConfig };
};
