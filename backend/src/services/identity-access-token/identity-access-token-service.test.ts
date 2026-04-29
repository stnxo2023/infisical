import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { IdentityAuthMethod } from "@app/db/schemas";
import { crypto } from "@app/lib/crypto";
import { IPType, TIp } from "@app/lib/ip";
import { QueueJobs, QueueName } from "@app/queue";

import { signIdentityAccessToken } from "./identity-access-token-fns";
import { identityAccessTokenQueueServiceFactory } from "./identity-access-token-queue";
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
  membership = { isActive: true }
}: {
  trustedIps?: TIp[] | null;
  membership?: { isActive: boolean } | null;
} = {}) => {
  const keyStore = {
    hashGetMulti: vi.fn().mockResolvedValue([null, null]),
    hashIncrementBy: vi.fn(),
    hashSetWithExpiry: vi.fn(),
    setItemWithExpiry: vi.fn(),
    setItemWithExpiryNX: vi.fn()
  };
  const identityDAL = {
    getTrustedIpsByAuthMethod: vi.fn().mockResolvedValue(trustedIps),
    findById: vi.fn()
  };
  const orgDAL = {
    findEffectiveOrgMembership: vi.fn().mockResolvedValue(membership)
  };
  const identityAccessTokenQueue = {
    queuePgMirror: vi.fn(),
    startPartitionMaintenanceCron: vi.fn(),
    runPartitionMaintenance: vi.fn()
  };

  const service = identityAccessTokenServiceFactory({
    identityAccessTokenDAL: { findOne: vi.fn() } as never,
    identityAccessTokenRevocationDAL: {} as never,
    identityDAL: identityDAL as never,
    orgDAL: orgDAL as never,
    keyStore: keyStore as never,
    identityAccessTokenQueue: identityAccessTokenQueue as never
  });

  return { service, keyStore, identityDAL, orgDAL, identityAccessTokenQueue };
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

  test("queues per-token revocation with the JWT exp for zero configured TTL tokens", async () => {
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
    const { service, identityAccessTokenQueue } = createService();

    await service.revokeAccessToken(accessToken);

    expect(identityAccessTokenQueue.queuePgMirror).toHaveBeenCalledWith({
      kind: "revoke-token",
      tokenId: "token-id",
      identityId: "identity-id",
      expiresAt: new Date((NOW_SECONDS + MAX_AGE) * 1000).toISOString()
    });
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

describe("identityAccessTokenQueueServiceFactory", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("queues PG mirror jobs with BullMQ-safe job IDs", async () => {
    const queueService = {
      queue: vi.fn(),
      upsertJobScheduler: vi.fn(),
      listen: vi.fn(),
      start: vi.fn()
    };

    const queue = identityAccessTokenQueueServiceFactory({
      queueService: queueService as never,
      identityAccessTokenRevocationDAL: {
        insertRevocation: vi.fn(),
        ensurePartition: vi.fn(),
        listPartitionsExpiredBefore: vi.fn(),
        dropPartition: vi.fn()
      } as never
    });

    await queue.queuePgMirror({
      kind: "revoke-token",
      tokenId: "token-id",
      identityId: "identity-id",
      expiresAt: "2026-04-28T00:00:00.000Z"
    });

    expect(queueService.queue).toHaveBeenCalledWith(
      QueueName.IdentityAccessTokenPgMirror,
      QueueJobs.IdentityAccessTokenPgMirrorRevokeToken,
      expect.any(Object),
      expect.objectContaining({ jobId: "iat-revoke-token-token-id" })
    );
  });

  test("mirrors per-token revocations using the queued expiration", async () => {
    const insertRevocation = vi.fn();
    let worker: ((job: { name: QueueJobs; data: unknown }) => Promise<void>) | undefined;
    const queueService = {
      queue: vi.fn(),
      upsertJobScheduler: vi.fn(),
      listen: vi.fn(),
      start: vi.fn((_queueName: QueueName, handler: (job: { name: QueueJobs; data: unknown }) => Promise<void>) => {
        worker = handler;
      })
    };

    identityAccessTokenQueueServiceFactory({
      queueService: queueService as never,
      identityAccessTokenRevocationDAL: {
        insertRevocation,
        ensurePartition: vi.fn(),
        listPartitionsExpiredBefore: vi.fn(),
        dropPartition: vi.fn()
      } as never
    });

    await worker?.({
      name: QueueJobs.IdentityAccessTokenPgMirrorRevokeToken,
      data: {
        kind: "revoke-token",
        tokenId: "token-id",
        identityId: "identity-id",
        expiresAt: "2026-04-28T00:00:00.000Z"
      }
    });

    expect(queueService.start).toHaveBeenCalledWith(QueueName.IdentityAccessTokenPgMirror, expect.any(Function));
    expect(insertRevocation).toHaveBeenCalledWith({
      id: "token-id",
      identityId: "identity-id",
      expiresAt: new Date("2026-04-28T00:00:00.000Z")
    });
  });
});
