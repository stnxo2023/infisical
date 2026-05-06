import { isAxiosError } from "axios";

import { deepEqual } from "@app/lib/fn/object";
import { safeRequest } from "@app/lib/validator";
import { SecretSyncError } from "@app/services/secret-sync/secret-sync-errors";
import { matchesSchema } from "@app/services/secret-sync/secret-sync-fns";
import { TSecretMap } from "@app/services/secret-sync/secret-sync-types";

import { TOvhSyncWithCredentials } from "./ovh-sync-types";

const REQUEST_TIMEOUT_MS = 15_000;

const getSecretUrl = (okmsDomain: string, okmsId: string, path: string) =>
  `${okmsDomain}/api/${encodeURIComponent(okmsId)}/v2/secret/${encodeURIComponent(path)}`;

type TOvhErrorBody = {
  error_code?: number | string;
  errors?: string[];
  request_id?: string;
};

// Strip axios request config/headers out of the error before it bubbles up to
// logs or API responses. Keep only the HTTP status and OVH's own error fields.
const sanitizeOvhError = (error: unknown): Error => {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    const body = error.response?.data as TOvhErrorBody | undefined;
    const parts: string[] = [];
    if (status) parts.push(`HTTP ${status}`);
    if (body?.error_code !== undefined) parts.push(`code=${body.error_code}`);
    if (body?.errors?.length) parts.push(body.errors.join("; "));
    if (body?.request_id) parts.push(`requestId=${body.request_id}`);
    return new Error(`OVH OKMS request failed${parts.length ? `: ${parts.join(" ")}` : ""}`);
  }
  return new Error("OVH OKMS request failed");
};

// Shape of `GET /v2/secret/{path}?includeData=true` per OVH OKMS swagger.
type TOvhGetSecretResponse = {
  metadata?: { currentVersion?: number };
  version?: { data?: Record<string, unknown> };
};

type TOvhSecretRead = {
  exists: boolean;
  data: Record<string, string>;
  currentVersion: number | null;
};

const toStringRecord = (data: Record<string, unknown>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return result;
};

const readSecret = async (
  okmsDomain: string,
  okmsId: string,
  path: string,
  privateKey: string,
  certificate: string
): Promise<TOvhSecretRead> => {
  try {
    const { data } = await safeRequest.get<TOvhGetSecretResponse>(
      `${getSecretUrl(okmsDomain, okmsId, path)}?includeData=true`,
      {
        key: privateKey,
        cert: certificate,
        timeout: REQUEST_TIMEOUT_MS
      }
    );
    return {
      exists: true,
      data: toStringRecord(data?.version?.data ?? {}),
      currentVersion: data?.metadata?.currentVersion ?? null
    };
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 404) {
      return { exists: false, data: {}, currentVersion: null };
    }
    throw err;
  }
};

const createSecret = async (
  okmsDomain: string,
  okmsId: string,
  path: string,
  data: Record<string, string>,
  privateKey: string,
  certificate: string
) =>
  safeRequest.post(
    `${okmsDomain}/api/${encodeURIComponent(okmsId)}/v2/secret`,
    { path, version: { data } },
    {
      key: privateKey,
      cert: certificate,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        accept: "application/json"
      }
    }
  );

const updateSecret = async (
  okmsDomain: string,
  okmsId: string,
  path: string,
  data: Record<string, string>,
  cas: number | null,
  privateKey: string,
  certificate: string
) => {
  const base = getSecretUrl(okmsDomain, okmsId, path);
  const url = cas !== null ? `${base}?cas=${cas}` : base;
  return safeRequest.put(
    url,
    { version: { data } },
    {
      key: privateKey,
      cert: certificate,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        accept: "application/json"
      }
    }
  );
};

// OVH OKMS stores all keys of a path in a single versioned bundle; any change
// requires rewriting the whole bundle. Callers describe the desired bundle as
// a pure function of the existing bundle; this helper decides whether to skip,
// create, or CAS-update based on what's actually on the remote.
const writeSecretBundle = async (
  secretSync: TOvhSyncWithCredentials,
  buildDesiredBundle: (existing: Record<string, string>) => Record<string, string>
) => {
  const { connection, destinationConfig } = secretSync;
  const path = String(destinationConfig.path);
  const { okmsDomain, okmsId, privateKey, certificate } = connection.credentials;

  try {
    const {
      exists,
      data: existingData,
      currentVersion
    } = await readSecret(okmsDomain, okmsId, path, privateKey, certificate);
    const desiredData = buildDesiredBundle(existingData);

    if (deepEqual(existingData, desiredData)) return;

    if (exists) {
      await updateSecret(okmsDomain, okmsId, path, desiredData, currentVersion, privateKey, certificate);
    } else {
      await createSecret(okmsDomain, okmsId, path, desiredData, privateKey, certificate);
    }
  } catch (error) {
    throw new SecretSyncError({ error: sanitizeOvhError(error) });
  }
};

export const OvhSyncFns = {
  syncSecrets: async (secretSync: TOvhSyncWithCredentials, secretMap: TSecretMap) => {
    const {
      syncOptions: { disableSecretDeletion, keySchema }
    } = secretSync;
    const envSlug = secretSync.environment?.slug || "";

    await writeSecretBundle(secretSync, (existing) => {
      const desired: Record<string, string> = { ...existing };

      for (const [key, { value }] of Object.entries(secretMap)) {
        desired[key] = value;
      }

      if (!disableSecretDeletion) {
        for (const key of Object.keys(desired)) {
          if (matchesSchema(key, envSlug, keySchema) && !(key in secretMap)) {
            delete desired[key];
          }
        }
      }

      return desired;
    });
  },

  getSecrets: async (secretSync: TOvhSyncWithCredentials): Promise<TSecretMap> => {
    const { connection, destinationConfig } = secretSync;
    const path = String(destinationConfig.path);
    const { okmsDomain, okmsId, privateKey, certificate } = connection.credentials;

    try {
      const { data } = await readSecret(okmsDomain, okmsId, path, privateKey, certificate);
      return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { value }]));
    } catch (error) {
      throw new SecretSyncError({ error: sanitizeOvhError(error) });
    }
  },

  removeSecrets: async (secretSync: TOvhSyncWithCredentials, secretMap: TSecretMap) => {
    await writeSecretBundle(secretSync, (existing) => {
      const desired = { ...existing };
      for (const key of Object.keys(secretMap)) delete desired[key];
      return desired;
    });
  }
};
