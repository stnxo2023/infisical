import { LookupAddress } from "node:dns";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { LookupFunction } from "node:net";

import { AxiosRequestConfig } from "axios";
import { isIP } from "net";
import RE2 from "re2";

import { verifyHostInputValidity } from "@app/ee/services/dynamic-secret/dynamic-secret-fns";
import { getConfig } from "@app/lib/config/env";
import { request } from "@app/lib/config/request";

import { BadRequestError } from "../errors";
import { isPrivateIp } from "../ip/ipRange";

export type TValidatedHost = {
  hostname: string;
  entries: LookupAddress[];
};

export const blockLocalAndPrivateIpAddresses = async (
  url: string,
  isGateway = false
): Promise<TValidatedHost | undefined> => {
  const appCfg = getConfig();

  if (appCfg.isDevelopmentMode || isGateway) return undefined;

  const validUrl = new URL(url);

  if (validUrl.username || validUrl.password) {
    throw new BadRequestError({ message: "URLs with user credentials (e.g., user:pass@) are not allowed" });
  }

  let entries: LookupAddress[];
  if (isIP(validUrl.hostname)) {
    entries = [{ address: validUrl.hostname, family: isIP(validUrl.hostname) }];
  } else {
    if (validUrl.hostname === "localhost" || validUrl.hostname === "host.docker.internal") {
      throw new BadRequestError({ message: "Local IPs not allowed as URL" });
    }
    const lookups = await dns.lookup(validUrl.hostname, { all: true });

    if (!lookups || lookups.length === 0) {
      throw new BadRequestError({ message: "Could not resolve hostname to any IP address" });
    }
    entries = lookups;
  }
  const isInternalIp = entries.some((e) => isPrivateIp(e.address));
  if (isInternalIp && !appCfg.ALLOW_INTERNAL_IP_CONNECTIONS)
    throw new BadRequestError({ message: "Local IPs not allowed as URL" });

  return { hostname: validUrl.hostname, entries };
};

type FQDNOptions = {
  require_tld?: boolean;
  allow_underscores?: boolean;
  allow_trailing_dot?: boolean;
  allow_numeric_tld?: boolean;
  allow_wildcard?: boolean;
  ignore_max_length?: boolean;
};

const defaultFqdnOptions: FQDNOptions = {
  require_tld: true,
  allow_underscores: false,
  allow_trailing_dot: false,
  allow_numeric_tld: false,
  allow_wildcard: false,
  ignore_max_length: false
};

// credits: https://github.com/validatorjs/validator.js/blob/f5da7fb6ed59b94695e6fcb2e970c80029509919/src/lib/isFQDN.js#L13
export const isFQDN = (str: string, options: FQDNOptions = {}): boolean => {
  if (typeof str !== "string") {
    throw new TypeError("Expected a string");
  }

  // Apply default options
  const opts: FQDNOptions = {
    ...defaultFqdnOptions,
    ...options
  };

  let testStr = str;
  /* Remove the optional trailing dot before checking validity */
  if (opts.allow_trailing_dot && str[str.length - 1] === ".") {
    testStr = testStr.substring(0, str.length - 1);
  }

  /* Remove the optional wildcard before checking validity */
  if (opts.allow_wildcard === true && str.indexOf("*.") === 0) {
    testStr = testStr.substring(2);
  }

  const parts = testStr.split(".");
  const tld = parts[parts.length - 1];

  if (opts.require_tld) {
    // disallow fqdns without tld
    if (parts.length < 2) {
      return false;
    }

    if (
      !opts.allow_numeric_tld &&
      !new RE2(/^([a-z\u00A1-\u00A8\u00AA-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]{2,}|xn[a-z0-9-]{2,})$/i).test(tld)
    ) {
      return false;
    }

    // disallow spaces
    if (new RE2(/\s/).test(tld)) {
      return false;
    }
  }

  // reject numeric TLDs
  if (!opts.allow_numeric_tld && new RE2(/^\d+$/).test(tld)) {
    return false;
  }

  const partRegex = new RE2(/^[a-z_\u00a1-\uffff0-9-]+$/i);
  const fullWidthRegex = new RE2(/[\uff01-\uff5e]/);
  const hyphenRegex = new RE2(/^-|-$/);
  const underscoreRegex = new RE2(/_/);

  return parts.every((part) => {
    if (part.length > 63 && !opts.ignore_max_length) {
      return false;
    }

    if (!partRegex.test(part)) {
      return false;
    }

    // disallow full-width chars
    if (fullWidthRegex.test(part)) {
      return false;
    }

    // disallow parts starting or ending with hyphen
    if (hyphenRegex.test(part)) {
      return false;
    }

    if (!opts.allow_underscores && underscoreRegex.test(part)) {
      return false;
    }

    return true;
  });
};

