import { ForbiddenError } from "@casl/ability";

import { OrganizationActionScope } from "@app/db/schemas";
import { BadRequestError, NotFoundError } from "@app/lib/errors";

import { HoneyTokenType } from "../honey-token/honey-token-enums";
import {
  getHoneyTokenConfigProvidersByType,
  getHoneyTokenProviderDefinition,
  HONEY_TOKEN_PROVIDER_MAP
} from "../honey-token/honey-token-provider-fns";
import { THoneyTokenTestConnectionResponseByType } from "../honey-token/honey-token-provider-types";
import { OrgPermissionHoneyTokenActions, OrgPermissionSubjects } from "../permission/org-permission";
import {
  THoneyTokenConfigServiceFactoryDep,
  THoneyTokenConfigServiceTypeInput,
  THoneyTokenConfigServiceUpsertInput
} from "./honey-token-config-types";

export type THoneyTokenConfigServiceFactory = ReturnType<typeof honeyTokenConfigServiceFactory>;

const assertSupportedHoneyTokenType = (type: string): HoneyTokenType => {
  if (Object.hasOwn(HONEY_TOKEN_PROVIDER_MAP, type)) {
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

  const upsertConfig = async <T extends HoneyTokenType>({
    orgPermission,
    type,
    connectionId,
    config
  }: THoneyTokenConfigServiceUpsertInput<T>) => {
    const { permission } = await deps.permissionService.getOrgPermission({
      scope: OrganizationActionScope.Any,
      actor: orgPermission.type,
      actorId: orgPermission.id,
      orgId: orgPermission.orgId,
      actorAuthMethod: orgPermission.authMethod,
      actorOrgId: orgPermission.orgId
    });
    ForbiddenError.from(permission).throwUnlessCan(
      OrgPermissionHoneyTokenActions.Setup,
      OrgPermissionSubjects.HoneyTokens
    );

    const providerType = assertSupportedHoneyTokenType(type);
    const provider = honeyTokenConfigProviderByType[providerType];
    if (!provider) {
      throw new BadRequestError({ message: "Unsupported honey token type" });
    }
    const appConnection = await deps.appConnectionDAL.findById(connectionId);
    if (!appConnection || appConnection.orgId !== orgPermission.orgId) {
      throw new NotFoundError({ message: `Could not find App Connection with ID ${connectionId}` });
    }

    assertHoneyTokenConnectionType(providerType, appConnection.app);
    return provider.upsertConfig({ orgId: orgPermission.orgId, connectionId, config });
  };

  const testConnection = async <T extends HoneyTokenType>({
    orgPermission,
    type
  }: THoneyTokenConfigServiceTypeInput<T>): Promise<THoneyTokenTestConnectionResponseByType[T]> => {
    const { permission } = await deps.permissionService.getOrgPermission({
      scope: OrganizationActionScope.Any,
      actor: orgPermission.type,
      actorId: orgPermission.id,
      orgId: orgPermission.orgId,
      actorAuthMethod: orgPermission.authMethod,
      actorOrgId: orgPermission.orgId
    });
    ForbiddenError.from(permission).throwUnlessCan(
      OrgPermissionHoneyTokenActions.Setup,
      OrgPermissionSubjects.HoneyTokens
    );

    const providerType = assertSupportedHoneyTokenType(type);
    const provider = honeyTokenConfigProviderByType[providerType];
    if (!provider) {
      throw new BadRequestError({ message: "Unsupported honey token type" });
    }
    return provider.testConnection({ orgId: orgPermission.orgId });
  };

  const getConfig = async <T extends HoneyTokenType>({ orgPermission, type }: THoneyTokenConfigServiceTypeInput<T>) => {
    const { permission } = await deps.permissionService.getOrgPermission({
      scope: OrganizationActionScope.Any,
      actor: orgPermission.type,
      actorId: orgPermission.id,
      orgId: orgPermission.orgId,
      actorAuthMethod: orgPermission.authMethod,
      actorOrgId: orgPermission.orgId
    });
    ForbiddenError.from(permission).throwUnlessCan(
      OrgPermissionHoneyTokenActions.Setup,
      OrgPermissionSubjects.HoneyTokens
    );

    const providerType = assertSupportedHoneyTokenType(type);
    const provider = honeyTokenConfigProviderByType[providerType];
    if (!provider) {
      throw new BadRequestError({ message: "Unsupported honey token type" });
    }
    return provider.getConfig({ orgId: orgPermission.orgId });
  };

  return {
    upsertConfig,
    testConnection,
    getConfig
  };
};
