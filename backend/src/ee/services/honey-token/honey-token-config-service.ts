import { BadRequestError, NotFoundError } from "@app/lib/errors";
import { OrgServiceActor } from "@app/lib/types";
import { TAppConnectionDALFactory } from "@app/services/app-connection/app-connection-dal";
import { TKmsServiceFactory } from "@app/services/kms/kms-service";
import { TOrgDALFactory } from "@app/services/org/org-dal";
import { TProjectDALFactory } from "@app/services/project/project-dal";
import { TSmtpService } from "@app/services/smtp/smtp-service";

import { TLicenseServiceFactory } from "../license/license-service";
import { TPermissionServiceFactory } from "../permission/permission-service-types";
import {
  THoneyTokenConfigRecord,
  THoneyTokenConfigWithDecrypted
} from "./honey-token-aws-config-provider";
import { THoneyTokenConfigDALFactory } from "./honey-token-config-dal";
import { THoneyTokenDALFactory } from "./honey-token-dal";
import { HoneyTokenType } from "./honey-token-enums";
import { THoneyTokenEventDALFactory } from "./honey-token-event-dal";
import { THoneyTokenConfigByType, THoneyTokenTestConnectionResponseByType } from "./honey-token-provider-types";
import {
  getHoneyTokenConfigProvidersByType,
  getHoneyTokenProviderDefinition,
  HONEY_TOKEN_PROVIDER_MAP
} from "./honey-token-provider-registry";

export type THoneyTokenConfigServiceFactoryDep = {
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

export type THoneyTokenConfigServiceFactory = ReturnType<typeof honeyTokenConfigServiceFactory>;
export type THoneyTokenConfigProvider<T extends HoneyTokenType = HoneyTokenType> = {
  upsertConfig: (input: {
    orgPermission: OrgServiceActor;
    connectionId: string;
    config: THoneyTokenConfigByType[T];
  }) => Promise<THoneyTokenConfigRecord>;
  testConnection: (input: { orgPermission: OrgServiceActor }) => Promise<THoneyTokenTestConnectionResponseByType[T]>;
  getConfig: (input: { orgPermission: OrgServiceActor }) => Promise<THoneyTokenConfigWithDecrypted>;
  handleTrigger: (input: {
    orgId: string;
    signature: string | undefined;
    payload: unknown;
  }) => Promise<{ acknowledged: boolean }>;
};

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

export const honeyTokenConfigServiceFactory = (deps: THoneyTokenConfigServiceFactoryDep) => {
  const honeyTokenConfigProviderByType = getHoneyTokenConfigProvidersByType(deps);

  const upsertConfig = async ({
    orgPermission,
    type,
    connectionId,
    config
  }: {
    orgPermission: OrgServiceActor;
    type: HoneyTokenType;
    connectionId: string;
    config: THoneyTokenConfigByType[HoneyTokenType];
  }) => {
    const providerType = assertSupportedHoneyTokenType(type);
    const provider = honeyTokenConfigProviderByType[providerType];
    if (!provider) {
      throw new BadRequestError({ message: "Unsupported honey token type" });
    }
    const appConnection = await deps.appConnectionDAL.findById(connectionId);
    if (!appConnection) {
      throw new NotFoundError({ message: `Could not find App Connection with ID ${connectionId}` });
    }

    assertHoneyTokenConnectionType(providerType, appConnection.app);
    return provider.upsertConfig({ orgPermission, connectionId, config });
  };

  const testConnection = async <T extends HoneyTokenType>({
    orgPermission,
    type
  }: {
    orgPermission: OrgServiceActor;
    type: T;
  }): Promise<THoneyTokenTestConnectionResponseByType[T]> => {
    const providerType = assertSupportedHoneyTokenType(type);
    const provider = honeyTokenConfigProviderByType[providerType];
    if (!provider) {
      throw new BadRequestError({ message: "Unsupported honey token type" });
    }
    return provider.testConnection({ orgPermission });
  };

  const getConfig = async ({ orgPermission, type }: { orgPermission: OrgServiceActor; type: HoneyTokenType }) => {
    const providerType = assertSupportedHoneyTokenType(type);
    const provider = honeyTokenConfigProviderByType[providerType];
    if (!provider) {
      throw new BadRequestError({ message: "Unsupported honey token type" });
    }
    return provider.getConfig({ orgPermission });
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
    const provider = honeyTokenConfigProviderByType[providerType];
    if (!provider) {
      throw new BadRequestError({ message: "Unsupported honey token type" });
    }
    return provider.handleTrigger({ orgId, signature, payload });
  };

  return {
    upsertConfig,
    testConnection,
    getConfig,
    handleTrigger
  };
};
