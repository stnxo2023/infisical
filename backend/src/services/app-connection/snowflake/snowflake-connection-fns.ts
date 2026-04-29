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

    await new Promise<void>((resolve, reject) => {
      client.connectAsync((err) => (err ? reject(err) : resolve())).catch(reject);
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    const isValid = await Promise.race<boolean>([
      client.isValidAsync(),
      new Promise<boolean>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new BadRequestError({ message: "Snowflake connection validation timed out" })),
          10000
        );
      })
    ]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });

    if (!isValid) {
      throw new BadRequestError({
        message:
          "Snowflake connection is not valid - heartbeat failed; verify credentials, network access, and that the account is not locked"
      });
    }

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
