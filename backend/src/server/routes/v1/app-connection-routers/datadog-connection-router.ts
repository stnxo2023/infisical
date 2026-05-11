import { AppConnection } from "@app/services/app-connection/app-connection-enums";
import {
  CreateDatadogConnectionSchema,
  SanitizedDatadogConnectionSchema,
  UpdateDatadogConnectionSchema
} from "@app/services/app-connection/datadog";

import { registerAppConnectionEndpoints } from "./app-connection-endpoints";

export const registerDatadogConnectionRouter = async (server: FastifyZodProvider) => {
  registerAppConnectionEndpoints({
    app: AppConnection.Datadog,
    server,
    sanitizedResponseSchema: SanitizedDatadogConnectionSchema,
    createSchema: CreateDatadogConnectionSchema,
    updateSchema: UpdateDatadogConnectionSchema
  });
};
