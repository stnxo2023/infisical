import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { IdentityAuthMethod } from "@app/db/schemas";
import { crypto } from "@app/lib/crypto";
import { IPType, TIp } from "@app/lib/ip";

import { signIdentityAccessToken } from "./identity-access-token-fns";
import { identityAccessTokenServiceFactory } from "./identity-access-token-service";
import { TIdentityAccessTokenJwtPayload } from "./identity-access-token-types";

const MAX_AGE = 7_776_000;
const AUTH_SECRET = "test-auth-secret";
const NOW_SECONDS = 1_700_000_000;

vi.mock("@app/lib/config/env", () => ({
  getConfig: () => ({
    AUTH_SECRET,
    MAX_MACHINE_IDENTITY_TOKEN_AGE: MAX_AGE
  })
}));

vi.mock("@app/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn()
  }
}));

const createService = ({
  trustedIps = [],
  membership = { isActive: true },
  activeRevocations = []
}: {
  trustedIps?: TIp[] | null;
  membership?: { isActive: boolean } | null;
  activeRevocations?: Array<{ id: string; identityId: string; revokedAt?: Date | null; createdAt: Date }>;
} = {}) => {
  const keyStore = {
    getItem: vi.fn().mockResolvedValue(null),
    incrementBy: vi.fn(),
    setItemWithExpiry: vi.fn()
  };
  const identityAccessTokenRevocationDAL = {
    findActiveRevocationsForToken: vi.fn().mockResolvedValue(activeRevocations),
    insertRevocation: vi.fn()
  };
  const identityDAL = {
    getTrustedIpsByAuthMethod: vi.fn().mockResolvedValue(trustedIps),
    findById: vi.fn()
  };
  const orgDAL = {
    findEffectiveOrgMembership: vi.fn().mockResolvedValue(membership)
  };

  const service = identityAccessTokenServiceFactory({
    identityAccessTokenDAL: { findOne: vi.fn() } as never,
    identityAccessTokenRevocationDAL: identityAccessTokenRevocationDAL as never,
    identityDAL: identityDAL as never,
    orgDAL: orgDAL as never,
    keyStore: keyStore as never
  });

  return { service, keyStore, identityDAL, orgDAL, identityAccessTokenRevocationDAL };
};

const createTokenClaims = (
  overrides: Partial<TIdentityAccessTokenJwtPayload> = {}
): TIdentityAccessTokenJwtPayload => ({
  jti: "token-id",
  iat: NOW_SECONDS,
  exp: NOW_SECONDS + 3600,
  identityId: "identity-id",
  identityName: "identity-name",
  authMethod: IdentityAuthMethod.UNIVERSAL_AUTH,
  orgId: "org-id",
  rootOrgId: "root-org-id",
  parentOrgId: "parent-org-id",
  ipRestrictionEnabled: false,
  clientSecretId: "",
  identityAccessTokenId: "token-id",
  authTokenType: "identity-access-token",
  accessTokenTTL: 0,
  accessTokenMaxTTL: 0,
  accessTokenPeriod: 0,
  creationEpoch: NOW_SECONDS,
  identityAuth: {},
  ...overrides
});

