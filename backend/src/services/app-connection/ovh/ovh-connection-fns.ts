import { BadRequestError } from "@app/lib/errors";
import { safeRequest } from "@app/lib/validator";
import { AppConnection } from "@app/services/app-connection/app-connection-enums";

import { OVHConnectionMethod } from "./ovh-connection-enums";
import { TOvhConnectionConfig } from "./ovh-connection-types";

export const getOvhConnectionListItem = () => {
  return {
    name: "OVH" as const,
    app: AppConnection.OVH as const,
    methods: Object.values(OVHConnectionMethod) as [OVHConnectionMethod.Certificate]
  };
};

export const validateOvhConnectionCredentials = async (config: TOvhConnectionConfig) => {
  const { okmsDomain, okmsId, privateKey, certificate } = config.credentials;

  try {
    await safeRequest.get(`${okmsDomain}/api/${encodeURIComponent(okmsId)}/v1/servicekey`, {
      key: privateKey,
      cert: certificate,
      timeout: 15000,
      validateStatus: (status) => status === 200
    });
  } catch (err) {
    throw new BadRequestError({
      message: `Unable to validate OVH connection: ${err instanceof Error ? err.message : "unknown error"}`
    });
  }

  return config.credentials;
};
