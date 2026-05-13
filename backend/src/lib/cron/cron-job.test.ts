import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { cronJobFactory } from "./cron-job";

vi.mock("@app/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

// ── helpers ───────────────────────────────────────────────────────────────────

const makeRedis = () => ({
  set: vi.fn().mockResolvedValue(null),
  get: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
  exists: vi.fn().mockResolvedValue(0),
  hset: vi.fn().mockResolvedValue(1),
  hgetall: vi.fn().mockResolvedValue(null),
  zrangebyscore: vi.fn().mockResolvedValue([]),
  zadd: vi.fn().mockResolvedValue(1),
  zrem: vi.fn().mockResolvedValue(1),
  eval: vi.fn().mockResolvedValue(0)
});

const makeRedlock = () => ({
  using: vi.fn(async (_keys: string[], _duration: number, fn: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    return fn(controller.signal);
  })
});

// Use a cast via unknown to satisfy the type system for the mocks
type FakeDeps = {
  redis: ReturnType<typeof makeRedis>;
  redlock: ReturnType<typeof makeRedlock>;
};
const makeFactory = (deps?: Partial<FakeDeps>) => {
  const redis = deps?.redis ?? makeRedis();
  const redlock = deps?.redlock ?? makeRedlock();
  return {
    ...cronJobFactory({
      redis: redis as never,
      redlock: redlock as never,
      slotRefreshMs: 50,
      enqueueIntervalMs: 100,
      processIntervalMs: 100,
      slotTtlMs: 200,
      leaseDurationMs: 1000
    }),
    redis,
    redlock
  };
};

// ── lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("register", () => {
  test("throws on invalid cron pattern", () => {
    const { register } = makeFactory();
    expect(() => register({ name: "x", pattern: "not-a-cron", handler: vi.fn(), runHashTtlS: 3600 })).toThrow();
  });

  test("throws on duplicate name", () => {
    const { register } = makeFactory();
    register({ name: "x", pattern: "0 0 * * *", handler: vi.fn(), runHashTtlS: 3600 });
    expect(() => register({ name: "x", pattern: "0 0 * * *", handler: vi.fn(), runHashTtlS: 3600 })).toThrow(
      /already registered/
    );
  });

  test("disabled entry is skipped", async () => {
    const { register, start, stop, redis } = makeFactory();
    register({ name: "x", pattern: "0 0 * * *", handler: vi.fn(), runHashTtlS: 3600, enabled: false });
    start();
    expect(redis.eval).not.toHaveBeenCalled();
    await stop();
  });
});

describe("slot election", () => {
  test("claims slot 0 on boot when free", async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValueOnce("OK");
    const { start, stop } = makeFactory({ redis });
    start();
    // Let the immediate claimOrRefreshSlot call in start() complete
    await Promise.resolve();
    expect(redis.set).toHaveBeenCalledWith("cron:slot:0", expect.any(String), "PX", expect.any(Number), "NX");
    await stop();
  });

  test("falls through to slot 1 when slot 0 is held", async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValueOnce(null).mockResolvedValueOnce("OK");
    const { start, stop } = makeFactory({ redis });
    start();
    await Promise.resolve();
    expect(redis.set).toHaveBeenNthCalledWith(1, "cron:slot:0", expect.any(String), "PX", expect.any(Number), "NX");
    expect(redis.set).toHaveBeenNthCalledWith(2, "cron:slot:1", expect.any(String), "PX", expect.any(Number), "NX");
    await stop();
  });

  test("sits idle when all slots are held", async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValue(null);
    const { register, start, stop } = makeFactory({ redis });
    register({ name: "x", pattern: "0 0 * * *", handler: vi.fn(), runHashTtlS: 3600 });
    start();
    await Promise.resolve();
    expect(redis.eval).not.toHaveBeenCalled();
    await stop();
  });

  test("refreshes held slot on next interval", async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValueOnce("OK").mockResolvedValue("OK");
    const { start, stop } = makeFactory({ redis });
    start();
    await Promise.resolve();
    vi.advanceTimersByTime(60);
    await Promise.resolve();
    const xxCalls = redis.set.mock.calls.filter((c) => (c as string[]).includes("XX"));
    expect(xxCalls.length).toBeGreaterThan(0);
    await stop();
  });

  test("re-attempts NX after slot refresh fails", async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null).mockResolvedValueOnce("OK");
    const { start, stop } = makeFactory({ redis });
    start();
    vi.advanceTimersByTime(60);
    await Promise.resolve();
    const nxCalls = redis.set.mock.calls.filter((c) => (c as string[]).includes("NX"));
    expect(nxCalls.length).toBeGreaterThanOrEqual(2);
    await stop();
  });
});

