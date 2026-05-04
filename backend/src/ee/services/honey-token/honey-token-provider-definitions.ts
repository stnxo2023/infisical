import { z } from "zod";

import { registerAwsHoneyTokenRouter } from "@app/ee/routes/v1/honey-token-routers/aws-honey-token-router";
import { AppConnection } from "@app/services/app-connection/app-connection-enums";

import { honeyTokenAwsConfigProviderFactory } from "./honey-token-aws-config-provider";
import { honeyTokenAwsProviderHooksFactory } from "./honey-token-aws-service";
import { AwsHoneyTokenCredentialsSchema } from "./honey-token-aws-types";
import type { THoneyTokenConfigProvider, THoneyTokenConfigServiceFactoryDep } from "./honey-token-config-service";
import { HoneyTokenType } from "./honey-token-enums";
import { THoneyTokenProviderHooks } from "./honey-token-provider-hook-types";
import { THoneyTokenConfigByType, THoneyTokenDisplayCredentialsByType } from "./honey-token-provider-types";
import type { THoneyTokenServiceFactoryDep } from "./honey-token-service-types";
import { AwsHoneyTokenConfigSchema } from "./honey-token-types";

export type THoneyTokenProviderDefinition<T extends HoneyTokenType = HoneyTokenType> = {
  type: T;
  name: string;
  connectionApp: AppConnection;
  configSchema: z.ZodType<THoneyTokenConfigByType[T], z.ZodTypeDef, unknown>;
  credentialsResponseSchema: z.ZodType<{
    type: T;
    credentials: THoneyTokenDisplayCredentialsByType[T];
  }>;
  serviceHooksFactory: (deps: THoneyTokenServiceFactoryDep) => THoneyTokenProviderHooks;
  configProviderFactory: (deps: THoneyTokenConfigServiceFactoryDep) => THoneyTokenConfigProvider<T>;
  registerRouter?: (server: FastifyZodProvider) => Promise<void>;
};

export const HONEY_TOKEN_PROVIDER_DEFINITIONS: THoneyTokenProviderDefinition[] = [
  {
    type: HoneyTokenType.AWS,
    name: "AWS",
    connectionApp: AppConnection.AWS,
    configSchema: AwsHoneyTokenConfigSchema,
    credentialsResponseSchema: z.object({
      type: z.literal(HoneyTokenType.AWS),
      credentials: AwsHoneyTokenCredentialsSchema
    }),
    serviceHooksFactory: ({ kmsService, appConnectionDAL }) =>
      honeyTokenAwsProviderHooksFactory({ kmsService, appConnectionDAL }),
    configProviderFactory: (deps) => honeyTokenAwsConfigProviderFactory(deps),
    registerRouter: registerAwsHoneyTokenRouter
  }
];
