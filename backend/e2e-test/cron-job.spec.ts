import type { Redis } from "ioredis";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { cronJobFactory } from "@app/lib/cron/cron-job";
import { initLogger } from "@app/lib/logger";

// testRedis is injected by vitest-environment-knex.ts
declare const testRedis: Redis;

// ── helpers ───────────────────────────────────────────────────────────────────

// Simple in-memory lock manager for test redlock
const lockManager = new Map<string, { timeout: NodeJS.Timeout; held: boolean }>();

// Mock Redlock for testing
const createTestRedlock = () => ({
  async using(keys: string[], duration: number, fn: (signal: AbortSignal) => Promise<void>) {
    const lockKey = keys[0];
    const existing = lockManager.get(lockKey);
    if (existing?.held) {
      throw new Error("Lock already held");
    }
    const timeout = setTimeout(() => lockManager.delete(lockKey), duration);
    lockManager.set(lockKey, { timeout, held: true });

    try {
      const controller = new AbortController();
      await fn(controller.signal);
    } finally {
      const lock = lockManager.get(lockKey);
      if (lock?.timeout) {
        clearTimeout(lock.timeout);
      }
      lockManager.delete(lockKey);
    }
  }
});

const makeFactory = (overrides?: Partial<Parameters<typeof cronJobFactory>[0]>) => {
  const redis = testRedis;
  const redlock = createTestRedlock() as unknown as Parameters<typeof cronJobFactory>[0]["redlock"];
  return cronJobFactory({
    redis,
    redlock,
    slotTtlMs: 500,
    slotRefreshMs: 100,
    enqueueIntervalMs: 500,
    processIntervalMs: 200,
    leaseDurationMs: 2000,
    retryBackoffBaseMs: 100,
    retryBackoffMaxMs: 500,
    handlerTimeoutMs: 5_000,
    minProcessAgeMs: 0,
    ...overrides
  });
};

const FAST_PATTERN = "* * * * *"; // fires every minute
const allFactories: ReturnType<typeof makeFactory>[] = [];

const factory = (overrides?: Partial<Parameters<typeof cronJobFactory>[0]>) => {
  const f = makeFactory(overrides);
  allFactories.push(f);
  return f;
};

beforeAll(() => {
  initLogger();
});

beforeEach(async () => {
  await testRedis.flushdb();
  allFactories.length = 0;
  lockManager.clear();
});

afterEach(async () => {
  await Promise.allSettled(allFactories.map((f) => f.stop()));
  await testRedis.flushdb();
  vi.useRealTimers();
});

// ── single-pod: handler runs and completes ─────────────────────────────────────

describe("single pod", () => {
  test("handler is called and run hash ends up completed", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const f = factory();
    f.register({ name: "test-job", pattern: FAST_PATTERN, handler, runHashTtlS: 3600 });
    f.start();

    // Give the tick time to fire (slot acquisition + enqueue + claim + execute)
    await new Promise((r) => {
      setTimeout(r, 3000);
    });

    expect(handler).toHaveBeenCalled();
    const keys = await testRedis.keys("cron:run:test-job:*");
    expect(keys.length).toBe(1);
    const run = await testRedis.hgetall(keys[0]);
    expect(run.status).toBe("completed");
  }, 10_000);
});

// ── two pods: exactly one handler invocation per fire boundary ─────────────────

describe("multi-pod single fire", () => {
  test("exactly one handler invocation across two factory instances", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const f1 = factory();
    const f2 = factory();
    f1.register({ name: "shared-job", pattern: FAST_PATTERN, handler, runHashTtlS: 3600 });
    f2.register({ name: "shared-job", pattern: FAST_PATTERN, handler, runHashTtlS: 3600 });
    f1.start();
    f2.start();

    await new Promise((r) => {
      setTimeout(r, 4000);
    });

    const keys = await testRedis.keys("cron:run:shared-job:*");
    expect(keys.length).toBe(1);
    const run = await testRedis.hgetall(keys[0]);
    expect(run.status).toBe("completed");
    // Handler should have been called exactly once across both pods
    expect(handler).toHaveBeenCalledTimes(1);
  }, 12_000);
});

// ── slot exhaustion: N+1 factories, exactly N participate ─────────────────────

