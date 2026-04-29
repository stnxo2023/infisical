import { AppConnection } from "@app/services/app-connection/app-connection-enums";
import {
  CreateSnowflakeConnectionSchema,
  SanitizedSnowflakeConnectionSchema,
  UpdateSnowflakeConnectionSchema
} from "@app/services/app-connection/snowflake";

import { registerAppConnectionEndpoints } from "./app-connection-endpoints";

export const registerSnowflakeConnectionRouter = async (server: FastifyZodProvider) => {
  registerAppConnectionEndpoints({
    app: AppConnection.Snowflake,
    server,
    sanitizedResponseSchema: SanitizedSnowflakeConnectionSchema,
    createSchema: CreateSnowflakeConnectionSchema,
    updateSchema: UpdateSnowflakeConnectionSchema
  });
};