/**
 * Maximum number of redirects to follow when manually handling redirects
 */
const MAX_SAFE_REDIRECTS = 5;

type SsrfSafeRequestOptions = {
  allowPrivateIps?: boolean;
  validateStatus?: (status: number) => boolean;
};

/**
 * Builds a `dns.lookup`-shaped function that always returns the pre-validated
 * IPs from `entries`. Installed onto an http(s).Agent so the connect-time DNS
 * call cannot re-resolve and land on a different IP than the one validation
 * approved (DNS rebinding TOCTOU defense).
 */
type TLookupOneCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
type TLookupAllCallback = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;

const makePinnedLookup = (entries: LookupAddress[]): LookupFunction =>
  ((_hostname: string, optionsOrCb: unknown, maybeCb?: unknown) => {
    // Node may invoke `lookup(hostname, callback)` (2-arg) or `lookup(hostname, options, callback)` (3-arg).
    if (typeof optionsOrCb === "function") {
      const first: LookupAddress = entries[0];
      (optionsOrCb as TLookupOneCallback)(null, first.address, first.family);
      return;
    }
    const opts = (optionsOrCb ?? {}) as { all?: boolean; family?: number };

    const filtered = opts.family ? entries.filter((e) => e.family === opts.family) : entries;
    const usable = filtered.length > 0 ? filtered : entries;
    if (opts.all) {
      (maybeCb as TLookupAllCallback)(null, usable);
    } else {
      const first: LookupAddress = usable[0];
      (maybeCb as TLookupOneCallback)(null, first.address, first.family);
    }
  }) as LookupFunction;

type TBuildAgentOptions = {
  addressFamily?: 4 | 6;
  /**
   * Custom CA for verifying the server certificate. Forwarded to https.Agent.
   * Only applied to HTTPS requests.
   */
  ca?: string | string[];
  /**
   * Whether to reject self-signed/invalid TLS certs. Forwarded to https.Agent.
   * Use with care — typically only set for legacy/internal services that ship
   * with their own CA (e.g. NetScaler, Venafi TPP).
   */
  rejectUnauthorized?: boolean;
  /**
   * TLS Server Name Indication (SNI). Forwarded to https.Agent so cert
   * verification uses the original hostname even when we connect by IP.
   * Required for hosts that present certs valid only for a specific name
   * (e.g. Kubernetes API servers).
   */
  servername?: string;
};

const hasAgentCustomization = (opts: TBuildAgentOptions): boolean =>
  Boolean(opts.addressFamily) ||
  opts.rejectUnauthorized !== undefined ||
  opts.ca !== undefined ||
  opts.servername !== undefined;

const buildPinnedAgent = (
  validated: TValidatedHost | undefined,
  protocol: string,
  opts: TBuildAgentOptions = {}
): http.Agent | https.Agent | undefined => {
  // If we don't have a pinned IP set AND there's no other agent customization,
  // fall through to Axios's default agent. This is the dev-mode/private-ip path.
  if (!validated && !hasAgentCustomization(opts)) return undefined;

  const isHttps = protocol === "https:";
  const lookup = validated ? makePinnedLookup(validated.entries) : undefined;
  const baseOpts: http.AgentOptions = {
    keepAlive: false,
    family: opts.addressFamily,
    lookup
  };

  if (isHttps) {
    const httpsOpts: https.AgentOptions = {
      ...baseOpts,
      ...(opts.ca !== undefined && { ca: opts.ca }),
      ...(opts.rejectUnauthorized !== undefined && { rejectUnauthorized: opts.rejectUnauthorized }),
      ...(opts.servername !== undefined && { servername: opts.servername })
    };
    return new https.Agent(httpsOpts);
  }
  return new http.Agent(baseOpts);
};