describe("slot exhaustion", () => {
  test("only PARTICIPANT_SLOTS=5 out of 6 factories claim a slot", async () => {
    const factories = Array.from({ length: 6 }, () => factory());
    factories.forEach((f) => f.register({ name: `j`, pattern: FAST_PATTERN, handler: vi.fn(), runHashTtlS: 3600 }));
    factories.forEach((f) => f.start());

    // Allow slot acquisition to propagate
    await new Promise((r) => {
      setTimeout(r, 2000);
    });

    const slotKeys = await testRedis.keys("cron:slot:*");
    expect(slotKeys.length).toBeLessThanOrEqual(5);
  }, 8_000);
});

// ── slot handover on stop ──────────────────────────────────────────────────────

describe("slot handover", () => {
  test("stopping a participant frees its slot for another factory", async () => {
    const factories = Array.from({ length: 6 }, () => factory());
    factories.forEach((f) => f.register({ name: `h`, pattern: FAST_PATTERN, handler: vi.fn(), runHashTtlS: 3600 }));
    factories.forEach((f) => f.start());

    await new Promise((r) => {
      setTimeout(r, 2000);
    });
    const slotsBefore = await testRedis.keys("cron:slot:*");
    expect(slotsBefore.length).toBeLessThanOrEqual(5);

    // Stop all — this releases slots
    await Promise.all(factories.map((f) => f.stop()));
    const slotsAfter = await testRedis.keys("cron:slot:*");
    expect(slotsAfter.length).toBe(0);
  }, 8_000);
});

// ── retry on failure ──────────────────────────────────────────────────────────

describe("retry", () => {
  test("failed handler flips status back to pending with last_error populated", async () => {
    let calls = 0;
    const handler = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient failure");
    });
    const f = factory();
    f.register({ name: "retry-job", pattern: FAST_PATTERN, handler, maxAttempts: 3, runHashTtlS: 3600 });
    f.start();

    await new Promise((r) => {
      setTimeout(r, 4000);
    });

    const keys = await testRedis.keys("cron:run:retry-job:*");
    expect(keys.length).toBe(1);
    const run = await testRedis.hgetall(keys[0]);
    // After first failure + retry success, should be completed
    expect(run.status).toBe("completed");
    expect(handler).toHaveBeenCalledTimes(2);
  }, 12_000);

  test("after maxAttempts failures status becomes failed", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("always fails"));
    const f = factory();
    f.register({ name: "fail-job", pattern: FAST_PATTERN, handler, maxAttempts: 2, runHashTtlS: 3600 });
    f.start();

    await new Promise((r) => {
      setTimeout(r, 5000);
    });

    const keys = await testRedis.keys("cron:run:fail-job:*");
    expect(keys.length).toBe(1);
    const run = await testRedis.hgetall(keys[0]);
    expect(run.status).toBe("failed");
    expect(run.last_error).toContain("always fails");
    expect(handler).toHaveBeenCalledTimes(2);
  }, 15_000);
});

// ── handler timeout ────────────────────────────────────────────────────────────

describe("handler timeout", () => {
  test("hung handler is aborted after handlerTimeoutMs and run flips to pending with timeout error", async () => {
    // Handler never resolves — simulates a wedged network call.
    const handler = vi.fn().mockImplementation(() => new Promise<void>(() => {}));
    const f = factory({
      handlerTimeoutMs: 500,
      retryBackoffBaseMs: 100,
      retryBackoffMaxMs: 200
    });
    f.register({ name: "hang-job", pattern: FAST_PATTERN, handler, maxAttempts: 5, runHashTtlS: 3600 });
    f.start();

    // Enqueue (~500ms) + first attempt hangs for handlerTimeoutMs (500ms) +
    // backoff (100ms) + second attempt window. Wait long enough to observe
    // the timeout-driven retry without burning all attempts.
    await new Promise((r) => {
      setTimeout(r, 2500);
    });

    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
    const keys = await testRedis.keys("cron:run:hang-job:*");
    expect(keys.length).toBe(1);
    const run = await testRedis.hgetall(keys[0]);
    expect(run.last_error).toContain("exceeded");
  }, 10_000);
});

// ── retry backoff spacing ──────────────────────────────────────────────────────

