import { z } from "zod";

import { HoneyTokenConfigsSchema } from "@app/db/schemas";
import { HoneyTokenType } from "@app/ee/services/honey-token/honey-token-enums";
import { AwsHoneyTokenConfigSchema } from "@app/ee/services/honey-token/honey-token-types";
import { logger } from "@app/lib/logger";
import { readLimit, writeLimit } from "@app/server/config/rateLimiter";
import { slugSchema } from "@app/server/lib/schemas";
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
    url: "/",
    method: "POST",
    config: {
      rateLimit: writeLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      body: z.object({
        projectId: z.string().trim(),
        type: z.nativeEnum(HoneyTokenType),
        name: slugSchema({ field: "Name" }),
        description: z.string().trim().max(256).nullish(),
        secretsMapping: z.record(z.string(), z.string().min(1)),
        environment: z.string().trim(),
        secretPath: z.string().trim().min(1)
      }),
      response: {
        200: z.object({
          honeyToken: z.object({
            id: z.string().uuid(),
            name: z.string(),
            description: z.string().nullable().optional(),
            type: z.string(),
            status: z.string(),
            projectId: z.string(),
            secretsMapping: z.unknown(),
            createdAt: z.date(),
            updatedAt: z.date()
          })
        })
      }
    },
    handler: async (req) => {
      const { honeyToken } = await server.services.honeyTokenCrud.create(req.body, req.permission);
      return { honeyToken };
    }
  });

  server.route({
    url: "/:honeyTokenId",
    method: "PATCH",
    config: {
      rateLimit: writeLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      params: z.object({
        honeyTokenId: z.string().uuid()
      }),
      body: z.object({
        projectId: z.string().trim(),
        name: slugSchema({ field: "Name" }).optional(),
        description: z.string().trim().max(256).nullish(),
        secretsMapping: z.record(z.string(), z.string().min(1)).optional()
      }),
      response: {
        200: z.object({
          honeyToken: z.object({
            id: z.string().uuid(),
            name: z.string(),
            description: z.string().nullable().optional(),
            type: z.string(),
            status: z.string(),
            projectId: z.string(),
            secretsMapping: z.unknown(),
            createdAt: z.date(),
            updatedAt: z.date()
          })
        })
      }
    },
    handler: async (req) => {
      const { projectId, name, description, secretsMapping } = req.body;
      const { honeyToken } = await server.services.honeyTokenCrud.updateHoneyToken(
        {
          honeyTokenId: req.params.honeyTokenId,
          projectId,
          name,
          description,
          secretsMapping
        },
        req.permission
      );
      return { honeyToken };
    }
  });

  server.route({
    url: "/:honeyTokenId",
    method: "DELETE",
    config: {
      rateLimit: writeLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      params: z.object({
        honeyTokenId: z.string().uuid()
      }),
      body: z.object({
        projectId: z.string().trim()
      }),
      response: {
        200: z.object({
          honeyTokenId: z.string().uuid()
        })
      }
    },
    handler: async (req) => {
      const { honeyTokenId } = await server.services.honeyTokenCrud.deleteHoneyToken(
        {
          honeyTokenId: req.params.honeyTokenId,
          projectId: req.body.projectId
        },
        req.permission
      );
      return { honeyTokenId };
    }
  });

  server.route({
    url: "/:honeyTokenId/credentials",
    method: "GET",
    config: {
      rateLimit: readLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      params: z.object({
        honeyTokenId: z.string().uuid()
      }),
      querystring: z.object({
        projectId: z.string().trim()
      }),
      response: {
        200: z.object({
          credentials: z.record(z.string(), z.string())
        })
      }
    },
    handler: async (req) => {
      const { credentials } = await server.services.honeyTokenCrud.getCredentials(
        {
          honeyTokenId: req.params.honeyTokenId,
          projectId: req.query.projectId
        },
        req.permission
      );
      return { credentials };
    }
  });

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
      logger.info(
        { orgId: req.params.orgId, payload: req.body, headers: req.headers },
        `Honey token trigger received [orgId=${req.params.orgId}]`
      );

      const { acknowledged } = await server.services.honeyToken.handleTrigger({
        orgId: req.params.orgId,
        signature: req.headers["x-infisical-signature"] as string | undefined,
        payload: req.body
      });

      return { acknowledged };
    }
  });
};
