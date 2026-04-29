import snowflake from "snowflake-sdk";

import { BadRequestError } from "@app/lib/errors";
import { sanitizeString } from "@app/lib/fn";
import { AppConnection } from "@app/services/app-connection/app-connection-enums";

import { SnowflakeConnectionMethod } from "./snowflake-connection-enums";
import { TSnowflakeConnectionConfig } from "./snowflake-connection-types";

const noop = () => {};

export const getSnowflakeConnectionListItem = () => {
  return {
    name: "Snowflake" as const,
    app: AppConnection.Snowflake as const,
    methods: Object.values(SnowflakeConnectionMethod) as [SnowflakeConnectionMethod.UsernameAndToken]
  };
};

export const validateSnowflakeConnectionCredentials = async (config: TSnowflakeConnectionConfig) => {
  const { account, username, password } = config.credentials;

  let client: snowflake.Connection | undefined;
  try {
    client = snowflake.createConnection({
      account,
      username,
      password,
      application: "Infisical"
    });

    await client.connectAsync(noop);

    await Promise.race([
      client.isValidAsync(),
      new Promise((resolve) => {
        setTimeout(resolve, 10000);
      }).then(() => {
        throw new BadRequestError({ message: "Unable to establish connection - verify credentials" });
      })
    ]);

    return config.credentials;
  } catch (err) {
    const sanitizedErrorMessage = sanitizeString({
      unsanitizedString: (err as Error)?.message,
      tokens: [password, username, account]
    });
    throw new BadRequestError({
      message: `Unable to validate connection: ${sanitizedErrorMessage || "verify credentials"}`
    });
  } finally {
    if (client) client.destroy(noop);
  }
};