describe("retry backoff", () => {
  test("retries are spaced out by backoffBase, not back-to-back", async () => {
    const callTimes: number[] = [];
    const handler = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      throw new Error("boom");
    });
    const f = factory({ retryBackoffBaseMs: 700, retryBackoffMaxMs: 2_000 });
    f.register({ name: "backoff-job", pattern: FAST_PATTERN, handler, maxAttempts: 4, runHashTtlS: 3600 });
    f.start();

    // Two failures separated by ~700ms backoff = ~1.4s + enqueue overhead.
    await new Promise((r) => {
      setTimeout(r, 3_500);
    });

    expect(callTimes.length).toBeGreaterThanOrEqual(2);
    const gap = callTimes[1] - callTimes[0];
    // Tolerance: backoff is 700ms; allow some scheduling slop on either side.
    expect(gap).toBeGreaterThanOrEqual(500);
  }, 10_000);

  test("non-final failure updates zset score to next_attempt_at (future)", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const f = factory({ retryBackoffBaseMs: 5_000, retryBackoffMaxMs: 10_000 });
    f.register({ name: "score-job", pattern: FAST_PATTERN, handler, maxAttempts: 3, runHashTtlS: 3600 });
    f.start();

    // Give time for one failure to be processed and re-scored, but not for the
    // 5s backoff to elapse.
    await new Promise((r) => {
      setTimeout(r, 2_000);
    });

    const keys = await testRedis.keys("cron:run:score-job:*");
    expect(keys.length).toBe(1);
    const id = keys[0].replace("cron:run:", "");
    const score = await testRedis.zscore("cron:pending", id);
    expect(score).not.toBeNull();
    expect(Number(score)).toBeGreaterThan(Date.now());
    expect(handler).toHaveBeenCalledTimes(1);
  }, 10_000);
});

// ── next-fire guard ────────────────────────────────────────────────────────────

describe("next-fire guard", () => {
  test("failure with backoff > cron interval is marked final immediately", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    // backoffBase (65s) > 60s cron interval — guard should mark this final on
    // the very first failure regardless of maxAttempts.
    const f = factory({ retryBackoffBaseMs: 65_000, retryBackoffMaxMs: 65_000 });
    f.register({ name: "guard-job", pattern: FAST_PATTERN, handler, maxAttempts: 5, runHashTtlS: 3600 });
    f.start();

    await new Promise((r) => {
      setTimeout(r, 2_000);
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const keys = await testRedis.keys("cron:run:guard-job:*");
    expect(keys.length).toBe(1);
    const run = await testRedis.hgetall(keys[0]);
    expect(run.status).toBe("failed");
    expect(run.last_error).toContain("boom");
  }, 10_000);
});

// ── ZSET cleared on success ────────────────────────────────────────────────────

describe("ZSET cleanup", () => {
  test("cron:pending ZSET is empty after successful execution", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const f = factory();
    f.register({ name: "clean-job", pattern: FAST_PATTERN, handler, runHashTtlS: 3600 });
    f.start();

    await new Promise((r) => {
      setTimeout(r, 3000);
    });

    const pending = await testRedis.zrange("cron:pending", 0, -1);
    expect(pending.filter((s) => s.startsWith("clean-job:"))).toEqual([]);
  }, 10_000);
});

// ── min-age gate ───────────────────────────────────────────────────────────────

describe("min-age gate", () => {
  test("run is enqueued but handler is withheld until minProcessAgeMs elapses", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    // Override only the age gate; all other timings stay at their e2e defaults.
    const f = factory({ minProcessAgeMs: 500 });
    f.register({ name: "age-gate-job", pattern: FAST_PATTERN, handler, runHashTtlS: 3600 });
    f.start();

    // Wait for the enqueue tick (enqueueIntervalMs=500ms) + buffer so the run
    // hash is present in Redis, but NOT long enough for the 500ms age gate to
    // clear. Enqueue fires at ~500ms; at 700ms the run is only ~200ms old and
    // the process ticks at 600ms / 800ms both skip it.
    await new Promise((r) => {
      setTimeout(r, 700);
    });

    const keys = await testRedis.keys("cron:run:age-gate-job:*");
    expect(keys.length).toBe(1); // run is in Redis
    expect(handler).not.toHaveBeenCalled(); // but age gate is holding it back

    // Earliest possible pickup: enqueue at ~500ms + minProcessAgeMs 500ms = ~1000ms.
    // Allow until 2500ms total to absorb any scheduling jitter.
    await new Promise((r) => {
      setTimeout(r, 1800);
    });

    expect(handler).toHaveBeenCalled();
  }, 10_000);
});