describe("claim and execute", () => {
  test("boundary cache skips eval when timestamp unchanged", async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValue("OK");
    redis.eval.mockResolvedValue(1);
    const { register, start, stop } = makeFactory({ redis });
    register({ name: "x", pattern: "0 0 * * *", handler: vi.fn(), runHashTtlS: 3600 });
    start();
    await Promise.resolve();
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    const firstCount = redis.eval.mock.calls.length;
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(redis.eval.mock.calls.length).toBe(firstCount);
    await stop();
  });

  test("skips row whose name is not in local registry", async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValue("OK");
    redis.zrangebyscore.mockResolvedValue(["unknown:1000000000000"]);
    redis.hgetall.mockResolvedValue({ name: "unknown", status: "pending", attempts: "0" });
    const redlock = makeRedlock();
    const { register, start, stop } = makeFactory({ redis, redlock });
    register({ name: "x", pattern: "0 0 * * *", handler: vi.fn(), runHashTtlS: 3600 });
    start();
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(redlock.using).not.toHaveBeenCalled();
    await stop();
  });
});

describe("retry backoff and handler timeout", () => {
  // Helper: wires up the mock chain so the factory will pick up a single
  // pending run for cron name "x" and invoke the registered handler.
  const setupPendingRun = (redis: ReturnType<typeof makeRedis>, runIdScheduledAt: number) => {
    redis.set.mockResolvedValue("OK"); // slot claim succeeds
    redis.eval.mockResolvedValue(1); // enqueue succeeds
    redis.zrangebyscore.mockResolvedValue([`x:${runIdScheduledAt}`]);
    redis.hgetall.mockResolvedValue({
      name: "x",
      status: "pending",
      attempts: "0",
      enqueued_at_ms: "0"
    });
  };

  test("non-final failure updates zset score to a future next_attempt_at", async () => {
    // Early in a minute: default 30s backoff fits comfortably before next fire.
    vi.setSystemTime(new Date("2024-01-01T00:00:05Z"));
    const redis = makeRedis();
    setupPendingRun(redis, Date.parse("2024-01-01T00:00:00Z"));

    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const { register, start, stop } = makeFactory({ redis });
    register({ name: "x", pattern: "* * * * *", handler, runHashTtlS: 3600, maxAttempts: 3 });
    start();

    // Slot claim + enqueue + process tick + handler reject
    await vi.advanceTimersByTimeAsync(300);

    expect(handler).toHaveBeenCalled();
    expect(redis.zadd).toHaveBeenCalled();
    const zaddArgs = redis.zadd.mock.calls[0] as unknown[];
    expect(Number(zaddArgs[1])).toBeGreaterThan(Date.now());

    // Status hash was updated to pending with next_attempt_at
    const wroteNextAttempt = redis.hset.mock.calls.some((c) =>
      (c as unknown[]).some((arg) => arg === "next_attempt_at")
    );
    expect(wroteNextAttempt).toBe(true);

    await stop();
  });

  test("retry whose backoff overflows next fire is marked failed (zrem, not zadd)", async () => {
    // 5s before next minute: backoffBase=30s overflows the interval.
    vi.setSystemTime(new Date("2024-01-01T00:00:55Z"));
    const redis = makeRedis();
    setupPendingRun(redis, Date.parse("2024-01-01T00:00:00Z"));

    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const { register, start, stop } = makeFactory({ redis });
    register({ name: "x", pattern: "* * * * *", handler, runHashTtlS: 3600, maxAttempts: 5 });
    start();

    await vi.advanceTimersByTimeAsync(300);

    expect(handler).toHaveBeenCalled();
    // Guard short-circuits before zadd
    expect(redis.zadd).not.toHaveBeenCalled();
    expect(redis.zrem).toHaveBeenCalled();
    // Status flipped to failed
    const wroteFailed = redis.hset.mock.calls.some((c) =>
      (c as unknown[]).some((arg, i, arr) => arg === "status" && arr[i + 1] === "failed")
    );
    expect(wroteFailed).toBe(true);

    await stop();
  });

  test("hung handler is aborted after handlerTimeoutMs and last_error includes 'exceeded'", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:30Z"));
    const redis = makeRedis();
    setupPendingRun(redis, Date.parse("2024-01-01T00:00:00Z"));

    const handler = vi.fn().mockImplementation(() => new Promise<void>(() => {})); // never resolves
    // Build factory inline because makeFactory doesn't expose handlerTimeoutMs.
    const redlock = makeRedlock();
    const f = cronJobFactory({
      redis: redis as never,
      redlock: redlock as never,
      slotRefreshMs: 50,
      enqueueIntervalMs: 100,
      processIntervalMs: 100,
      slotTtlMs: 200,
      leaseDurationMs: 1000,
      handlerTimeoutMs: 200
    });
    f.register({ name: "x", pattern: "* * * * *", handler, runHashTtlS: 3600, maxAttempts: 3 });
    f.start();

    // Slot + enqueue + handler starts hanging, then past handlerTimeoutMs.
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(500);

    expect(handler).toHaveBeenCalled();
    // The handler-timeout setTimeout's reject path writes last_error containing
    // "exceeded" — strongest evidence the timeout fired and the catch ran.
    const wroteTimeoutError = redis.hset.mock.calls.some((c) =>
      (c as unknown[]).some((arg) => typeof arg === "string" && arg.includes("exceeded"))
    );
    expect(wroteTimeoutError).toBe(true);

    await f.stop();
  });
});