describe("identityAccessTokenServiceFactory", () => {
  let previousFipsEnabled: string | undefined;

  beforeAll(async () => {
    previousFipsEnabled = process.env.FIPS_ENABLED;
    process.env.FIPS_ENABLED = "false";
    await crypto.initialize({} as never, {} as never, {} as never);
  });

  afterAll(() => {
    if (previousFipsEnabled === undefined) {
      delete process.env.FIPS_ENABLED;
    } else {
      process.env.FIPS_ENABLED = previousFipsEnabled;
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("writes per-token revocation to PG with the JWT exp for zero configured TTL tokens", async () => {
    const { accessToken } = signIdentityAccessToken({
      identityAccessTokenId: "token-id",
      identityId: "identity-id",
      identityName: "identity-name",
      authMethod: IdentityAuthMethod.UNIVERSAL_AUTH,
      orgId: "org-id",
      rootOrgId: "root-org-id",
      parentOrgId: "parent-org-id",
      clientSecretId: "",
      numUsesLimit: 0,
      ipRestrictionEnabled: false,
      ttlSeconds: MAX_AGE,
      accessTokenTTL: 0,
      accessTokenMaxTTL: 0,
      accessTokenPeriod: 0,
      creationEpoch: NOW_SECONDS,
      identityAuth: {}
    });
    const { service, identityAccessTokenRevocationDAL } = createService();

    await service.revokeAccessToken(accessToken);

    expect(identityAccessTokenRevocationDAL.insertRevocation).toHaveBeenCalledWith({
      id: "token-id",
      identityId: "identity-id",
      expiresAt: new Date((NOW_SECONDS + MAX_AGE) * 1000)
    });
  });

  test("writes identity-wide revocation sentinel to PG", async () => {
    const { service, identityAccessTokenRevocationDAL } = createService();

    await service.revokeAllTokensForIdentity("identity-id");

    expect(identityAccessTokenRevocationDAL.insertRevocation).toHaveBeenCalledWith({
      id: "identity-id",
      identityId: "identity-id",
      revokedAt: new Date(NOW_SECONDS * 1000),
      expiresAt: new Date((NOW_SECONDS + MAX_AGE) * 1000)
    });
  });

  test("rejects active per-token PG revocations", async () => {
    const { service } = createService({
      activeRevocations: [{ id: "token-id", identityId: "identity-id", createdAt: new Date(NOW_SECONDS * 1000) }]
    });

    await expect(service.fnValidateIdentityAccessTokenFast(createTokenClaims(), "10.0.0.1")).rejects.toThrow(
      "token has been revoked"
    );
  });

  test("rejects active identity-wide PG revocations for tokens issued before revokedAt", async () => {
    const { service } = createService({
      activeRevocations: [
        {
          id: "identity-id",
          identityId: "identity-id",
          revokedAt: new Date((NOW_SECONDS + 10) * 1000),
          createdAt: new Date((NOW_SECONDS + 10) * 1000)
        }
      ]
    });

    await expect(service.fnValidateIdentityAccessTokenFast(createTokenClaims(), "10.0.0.1")).rejects.toThrow(
      "identity tokens have been revoked"
    );
  });

  test("allows tokens issued after an identity-wide PG revocation", async () => {
    const { service } = createService({
      activeRevocations: [
        {
          id: "identity-id",
          identityId: "identity-id",
          revokedAt: new Date((NOW_SECONDS - 10) * 1000),
          createdAt: new Date((NOW_SECONDS - 10) * 1000)
        }
      ]
    });

    await expect(service.fnValidateIdentityAccessTokenFast(createTokenClaims(), "10.0.0.1")).resolves.toMatchObject({
      identityId: "identity-id",
      orgId: "org-id"
    });
  });

  test("keeps usage counters in Redis", async () => {
    const { service, keyStore } = createService();
    keyStore.getItem.mockResolvedValue("1");
    keyStore.incrementBy.mockResolvedValue(0);

    await expect(
      service.fnValidateIdentityAccessTokenFast(createTokenClaims({ numUsesLimit: 3 }), "10.0.0.1")
    ).resolves.toMatchObject({
      identityId: "identity-id"
    });
    expect(keyStore.incrementBy).toHaveBeenCalledWith("identity-token-uses-remaining:identity-id:token-id", -1);
  });

  test("rejects exhausted Redis usage counters", async () => {
    const { service, keyStore } = createService();
    keyStore.getItem.mockResolvedValue("0");

    await expect(
      service.fnValidateIdentityAccessTokenFast(createTokenClaims({ numUsesLimit: 3 }), "10.0.0.1")
    ).rejects.toThrow("usage limit reached");
  });

  test("rejects renewal when PG says the token is revoked", async () => {
    const { accessToken } = signIdentityAccessToken({
      identityAccessTokenId: "token-id",
      identityId: "identity-id",
      identityName: "identity-name",
      authMethod: IdentityAuthMethod.UNIVERSAL_AUTH,
      orgId: "org-id",
      rootOrgId: "root-org-id",
      parentOrgId: "parent-org-id",
      clientSecretId: "",
      numUsesLimit: 0,
      ipRestrictionEnabled: false,
      ttlSeconds: MAX_AGE,
      accessTokenTTL: 0,
      accessTokenMaxTTL: 0,
      accessTokenPeriod: 0,
      creationEpoch: NOW_SECONDS,
      identityAuth: {}
    });
    const { service } = createService({
      activeRevocations: [{ id: "token-id", identityId: "identity-id", createdAt: new Date(NOW_SECONDS * 1000) }]
    });

    await expect(service.renewAccessToken({ accessToken })).rejects.toThrow("token has been revoked");
  });

  test("checks current trusted IPs even when the token was issued without IP restrictions", async () => {
    const { service, identityDAL } = createService({
      trustedIps: [{ ipAddress: "10.0.0.0", prefix: 24, type: IPType.IPV4 }]
    });

    await expect(service.fnValidateIdentityAccessTokenFast(createTokenClaims(), "192.168.1.1")).rejects.toThrow(
      "current IP address"
    );
    expect(identityDAL.getTrustedIpsByAuthMethod).toHaveBeenCalledWith(
      "identity-id",
      IdentityAuthMethod.UNIVERSAL_AUTH
    );
  });

  test("allows wildcard current trusted IPs", async () => {
    const { service } = createService({
      trustedIps: [{ ipAddress: "0.0.0.0/0", prefix: 0, type: IPType.IPV4 }]
    });

    await expect(service.fnValidateIdentityAccessTokenFast(createTokenClaims(), "192.168.1.1")).resolves.toMatchObject({
      identityId: "identity-id",
      orgId: "org-id"
    });
  });

  test("rejects when the identity no longer has an effective org membership", async () => {
    const { service } = createService({ membership: null });

    await expect(service.fnValidateIdentityAccessTokenFast(createTokenClaims(), "10.0.0.1")).rejects.toThrow(
      "not a member"
    );
  });

  test("rejects when the identity org membership is inactive", async () => {
    const { service } = createService({ membership: { isActive: false } });

    await expect(service.fnValidateIdentityAccessTokenFast(createTokenClaims(), "10.0.0.1")).rejects.toThrow(
      "membership is inactive"
    );
  });
});
