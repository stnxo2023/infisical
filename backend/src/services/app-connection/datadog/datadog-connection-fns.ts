import { AxiosError } from "axios";

import { request } from "@app/lib/config/request";
import { BadRequestError } from "@app/lib/errors";
import { removeTrailingSlash } from "@app/lib/fn";
import { blockLocalAndPrivateIpAddresses } from "@app/lib/validator";

import { AppConnection } from "../app-connection-enums";
import { DatadogConnectionMethod } from "./datadog-connection-enums";
import { TDatadogConnectionConfig } from "./datadog-connection-types";

const DATADOG_ALLOWED_DOMAINS = ["datadoghq", "ddog-gov"];

export const getDatadogBaseUrl = async (config: TDatadogConnectionConfig) => {
  const rawUrl = removeTrailingSlash(config.credentials.url);

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError({ message: "Invalid Datadog URL" });
  }

  const labels = parsed.hostname.split(".");
  const secondLevelLabel = labels[labels.length - 2];
  if (!secondLevelLabel || !DATADOG_ALLOWED_DOMAINS.includes(secondLevelLabel)) {
    throw new BadRequestError({
      message: "Datadog URL must be a datadoghq.* or ddog-gov.* domain"
    });
  }

  await blockLocalAndPrivateIpAddresses(rawUrl);

  return rawUrl;
};

export const getDatadogConnectionListItem = () => {
  return {
    name: "Datadog" as const,
    app: AppConnection.Datadog as const,
    methods: Object.values(DatadogConnectionMethod) as [DatadogConnectionMethod.ApiKey]
  };
};

export const validateDatadogConnectionCredentials = async (config: TDatadogConnectionConfig) => {
  const baseUrl = await getDatadogBaseUrl(config);
  const { apiKey, applicationKey } = config.credentials;

  try {
    await request.get(`${baseUrl}/api/v2/permissions`, {
      headers: {
        "DD-API-KEY": apiKey,
        "DD-APPLICATION-KEY": applicationKey,
        Accept: "application/json"
      }
    });
  } catch (error: unknown) {
    if (error instanceof AxiosError) {
      throw new BadRequestError({
        message: `Failed to validate Datadog credentials: ${error.message || "Unknown error"}`
      });
    }

    throw new BadRequestError({
      message: "Failed to validate Datadog credentials - verify URL, API key and Application key are correct"
    });
  }

  return config.credentials;
};
