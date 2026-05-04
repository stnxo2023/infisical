import { z } from "zod";

import { HoneyTokenConfigsSchema } from "@app/db/schemas";
import { HoneyTokenType } from "@app/ee/services/honey-token/honey-token-enums";
import {
  THoneyTokenConfigByType,
  THoneyTokenTestConnectionResponseByType
} from "@app/ee/services/honey-token/honey-token-provider-types";
import { logger } from "@app/lib/logger";
import { readLimit, writeLimit } from "@app/server/config/rateLimiter";
import { verifyAuth } from "@app/server/plugins/auth/verify-auth";
import { AuthMode } from "@app/services/auth/auth-type";

const SanitizedHoneyTokenConfigSchema = HoneyTokenConfigsSchema.pick({
  id: true,
  orgId: true,
  type: true,
  connectionId: true,
  createdAt: true,
  updatedAt: true
});

export const registerHoneyTokenEndpoints = <TType extends HoneyTokenType>({
  server,
  type,
  configSchema,
  testConnectionResponseSchema,
  decryptedConfigSchema
}: {
  server: FastifyZodProvider;
  type: TType;
  configSchema: z.ZodType<THoneyTokenConfigByType[TType], z.ZodTypeDef, unknown>;
  testConnectionResponseSchema: z.ZodType<THoneyTokenTestConnectionResponseByType[TType], z.ZodTypeDef, unknown>;
  decryptedConfigSchema: z.ZodType<THoneyTokenConfigByType[TType], z.ZodTypeDef, unknown>;
}) => {
  const upsertBodySchema = z.object({
    connectionId: z.string().uuid(),
    config: configSchema
  });

  server.route({
    url: "/configs",
    method: "PUT",
    config: {
      rateLimit: writeLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      body: upsertBodySchema,
      response: {
        200: z.object({
          config: SanitizedHoneyTokenConfigSchema
        })
      }
    },
    handler: async (req) => {
      const { connectionId, config } = upsertBodySchema.parse(req.body);
      const parsedConfig = configSchema.parse(config);
      const savedConfig = await server.services.honeyTokenConfig.upsertConfig({
        orgPermission: req.permission,
        type,
        connectionId,
        config: parsedConfig
      });

      return { config: savedConfig };
    }
  });

  server.route({
    url: "/configs/test-connection",
    method: "POST",
    config: {
      rateLimit: writeLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      response: {
        200: testConnectionResponseSchema
      }
    },
    handler: async (req) => {
      return server.services.honeyTokenConfig.testConnection({
        orgPermission: req.permission,
        type
      });
    }
  });

  server.route({
    url: "/configs",
    method: "GET",
    config: {
      rateLimit: readLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      response: {
        200: z.object({
          config: SanitizedHoneyTokenConfigSchema.extend({
            id: z.string().nullable(),
            connectionId: z.string().nullable(),
            createdAt: z.date().nullable(),
            updatedAt: z.date().nullable(),
            decryptedConfig: decryptedConfigSchema.nullable()
          })
        })
      }
    },
    handler: async (req) => {
      const config = await server.services.honeyTokenConfig.getConfig({
        orgPermission: req.permission,
        type
      });

      return { config };
    }
  });

  server.route({
    url: "/:orgId/trigger",
    method: "POST",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      params: z.object({
        orgId: z.string().trim()
      }),
      body: z.unknown(),
      response: {
        200: z.object({
          acknowledged: z.boolean()
        })
      }
    },
    handler: async (req) => {
      logger.info(
        { orgId: req.params.orgId, payload: req.body, headers: req.headers, type },
        `Honey token trigger received [orgId=${req.params.orgId}] [type=${type}]`
      );

      const { acknowledged } = await server.services.honeyToken.handleTrigger({
        type,
        orgId: req.params.orgId,
        signature: req.headers["x-infisical-signature"] as string | undefined,
        payload: req.body
      });

      return { acknowledged };
    }
  });
};