describe("min-age gate", () => {
  test("redlock is skipped while run is fresh, then fires once minProcessAgeMs has elapsed", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:30Z"));
    const enqueuedAt = Date.now(); // captured at fake-clock baseline

    const redis = makeRedis();
    redis.set.mockResolvedValue("OK"); // slot claim succeeds
    redis.zrangebyscore.mockResolvedValue([`x:${enqueuedAt}`]);
    redis.hgetall.mockResolvedValue({
      name: "x",
      status: "pending",
      attempts: "0",
      enqueued_at_ms: String(enqueuedAt)
    });

    const redlock = makeRedlock();
    const f = cronJobFactory({
      redis: redis as never,
      redlock: redlock as never,
      slotRefreshMs: 50,
      enqueueIntervalMs: 100,
      processIntervalMs: 100,
      slotTtlMs: 200,
      leaseDurationMs: 1000,
      minProcessAgeMs: 500
    });
    f.register({ name: "x", pattern: "* * * * *", handler: vi.fn(), runHashTtlS: 3600 });
    f.start();

    // Process ticks at 100 / 200 / 300ms have all seen the run, but age
    // (300ms) < minProcessAgeMs (500ms) — redlock must remain idle.
    await vi.advanceTimersByTimeAsync(300);
    expect(redlock.using).not.toHaveBeenCalled();

    // The tick at ≥500ms sees age ≥ 500ms and clears the gate.
    await vi.advanceTimersByTimeAsync(300); // total 600ms elapsed
    expect(redlock.using).toHaveBeenCalled();

    await f.stop();
  });
});

describe("stop", () => {
  test("releases held slot atomically", async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValue("OK");
    redis.eval.mockResolvedValue(1);
    const { start, stop } = makeFactory({ redis });
    start();
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await stop();
    const lastEval = redis.eval.mock.calls.at(-1) as unknown[];
    expect(lastEval[0]).toContain("del");
    expect(String(lastEval[2])).toContain("cron:slot:");
  });
});
