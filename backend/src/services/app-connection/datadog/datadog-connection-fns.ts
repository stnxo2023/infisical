import { AxiosError } from "axios";

import { request } from "@app/lib/config/request";
import { BadRequestError } from "@app/lib/errors";
import { removeTrailingSlash } from "@app/lib/fn";
import { logger } from "@app/lib/logger/logger";
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

export const getDatadogAuthHeaders = (credentials: { apiKey: string; applicationKey: string }) => ({
  "DD-API-KEY": credentials.apiKey,
  "DD-APPLICATION-KEY": credentials.applicationKey,
  Accept: "application/json"
});

type TDatadogJsonApiError = { detail?: string; title?: string; status?: string };

// Datadog v2 errors use JSON:API shape: { errors: [{ detail, title, status }] }.
// Surface the most actionable field; fall back to axios error.message.
export const getDatadogErrorMessage = (error: unknown): string => {
  if (error instanceof AxiosError) {
    const errors = (error.response?.data as { errors?: TDatadogJsonApiError[] } | undefined)?.errors;
    const first = errors?.[0];
    if (first?.detail) return first.detail;
    if (first?.title) return first.title;
    if (error.message) return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
};

export const validateDatadogConnectionCredentials = async (config: TDatadogConnectionConfig) => {
  const baseUrl = await getDatadogBaseUrl(config);

  try {
    await request.get(`${baseUrl}/api/v2/permissions`, { headers: getDatadogAuthHeaders(config.credentials) });
  } catch (error: unknown) {
    throw new BadRequestError({
      message: `Failed to validate Datadog credentials: ${getDatadogErrorMessage(error)}`
    });
  }

  return config.credentials;
};
