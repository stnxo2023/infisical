import { z } from "zod";

import { HoneyTokenConfigsSchema } from "@app/db/schemas";
import { HoneyTokenType } from "@app/ee/services/honey-token/honey-token-enums";
import { AwsHoneyTokenConfigSchema } from "@app/ee/services/honey-token/honey-token-types";
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

export const registerHoneyTokenRouter = async (server: FastifyZodProvider) => {
  server.route({
    url: "/configs",
    method: "PUT",
    config: {
      rateLimit: writeLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      body: z.object({
        type: z.nativeEnum(HoneyTokenType),
        connectionId: z.string().uuid(),
        config: AwsHoneyTokenConfigSchema
      }),
      response: {
        200: z.object({
          config: SanitizedHoneyTokenConfigSchema
        })
      }
    },
    handler: async (req) => {
      const config = await server.services.honeyToken.upsertConfig({
        orgPermission: req.permission,
        type: req.body.type,
        connectionId: req.body.connectionId,
        config: req.body.config
      });

      return { config };
    }
  });

  server.route({
    url: "/configs/:type",
    method: "GET",
    config: {
      rateLimit: readLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      params: z.object({
        type: z.nativeEnum(HoneyTokenType)
      }),
      response: {
        200: z.object({
          config: SanitizedHoneyTokenConfigSchema.extend({
            id: z.string().nullable(),
            connectionId: z.string().nullable(),
            createdAt: z.date().nullable(),
            updatedAt: z.date().nullable(),
            decryptedConfig: z.object({ webhookSigningKey: z.string() }).nullable()
          })
        })
      }
    },
    handler: async (req) => {
      const config = await server.services.honeyToken.getConfig({
        orgPermission: req.permission,
        type: req.params.type
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
      const { acknowledged } = await server.services.honeyToken.handleTrigger({
        orgId: req.params.orgId,
        signature: req.headers["x-infisical-signature"] as string | undefined,
        payload: req.body
      });

      return { acknowledged };
    }
  });
};
