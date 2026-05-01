import { z } from "zod";

import { HoneyTokenConfigsSchema, HoneyTokensSchema } from "@app/db/schemas";
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

const HoneyTokenResponseSchema = HoneyTokensSchema.pick({
  id: true,
  name: true,
  description: true,
  type: true,
  status: true,
  projectId: true,
  secretsMapping: true,
  createdAt: true,
  updatedAt: true
});

const HoneyTokenDetailsResponseSchema = HoneyTokensSchema.pick({
  id: true,
  name: true,
  description: true,
  type: true,
  status: true,
  projectId: true,
  folderId: true,
  secretsMapping: true,
  createdAt: true,
  updatedAt: true
}).extend({
  environment: z
    .object({
      id: z.string(),
      name: z.string(),
      slug: z.string()
    })
    .nullable(),
  folder: z
    .object({
      path: z.string()
    })
    .nullable(),
  openEvents: z.number()
});

const HoneyTokenResetResponseSchema = HoneyTokensSchema.pick({
  id: true,
  status: true
}).extend({
  lastResetAt: z.date().nullable()
});

export const registerHoneyTokenRouter = async (server: FastifyZodProvider) => {
  server.route({
    url: "/limits",
    method: "GET",
    config: {
      rateLimit: readLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      querystring: z.object({
        projectId: z.string().trim()
      }),
      response: {
        200: z.object({
          used: z.number(),
          limit: z.number()
        })
      }
    },
    handler: async (req) => {
      return server.services.honeyToken.getOrgHoneyTokenLimit({ projectId: req.query.projectId }, req.permission);
    }
  });

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
          honeyToken: HoneyTokenResponseSchema,
          stackDeployment: z.object({
            deployed: z.boolean(),
            status: z.string().nullable()
          })
        })
      }
    },
    handler: async (req) => {
      const { honeyToken, stackDeployment } = await server.services.honeyToken.create(req.body, req.permission);
      return { honeyToken, stackDeployment };
    }
  });

  server.route({
    url: "/:id",
    method: "GET",
    config: {
      rateLimit: readLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      params: z.object({
        id: z.string().uuid()
      }),
      querystring: z.object({
        projectId: z.string().trim()
      }),
      response: {
        200: z.object({
          honeyToken: HoneyTokenDetailsResponseSchema
        })
      }
    },
    handler: async (req) => {
      const { honeyToken } = await server.services.honeyToken.getHoneyTokenById(
        {
          honeyTokenId: req.params.id,
          projectId: req.query.projectId
        },
        req.permission
      );
      return { honeyToken };
    }
  });

  server.route({
    url: "/:id",
    method: "PATCH",
    config: {
      rateLimit: writeLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      params: z.object({
        id: z.string().uuid()
      }),
      body: z.object({
        projectId: z.string().trim(),
        name: slugSchema({ field: "Name" }).optional(),
        description: z.string().trim().max(256).nullish(),
        secretsMapping: z.record(z.string(), z.string().min(1)).optional()
      }),
      response: {
        200: z.object({
          honeyToken: HoneyTokenResponseSchema
        })
      }
    },
    handler: async (req) => {
      const { projectId, name, description, secretsMapping } = req.body;
      const { honeyToken } = await server.services.honeyToken.updateHoneyToken(
        {
          honeyTokenId: req.params.id,
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
    url: "/:id/reset",
    method: "POST",
    config: {
      rateLimit: writeLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      params: z.object({
        id: z.string().uuid()
      }),
      body: z.object({
        projectId: z.string().trim()
      }),
      response: {
        200: z.object({
          honeyToken: HoneyTokenResetResponseSchema
        })
      }
    },
    handler: async (req) => {
      const { honeyToken } = await server.services.honeyToken.resetHoneyToken(
        {
          honeyTokenId: req.params.id,
          projectId: req.body.projectId
        },
        req.permission
      );
      return {
        honeyToken: {
          id: honeyToken.id,
          status: honeyToken.status,
          lastResetAt: honeyToken.lastResetAt ?? null
        }
      };
    }
  });

  server.route({
    url: "/:id/revoke",
    method: "POST",
    config: {
      rateLimit: writeLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      params: z.object({
        id: z.string().uuid()
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
      const { honeyTokenId } = await server.services.honeyToken.revokeHoneyToken(
        {
          honeyTokenId: req.params.id,
          projectId: req.body.projectId
        },
        req.permission
      );
      return { honeyTokenId };
    }
  });

  server.route({
    url: "/:id/credentials",
    method: "GET",
    config: {
      rateLimit: readLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      params: z.object({
        id: z.string().uuid()
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
      const { credentials } = await server.services.honeyToken.getCredentials(
        {
          honeyTokenId: req.params.id,
          projectId: req.query.projectId
        },
        req.permission
      );
      return { credentials };
    }
  });

  server.route({
    url: "/:id/events",
    method: "GET",
    config: {
      rateLimit: readLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      params: z.object({
        id: z.string().uuid()
      }),
      querystring: z.object({
        projectId: z.string().trim(),
        offset: z.coerce.number().min(0).default(0),
        limit: z.coerce.number().min(1).max(100).default(25)
      }),
      response: {
        200: z.object({
          events: z.array(
            z.object({
              id: z.string().uuid(),
              honeyTokenId: z.string().uuid(),
              eventType: z.string(),
              metadata: z.unknown().nullable().optional(),
              createdAt: z.date(),
              updatedAt: z.date()
            })
          ),
          totalCount: z.number()
        })
      }
    },
    handler: async (req) => {
      const { events, totalCount } = await server.services.honeyToken.getHoneyTokenEvents(
        {
          honeyTokenId: req.params.id,
          projectId: req.query.projectId,
          offset: req.query.offset,
          limit: req.query.limit
        },
        req.permission
      );
      return { events, totalCount };
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
      const config = await server.services.honeyTokenConfig.upsertConfig({
        orgPermission: req.permission,
        type: req.body.type,
        connectionId: req.body.connectionId,
        config: req.body.config
      });

      return { config };
    }
  });

  server.route({
    url: "/configs/:type/test-connection",
    method: "POST",
    config: {
      rateLimit: writeLimit
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      params: z.object({
        type: z.nativeEnum(HoneyTokenType)
      }),
      response: {
        200: z.object({
          isConnected: z.boolean(),
          status: z.string().nullable(),
          stackName: z.string()
        })
      }
    },
    handler: async (req) => {
      return server.services.honeyTokenConfig.testConnection({
        orgPermission: req.permission,
        type: req.params.type
      });
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
            decryptedConfig: z.object({ webhookSigningKey: z.string(), stackName: z.string() }).nullable()
          })
        })
      }
    },
    handler: async (req) => {
      const config = await server.services.honeyTokenConfig.getConfig({
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

      const { acknowledged } = await server.services.honeyTokenConfig.handleTrigger({
        orgId: req.params.orgId,
        signature: req.headers["x-infisical-signature"] as string | undefined,
        payload: req.body
      });

      return { acknowledged };
    }
  });
};
