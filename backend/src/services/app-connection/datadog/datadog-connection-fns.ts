import { AxiosError } from "axios";

import { request } from "@app/lib/config/request";
import { BadRequestError } from "@app/lib/errors";
import { removeTrailingSlash } from "@app/lib/fn";
import { blockLocalAndPrivateIpAddresses } from "@app/lib/validator";

import { AppConnection } from "../app-connection-enums";
import { DatadogConnectionMethod } from "./datadog-connection-enums";
import { TDatadogConnection, TDatadogConnectionConfig, TDatadogServiceAccount } from "./datadog-connection-types";

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

type TDatadogServiceAccountResponse = {
  data: Array<{
    id: string;
    type: string;
    attributes?: {
      name?: string | null;
      email?: string | null;
      handle?: string | null;
      disabled?: boolean;
    };
  }>;
};

export const listDatadogServiceAccounts = async (connection: TDatadogConnection): Promise<TDatadogServiceAccount[]> => {
  const baseUrl = await getDatadogBaseUrl(connection);

  try {
    const { data } = await request.get<TDatadogServiceAccountResponse>(`${baseUrl}/api/v2/users`, {
      params: {
        "filter[service_account]": "true",
        "page[size]": 100
      },
      headers: getDatadogAuthHeaders(connection.credentials)
    });

    return (data.data ?? [])
      .filter((entry) => !entry.attributes?.disabled)
      .map((entry) => ({
        id: entry.id,
        name: entry.attributes?.name || entry.attributes?.email || entry.attributes?.handle || entry.id
      }));
  } catch (error: unknown) {
    throw new BadRequestError({
      message: `Failed to list Datadog service accounts: ${getDatadogErrorMessage(error)}`
    });
  }
};
