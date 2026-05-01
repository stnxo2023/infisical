import crypto from "node:crypto";

import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { ForbiddenError } from "@casl/ability";

import { OrganizationActionScope, OrgMembershipRole } from "@app/db/schemas";
import { getConfig as getAppConfig } from "@app/lib/config/env";
import { BadRequestError, NotFoundError, UnauthorizedError } from "@app/lib/errors";
import { removeTrailingSlash } from "@app/lib/fn";
import { logger } from "@app/lib/logger";
import { OrgServiceActor } from "@app/lib/types";
import { TAppConnectionDALFactory } from "@app/services/app-connection/app-connection-dal";
import { decryptAppConnection } from "@app/services/app-connection/app-connection-fns";
import { getAwsConnectionConfig } from "@app/services/app-connection/aws";
import { AwsConnectionSchema } from "@app/services/app-connection/aws/aws-connection-schemas";
import { TAwsConnectionConfig } from "@app/services/app-connection/aws/aws-connection-types";
import { TKmsServiceFactory } from "@app/services/kms/kms-service";
import { KmsDataKey } from "@app/services/kms/kms-types";
import { TOrgDALFactory } from "@app/services/org/org-dal";
import { TProjectDALFactory } from "@app/services/project/project-dal";
import { SmtpTemplates, TSmtpService } from "@app/services/smtp/smtp-service";

import { TLicenseServiceFactory } from "../license/license-service";
import { OrgPermissionActions, OrgPermissionSubjects } from "../permission/org-permission";
import { TPermissionServiceFactory } from "../permission/permission-service-types";
import { THoneyTokenConfigDALFactory } from "./honey-token-config-dal";
import { THoneyTokenDALFactory } from "./honey-token-dal";
import { HoneyTokenEventType, HoneyTokenStatus, HoneyTokenType } from "./honey-token-enums";
import { THoneyTokenEventDALFactory } from "./honey-token-event-dal";
import {
  AwsHoneyTokenConfigSchema,
  AwsHoneyTokenEventMetadataSchema,
  TAwsHoneyTokenEventMetadata
} from "./honey-token-types";

const TRIGGER_NOTIFICATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const CF_COMPLETE_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"]);
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

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
  honeyTokenDAL: Pick<
    THoneyTokenDALFactory,
    "findOne" | "updateById" | "tryMarkTriggered" | "findOneByTokenIdentifierAndOrgId"
  >;
  honeyTokenEventDAL: Pick<THoneyTokenEventDALFactory, "create">;
  permissionService: Pick<TPermissionServiceFactory, "getOrgPermission">;
  kmsService: Pick<TKmsServiceFactory, "createCipherPairWithDataKey">;
  licenseService: Pick<TLicenseServiceFactory, "getPlan">;
  appConnectionDAL: Pick<TAppConnectionDALFactory, "findById">;
  orgDAL: Pick<TOrgDALFactory, "findOrgMembersByRole">;
  projectDAL: Pick<TProjectDALFactory, "findById">;
  smtpService: Pick<TSmtpService, "sendMail">;
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
  honeyTokenDAL,
  honeyTokenEventDAL,
  permissionService,
  kmsService,
  licenseService,
  appConnectionDAL,
  orgDAL,
  projectDAL,
  smtpService
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

  const sendTriggerNotification = async ({
    orgId,
    honeyToken,
    eventMetadata
  }: {
    orgId: string;
    honeyToken: { id: string; name: string; projectId: string };
    eventMetadata: TAwsHoneyTokenEventMetadata;
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
    orgId,
    signature,
    payload
  }: {
    orgId: string;
    signature: string | undefined;
    payload: unknown;
  }) => {
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
    const expectedSignature = crypto
      .createHmac("sha256", storedConfig.webhookSigningKey)
      .update(`${timestamp}.${bodyString}`)
      .digest("hex");
    const expectedBuf = Buffer.from(expectedSignature, "hex");
    const receivedBuf = Buffer.from(signatureHash, "hex");
    if (expectedBuf.byteLength !== receivedBuf.byteLength || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
      throw new UnauthorizedError({ message: "Invalid webhook signature" });
    }

    const rawEvents = Array.isArray(payload) ? (payload as unknown[]) : [payload];
    /* eslint-disable no-await-in-loop, no-continue */
    for (const rawEvent of rawEvents) {
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
    /* eslint-enable no-await-in-loop, no-continue */

    return { acknowledged: true };
  };

  return { upsertConfig, testConnection, getConfig, handleTrigger };
};