/**
 * Validates a URL for SSRF protection.
 * Blocks:
 * - Local/private IPs (loopback, link-local, RFC 1918 addresses)
 * - Infisical's own infrastructure (DB, Redis, etc.)
 *
 * Returns the resolved IPs so the caller can pin the subsequent connection
 * to those IPs, preventing DNS rebinding between validation and connect.
 */
export const validateSsrfUrl = async (
  url: string,
  options?: Pick<SsrfSafeRequestOptions, "allowPrivateIps">
): Promise<TValidatedHost | undefined> => {
  if (options?.allowPrivateIps) {
    return undefined;
  }

  const parsedUrl = new URL(url);

  // Block local/private IPs and capture the resolved IPs for pinning
  const validated = await blockLocalAndPrivateIpAddresses(url, false);

  // Also block Infisical's own infrastructure (DB, Redis, etc.)
  await verifyHostInputValidity({ host: parsedUrl.hostname, isGateway: false, isDynamicSecret: false });

  return validated;
};

type TSafeRequestExtras = {
  allowPrivateIps?: boolean;
  /**
   * Force IPv4 or IPv6 for the connection. The pinned lookup will filter the
   * validated IP set to this family. Mostly used for Azure App Configuration
   * where the docker setup's IPv6 path is unreliable.
   */
  addressFamily?: 4 | 6;
  /**
   * Custom CA for verifying the server certificate. Forwarded to the
   * per-request https.Agent so it composes with the pinned lookup.
   * Only applied to HTTPS URLs.
   */
  ca?: string | string[];
  /**
   * Whether to reject self-signed / invalid TLS certs. Forwarded to the
   * per-request https.Agent. Use with care.
   */
  rejectUnauthorized?: boolean;
  /**
   * TLS SNI servername forwarded to the per-request https.Agent. Required
   * for endpoints that present certs valid only for a specific hostname
   * (e.g. Kubernetes API servers). Defaults to the URL hostname if unset.
   */
  servername?: string;
};

type TSafeRequestConfig = Omit<AxiosRequestConfig, "httpAgent" | "httpsAgent" | "maxRedirects" | "url" | "method">;

type TSafeRequestFullConfig = Omit<AxiosRequestConfig, "httpAgent" | "httpsAgent" | "maxRedirects"> & {
  url: string;
} & TSafeRequestExtras;

const resolveBaseUrl = (url: string, baseURL?: string): string => {
  if (!baseURL) return url;
  try {
    return new URL(url).toString();
  } catch {
    return new URL(url, baseURL).toString();
  }
};

const dispatch = async <T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  data: unknown,
  options: TSafeRequestConfig & TSafeRequestExtras = {}
) => {
  const { allowPrivateIps, addressFamily, ca, rejectUnauthorized, servername, ...axiosOpts } = options;
  const effectiveUrl = resolveBaseUrl(url, axiosOpts.baseURL);
  const validated = await validateSsrfUrl(effectiveUrl, { allowPrivateIps });
  const { protocol } = new URL(effectiveUrl);
  const agent = buildPinnedAgent(validated, protocol, { addressFamily, ca, rejectUnauthorized, servername });

  return request.request<T>({
    ...axiosOpts,
    method,
    url,
    data,
    maxRedirects: 0,
    httpAgent: protocol === "http:" ? (agent as http.Agent | undefined) : undefined,
    httpsAgent: protocol === "https:" ? (agent as https.Agent | undefined) : undefined
  });
};

const dispatchFull = async <T>(config: TSafeRequestFullConfig) => {
  const { allowPrivateIps, addressFamily, ca, rejectUnauthorized, servername, url, ...axiosOpts } = config;
  const effectiveUrl = resolveBaseUrl(url, axiosOpts.baseURL);
  const validated = await validateSsrfUrl(effectiveUrl, { allowPrivateIps });
  const { protocol } = new URL(effectiveUrl);
  const agent = buildPinnedAgent(validated, protocol, { addressFamily, ca, rejectUnauthorized, servername });

  return request.request<T>({
    ...axiosOpts,
    url,
    maxRedirects: 0,
    httpAgent: protocol === "http:" ? (agent as http.Agent | undefined) : undefined,
    httpsAgent: protocol === "https:" ? (agent as https.Agent | undefined) : undefined
  });
};

