import { BadRequestError } from "@app/lib/errors";

import { HoneyTokenType } from "./honey-token-enums";
import { THoneyTokenProviderHooks } from "./honey-token-provider-hook-types";
import { HONEY_TOKEN_PROVIDER_DEFINITIONS, THoneyTokenProviderDefinition } from "./honey-token-provider-definitions";
import type { THoneyTokenConfigProvider, THoneyTokenConfigServiceFactoryDep } from "./honey-token-config-service";
import type { THoneyTokenServiceFactoryDep } from "./honey-token-service-types";

export const HONEY_TOKEN_PROVIDER_MAP: Record<HoneyTokenType, THoneyTokenProviderDefinition> =
  HONEY_TOKEN_PROVIDER_DEFINITIONS.reduce((acc, provider) => {
    acc[provider.type] = provider;
    return acc;
  }, {} as Record<HoneyTokenType, THoneyTokenProviderDefinition>);

export const HONEY_TOKEN_NAME_MAP: Record<HoneyTokenType, string> = HONEY_TOKEN_PROVIDER_DEFINITIONS.reduce(
  (acc, provider) => {
    acc[provider.type] = provider.name;
    return acc;
  },
  {} as Record<HoneyTokenType, string>
);

export const HONEY_TOKEN_CONNECTION_MAP = HONEY_TOKEN_PROVIDER_DEFINITIONS.reduce((acc, provider) => {
  acc[provider.type] = provider.connectionApp;
  return acc;
}, {} as Record<HoneyTokenType, THoneyTokenProviderDefinition["connectionApp"]>);

export const HONEY_TOKEN_CONFIG_SCHEMA_MAP = HONEY_TOKEN_PROVIDER_DEFINITIONS.reduce((acc, provider) => {
  acc[provider.type] = provider.configSchema;
  return acc;
}, {} as Record<HoneyTokenType, THoneyTokenProviderDefinition["configSchema"]>);

export const HONEY_TOKEN_CREDENTIALS_RESPONSE_SCHEMA_MAP = HONEY_TOKEN_PROVIDER_DEFINITIONS.reduce((acc, provider) => {
  acc[provider.type] = provider.credentialsResponseSchema;
  return acc;
}, {} as Record<HoneyTokenType, THoneyTokenProviderDefinition["credentialsResponseSchema"]>);

export const HONEY_TOKEN_REGISTER_ROUTER_MAP = HONEY_TOKEN_PROVIDER_DEFINITIONS.reduce((acc, provider) => {
  if (provider.registerRouter) {
    acc[provider.type] = provider.registerRouter;
  }
  return acc;
}, {} as Partial<Record<HoneyTokenType, (server: FastifyZodProvider) => Promise<void>>>);

export const getHoneyTokenProviderDefinition = (type: string) => {
  const provider = HONEY_TOKEN_PROVIDER_MAP[type as HoneyTokenType];
  if (!provider) {
    throw new BadRequestError({ message: "Unsupported honey token type" });
  }
  return provider;
};

export const getHoneyTokenServiceHooksByType = (
  deps: THoneyTokenServiceFactoryDep
): Record<HoneyTokenType, THoneyTokenProviderHooks> =>
  HONEY_TOKEN_PROVIDER_DEFINITIONS.reduce((acc, provider) => {
    acc[provider.type] = provider.serviceHooksFactory(deps);
    return acc;
  }, {} as Record<HoneyTokenType, THoneyTokenProviderHooks>);

export const getHoneyTokenConfigProvidersByType = (
  deps: THoneyTokenConfigServiceFactoryDep
): { [K in HoneyTokenType]: THoneyTokenConfigProvider<K> } =>
  HONEY_TOKEN_PROVIDER_DEFINITIONS.reduce((acc, provider) => {
    acc[provider.type] = provider.configProviderFactory(deps);
    return acc;
  }, {} as { [K in HoneyTokenType]: THoneyTokenConfigProvider<K> });
