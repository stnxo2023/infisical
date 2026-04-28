import crypto from "node:crypto";

import { ForbiddenError } from "@casl/ability";

import { OrganizationActionScope } from "@app/db/schemas";
import { BadRequestError, NotFoundError, UnauthorizedError } from "@app/lib/errors";
import { logger } from "@app/lib/logger";
import { OrgServiceActor } from "@app/lib/types";
import { TKmsServiceFactory } from "@app/services/kms/kms-service";
import { KmsDataKey } from "@app/services/kms/kms-types";

import { TLicenseServiceFactory } from "../license/license-service";
import { OrgPermissionActions, OrgPermissionSubjects } from "../permission/org-permission";
import { TPermissionServiceFactory } from "../permission/permission-service-types";
import { THoneyTokenConfigDALFactory } from "./honey-token-config-dal";
import { HoneyTokenType } from "./honey-token-enums";
import { AwsHoneyTokenConfigSchema } from "./honey-token-types";

type THoneyTokenConfigServiceFactoryDep = {
  honeyTokenConfigDAL: THoneyTokenConfigDALFactory;
  permissionService: Pick<TPermissionServiceFactory, "getOrgPermission">;
  kmsService: Pick<TKmsServiceFactory, "createCipherPairWithDataKey">;
  licenseService: Pick<TLicenseServiceFactory, "getPlan">;
};

export type THoneyTokenConfigServiceFactory = ReturnType<typeof honeyTokenConfigServiceFactory>;

export const honeyTokenConfigServiceFactory = ({
  honeyTokenConfigDAL,
  permissionService,
  kmsService,
  licenseService
}: THoneyTokenConfigServiceFactoryDep) => {
  const upsertConfig = async ({
    orgPermission,
    type,
    connectionId,
    config
  }: {
    orgPermission: OrgServiceActor;
    type: HoneyTokenType;
    connectionId: string;
    config: { webhookSigningKey: string };
  }) => {
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
      type
    });

    if (existing) {
      const updated = await honeyTokenConfigDAL.updateById(existing.id, {
        connectionId,
        encryptedConfig
      });
      return updated;
    }

    const created = await honeyTokenConfigDAL.create({
      orgId: orgPermission.orgId,
      type,
      connectionId,
      encryptedConfig
    });

    return created;
  };

  const getConfig = async ({ orgPermission, type }: { orgPermission: OrgServiceActor; type: HoneyTokenType }) => {
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
      type
    });

    if (!config) {
      const generatedKey = `htk_live_${crypto.randomBytes(24).toString("hex")}`;
      return {
        id: null,
        orgId: orgPermission.orgId,
        type,
        connectionId: null,
        createdAt: null,
        updatedAt: null,
        decryptedConfig: { webhookSigningKey: generatedKey }
      };
    }

    const { decryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId: orgPermission.orgId
    });

    let decryptedConfig: { webhookSigningKey: string } | null = null;
    if (config.encryptedConfig) {
      const decrypted = decryptor({
        cipherTextBlob: config.encryptedConfig
      });
      decryptedConfig = AwsHoneyTokenConfigSchema.parse(JSON.parse(decrypted.toString()) as unknown);
    }

    return {
      ...config,
      decryptedConfig
    };
  };

  const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

  const handleTrigger = async ({
    orgId,
    signature,
    payload
  }: {
    orgId: string;
    signature: string | undefined;
    payload: unknown;
  }) => {
    if (!signature) {
      throw new UnauthorizedError({ message: "Missing X-Infisical-Signature header" });
    }

    // Header format: t=<unix-seconds>,v1=<hmac-sha256-hex>
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

    const config = await honeyTokenConfigDAL.findOne({
      orgId,
      type: HoneyTokenType.AWS
    });

    if (!config?.encryptedConfig) {
      throw new NotFoundError({ message: "No honey token configuration found for this organization" });
    }

    const { decryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId
    });

    const decrypted = decryptor({ cipherTextBlob: config.encryptedConfig });
    const storedConfig = AwsHoneyTokenConfigSchema.parse(JSON.parse(decrypted.toString()) as unknown);

    const bodyString = JSON.stringify(payload);
    const signedPayload = `${timestamp}.${bodyString}`;
    const expectedSignature = crypto
      .createHmac("sha256", storedConfig.webhookSigningKey)
      .update(signedPayload)
      .digest("hex");

    const expectedBuf = Buffer.from(expectedSignature, "hex");
    const receivedBuf = Buffer.from(signatureHash, "hex");

    if (expectedBuf.byteLength !== receivedBuf.byteLength || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
      throw new UnauthorizedError({ message: "Invalid webhook signature" });
    }

    logger.info({ orgId, payload }, `Honey token trigger received [orgId=${orgId}]`);

    return { acknowledged: true };
  };

  return {
    upsertConfig,
    getConfig,
    handleTrigger
  };
};