/**
 * Makes an HTTP GET request with SSRF-safe redirect handling.
 * Disables automatic redirects and manually follows them while validating each hop.
 * This prevents redirect-based SSRF bypasses where the initial URL is valid but
 * redirects to an internal/private IP address. Each hop also pins its connection
 * to the validated IP, blocking DNS rebinding between validation and connect.
 */
export const ssrfSafeGet = async <T>(
  url: string,
  options?: SsrfSafeRequestOptions
): Promise<{ data: T; status: number; headers: Record<string, unknown> }> => {
  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount <= MAX_SAFE_REDIRECTS) {
    // eslint-disable-next-line no-await-in-loop
    const response = await dispatch<T>("GET", currentUrl, undefined, {
      allowPrivateIps: options?.allowPrivateIps,
      validateStatus: options?.validateStatus ?? ((status) => status >= 200 && status < 400)
    });

    // Check if it's a redirect
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location as string | undefined;
      if (!location) {
        throw new BadRequestError({
          message: `Redirect response (${response.status}) missing Location header`
        });
      }

      // Resolve relative redirects
      currentUrl = new URL(location, currentUrl).toString();
      redirectCount += 1;

      if (redirectCount > MAX_SAFE_REDIRECTS) {
        throw new BadRequestError({
          message: `Too many redirects (max ${MAX_SAFE_REDIRECTS})`
        });
      }
    } else {
      // Not a redirect, return the response
      return { data: response.data, status: response.status, headers: response.headers as Record<string, unknown> };
    }
  }

  throw new BadRequestError({
    message: `Too many redirects (max ${MAX_SAFE_REDIRECTS})`
  });
};

/**
 * Makes an HTTP POST request with SSRF protection.
 * Validates the URL, pins the connection to the validated IP (DNS rebinding
 * defense), and disables redirects.
 */
export const ssrfSafePost = async <T>(
  url: string,
  data: unknown,
  options?: Pick<SsrfSafeRequestOptions, "allowPrivateIps"> & { headers?: Record<string, string> }
): Promise<{ data: T }> => {
  return dispatch<T>("POST", url, data, {
    allowPrivateIps: options?.allowPrivateIps,
    headers: options?.headers
  });
};

/**
 * Drop-in replacement for `request.post` / `request.get` that validates the URL
 * and pins the connection to the validated IP. Use this anywhere the URL is
 * user-supplied and the caller currently does:
 *
 *   await blockLocalAndPrivateIpAddresses(url);
 *   await request.post(url, ...);
 *
 * Replace with:
 *
 *   await safeRequest.post(url, ...);
 *
 * which collapses the two DNS resolutions into one, eliminating the rebinding
 * window.
 */
// Defaults `T` to `any` to match Axios's `request.get`/`request.post` defaults,
// keeping `safeRequest` a true drop-in replacement.
export const safeRequest = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: <T = any>(url: string, options?: TSafeRequestConfig & TSafeRequestExtras) =>
    dispatch<T>("GET", url, undefined, options),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  post: <T = any>(url: string, data: unknown, options?: TSafeRequestConfig & TSafeRequestExtras) =>
    dispatch<T>("POST", url, data, options),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  put: <T = any>(url: string, data: unknown, options?: TSafeRequestConfig & TSafeRequestExtras) =>
    dispatch<T>("PUT", url, data, options),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patch: <T = any>(url: string, data: unknown, options?: TSafeRequestConfig & TSafeRequestExtras) =>
    dispatch<T>("PATCH", url, data, options),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete: <T = any>(url: string, options?: TSafeRequestConfig & TSafeRequestExtras) =>
    dispatch<T>("DELETE", url, undefined, options),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: <T = any>(config: TSafeRequestFullConfig) => dispatchFull<T>(config)
};
