import crypto from "node:crypto";

import { ForbiddenError } from "@casl/ability";

import { OrganizationActionScope } from "@app/db/schemas";
import { BadRequestError } from "@app/lib/errors";
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
    config: { secretToken: string };
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
      const generatedToken = `htk_live_${crypto.randomBytes(24).toString("hex")}`;
      return {
        id: null,
        orgId: orgPermission.orgId,
        type,
        connectionId: null,
        createdAt: null,
        updatedAt: null,
        decryptedConfig: { secretToken: generatedToken }
      };
    }

    const { decryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId: orgPermission.orgId
    });

    let decryptedConfig: { secretToken: string } | null = null;
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

  return {
    upsertConfig,
    getConfig
  };
};
