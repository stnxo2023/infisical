import { createHmac } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { KeyStorePrefixes, KeyStoreTtls, TKeyStoreFactory } from "@app/keystore/keystore";
import { crypto } from "@app/lib/crypto/cryptography";
import { BadRequestError, UnauthorizedError } from "@app/lib/errors";

import { TEmailSignupOtpPayload } from "./auth-token-types";
import { tokenServiceFactory } from "./auth-token-service";

const AUTH_SECRET = "test-secret-for-otp-unit-tests";
const NOW_MS = 1_700_000_000_000;
const TEST_EMAIL = "otp-test@example.com";

vi.mock("@app/lib/config/env", () => ({
  getConfig: () => ({ AUTH_SECRET })
}));

vi.mock("@app/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}));

const hmac = (value: string) => createHmac("sha256", AUTH_SECRET).update(value).digest("hex");

// Pre-compute key names so assertions can reference them without re-running production logic.
const emailHash = hmac(TEST_EMAIL);
const otpKey = KeyStorePrefixes.EmailSignupOtpHash(emailHash);
const cooldownKey = KeyStorePrefixes.EmailSignupResendCooldown(emailHash);

type KeyStoreSlice = Pick<TKeyStoreFactory, "setItemWithExpiry" | "getItem" | "deleteItem" | "acquireLock" | "deleteItemsByKeyIn" | "ttl">;

const makeKeyStore = (patch: Partial<KeyStoreSlice> = {}): KeyStoreSlice & { [k: string]: ReturnType<typeof vi.fn> } =>
  ({
    setItemWithExpiry: vi.fn().mockResolvedValue("OK"),
    getItem: vi.fn().mockResolvedValue(null),
    deleteItem: vi.fn().mockResolvedValue(1),
    acquireLock: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
    deleteItemsByKeyIn: vi.fn().mockResolvedValue(2),
    ttl: vi.fn().mockResolvedValue(-1),
    ...patch
  }) as KeyStoreSlice & { [k: string]: ReturnType<typeof vi.fn> };

const createService = (patch: Partial<KeyStoreSlice> = {}) => {
  const keyStore = makeKeyStore(patch);
  const service = tokenServiceFactory({
    tokenDAL: {} as never,
    userDAL: {} as never,
    orgDAL: {} as never,
    membershipUserDAL: {} as never,
    keyStore: keyStore as never
  });
  return { service, keyStore };
};

const makeStoredPayload = (overrides: Partial<TEmailSignupOtpPayload> = {}): string =>
  JSON.stringify({
    tokenHash: hmac("123456"),
    triesLeft: 3,
    expiresAt: NOW_MS + 300_000,
    ...overrides
  } satisfies TEmailSignupOtpPayload);

describe("tokenServiceFactory — email signup OTP", () => {
  beforeAll(async () => {
    process.env.FIPS_ENABLED = "false";
    await crypto.initialize({} as never, {} as never, {} as never);
  });

  afterAll(() => {
    delete process.env.FIPS_ENABLED;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // createEmailSignupToken
  // ---------------------------------------------------------------------------

  describe("createEmailSignupToken", () => {
    test("returns a 6-digit token string and the configured cooldownSeconds", async () => {
      const { service } = createService();

      const result = await service.createEmailSignupToken(TEST_EMAIL);

      expect(result.cooldownSeconds).toBe(KeyStoreTtls.EmailSignupResendCooldownInSeconds);
      expect(result.token).toMatch(/^\d{6}$/);
    });

    test("stores the HMAC of the token (not the plain token) in the keystore", async () => {
      const { service, keyStore } = createService();

      const { token } = await service.createEmailSignupToken(TEST_EMAIL);
      const expectedHash = hmac(token);

      const storedArg: string = (keyStore.setItemWithExpiry as ReturnType<typeof vi.fn>).mock.calls.find(
        ([k]: string[]) => k === otpKey
      )?.[2];

      expect(storedArg).toBeDefined();
      const parsed = JSON.parse(storedArg) as TEmailSignupOtpPayload;
      expect(parsed.tokenHash).toBe(expectedHash);
      expect(parsed.triesLeft).toBe(3);
    });

    test("sets the cooldown key in keystore", async () => {
      const { service, keyStore } = createService();

      await service.createEmailSignupToken(TEST_EMAIL);

      expect(keyStore.setItemWithExpiry).toHaveBeenCalledWith(
        cooldownKey,
        KeyStoreTtls.EmailSignupResendCooldownInSeconds,
        "1"
      );
    });

    test("throws BadRequestError when cooldown key is present", async () => {
      const { service } = createService({
        getItem: vi.fn().mockImplementation(async (key: string) => (key === cooldownKey ? "1" : null)),
        ttl: vi.fn().mockResolvedValue(45)
      });

      await expect(service.createEmailSignupToken(TEST_EMAIL)).rejects.toThrow(BadRequestError);
    });

    test("BadRequestError details.cooldownSeconds reflects the remaining TTL", async () => {
      const { service } = createService({
        getItem: vi.fn().mockImplementation(async (key: string) => (key === cooldownKey ? "1" : null)),
        ttl: vi.fn().mockResolvedValue(30)
      });

      const err = await service.createEmailSignupToken(TEST_EMAIL).catch((e) => e);

      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as BadRequestError).details).toMatchObject({ cooldownSeconds: 30 });
    });

    test("clamps cooldownSeconds to at least 1 when TTL returns -1", async () => {
      const { service } = createService({
        getItem: vi.fn().mockImplementation(async (key: string) => (key === cooldownKey ? "1" : null)),
        ttl: vi.fn().mockResolvedValue(-1)
      });

      const err = await service.createEmailSignupToken(TEST_EMAIL).catch((e) => e);

      expect((err as BadRequestError).details).toMatchObject({ cooldownSeconds: 1 });
    });
  });

  // ---------------------------------------------------------------------------
  // validateEmailSignupToken
  // ---------------------------------------------------------------------------

  describe("validateEmailSignupToken", () => {
    test("resolves without error when code matches a valid unexpired payload", async () => {
      const { service } = createService({
        getItem: vi.fn().mockResolvedValue(makeStoredPayload())
      });

      await expect(service.validateEmailSignupToken(TEST_EMAIL, "123456")).resolves.toBeUndefined();
    });

    test("deletes both the OTP key and the cooldown key on success", async () => {
      const { service, keyStore } = createService({
        getItem: vi.fn().mockResolvedValue(makeStoredPayload())
      });

      await service.validateEmailSignupToken(TEST_EMAIL, "123456");

      expect(keyStore.deleteItemsByKeyIn).toHaveBeenCalledWith(
        expect.arrayContaining([otpKey, cooldownKey])
      );
    });

    test("throws UnauthorizedError when no OTP record exists in keystore", async () => {
      const { service } = createService({
        getItem: vi.fn().mockResolvedValue(null)
      });

      await expect(service.validateEmailSignupToken(TEST_EMAIL, "123456")).rejects.toThrow(UnauthorizedError);
    });

    test("throws UnauthorizedError and deletes the key when token is expired", async () => {
      const { service, keyStore } = createService({
        getItem: vi.fn().mockResolvedValue(makeStoredPayload({ expiresAt: NOW_MS - 1 }))
      });

      await expect(service.validateEmailSignupToken(TEST_EMAIL, "123456")).rejects.toThrow(UnauthorizedError);
      expect(keyStore.deleteItem).toHaveBeenCalledWith(otpKey);
    });

    test("throws UnauthorizedError when code is wrong and decrements tries", async () => {
      const { service, keyStore } = createService({
        getItem: vi.fn().mockResolvedValue(makeStoredPayload({ triesLeft: 3 }))
      });

      await expect(service.validateEmailSignupToken(TEST_EMAIL, "000000")).rejects.toThrow(UnauthorizedError);

      const updatedPayload = JSON.parse(
        (keyStore.setItemWithExpiry as ReturnType<typeof vi.fn>).mock.calls[0][2]
      ) as TEmailSignupOtpPayload;
      expect(updatedPayload.triesLeft).toBe(2);
    });

    test("deletes the OTP key and throws when the last try is exhausted", async () => {
      const { service, keyStore } = createService({
        getItem: vi.fn().mockResolvedValue(makeStoredPayload({ triesLeft: 1 }))
      });

      await expect(service.validateEmailSignupToken(TEST_EMAIL, "000000")).rejects.toThrow(UnauthorizedError);
      expect(keyStore.deleteItem).toHaveBeenCalledWith(otpKey);
      expect(keyStore.setItemWithExpiry).not.toHaveBeenCalled();
    });

    test("always acquires and releases the lock regardless of outcome", async () => {
      const releaseFn = vi.fn().mockResolvedValue(undefined);
      const { service } = createService({
        getItem: vi.fn().mockResolvedValue(null),
        acquireLock: vi.fn().mockResolvedValue({ release: releaseFn })
      });

      await expect(service.validateEmailSignupToken(TEST_EMAIL, "123456")).rejects.toThrow(UnauthorizedError);
      expect(releaseFn).toHaveBeenCalledOnce();
    });
  });
});
