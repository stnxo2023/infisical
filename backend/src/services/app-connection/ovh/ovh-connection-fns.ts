import https from "https";

import { request } from "@app/lib/config/request";
import { BadRequestError } from "@app/lib/errors";
import { validateSsrfUrl } from "@app/lib/validator/validate-url";
import { AppConnection } from "@app/services/app-connection/app-connection-enums";

import { OVHConnectionMethod } from "./ovh-connection-enums";
import { TOvhConnectionConfig } from "./ovh-connection-types";

export const getOvhConnectionListItem = () => {
  return {
    name: "OVH" as const,
    app: AppConnection.OVH as const,
    methods: Object.values(OVHConnectionMethod) as [OVHConnectionMethod.Pkcs12Certificate]
  };
};

export const validateOvhConnectionCredentials = async (config: TOvhConnectionConfig) => {
  const { pkcs12Certificate, pkcs12Passphrase, okmsDomain, okmsId } = config.credentials;

  await validateSsrfUrl(okmsDomain);

  const httpsAgent = new https.Agent({
    pfx: Buffer.from(pkcs12Certificate, "base64"),
    passphrase: pkcs12Passphrase
  });

  try {
    await request.get(`${okmsDomain}/${encodeURIComponent(okmsId)}/v1/servicekey`, {
      httpsAgent,
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
