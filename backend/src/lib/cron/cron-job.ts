import { randomUUID } from "node:crypto";

import { CronExpressionParser } from "cron-parser";
import { Cluster, Redis } from "ioredis";

import { logger } from "@app/lib/logger";
import { Redlock } from "@app/lib/red-lock";

// ── tuning constants ──────────────────────────────────────────────────────────

const PARTICIPANT_SLOTS = 5;
const PROCESS_BATCH_SIZE = 50;
// Safety buffer in `fitsBeforeNextFire`: if the retry's nextAttemptAt is within
// this many ms of the next scheduled fire, treat the run as final and let the
// next fire (separate id) be the natural retry instead.
const NEXT_FIRE_BUFFER_MS = 1_000;
const ERROR_MESSAGE_MAX_LEN = 4_000;

const DEFAULTS = {
  slotTtlMs: 60_000,
  slotRefreshMs: 30_000,
  enqueueIntervalMs: 30_000,
  processIntervalMs: 5_000,
  minProcessAgeMs: 1_000,
  leaseDurationMs: 5 * 60_000,
  handlerTimeoutMs: 5 * 60_000,
  retryBackoffBaseMs: 30_000,
  retryBackoffMaxMs: 5 * 60_000
} as const;

// ── redis schema ──────────────────────────────────────────────────────────────

const SLOT_KEY = (i: number) => `cron:slot:${i}`;
const RUN_KEY = (id: string) => `cron:run:${id}`;
const LEASE_KEY = (id: string) => `cron:lease:${id}`;
const PENDING_ZSET = "cron:pending";

// Run-hash status values. Stored as plain strings in the hash so we don't
// break Redis tooling, but referenced through this object to avoid drift.
const RunStatus = {
  Pending: "pending",
  Running: "running",
  Completed: "completed",
  Failed: "failed"
} as const;

const F = {
  Name: "name",
  Status: "status",
  Attempts: "attempts",
  WorkerId: "worker_id",
  ScheduledAt: "scheduled_at",
  EnqueuedAtMs: "enqueued_at_ms",
  StartedAt: "started_at",
  CompletedAt: "completed_at",
  LastError: "last_error",
  NextAttemptAt: "next_attempt_at"
} as const;

// ── lua scripts ───────────────────────────────────────────────────────────────

// Atomic "enqueue this run hash + zset entry if no other pod beat us to it".
const ENQUEUE_RUN_LUA = `
  if redis.call('exists', KEYS[1]) == 0 then
    redis.call('hset', KEYS[1],
      'name', ARGV[1],
      'scheduled_at', ARGV[2],
      'status', 'pending',
      'attempts', 0,
      'enqueued_at_ms', ARGV[5])
    redis.call('expire', KEYS[1], ARGV[3])
    redis.call('zadd', KEYS[2], ARGV[2], ARGV[4])
    return 1
  end
  return 0
`;

// "DEL only if I still own this slot". Stops a stale stop() call from
// accidentally evicting the new owner after our TTL expired.
const RELEASE_SLOT_IF_MINE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

// ── types ─────────────────────────────────────────────────────────────────────

type Handler = (signal: AbortSignal) => Promise<void>;
type CronEntry = { name: string; pattern: string; maxAttempts: number; handler: Handler; runHashTtlS: number };

export type TCronJobFactory = ReturnType<typeof cronJobFactory>;

// ── factory ───────────────────────────────────────────────────────────────────

export const cronJobFactory = ({
  redis,
  redlock,
  slotTtlMs = DEFAULTS.slotTtlMs,
  slotRefreshMs = DEFAULTS.slotRefreshMs,
  enqueueIntervalMs = DEFAULTS.enqueueIntervalMs,
  processIntervalMs = DEFAULTS.processIntervalMs,
  minProcessAgeMs = DEFAULTS.minProcessAgeMs,
  leaseDurationMs = DEFAULTS.leaseDurationMs,
  handlerTimeoutMs = DEFAULTS.handlerTimeoutMs,
  retryBackoffBaseMs = DEFAULTS.retryBackoffBaseMs,
  retryBackoffMaxMs = DEFAULTS.retryBackoffMaxMs
}: {
  redis: Redis | Cluster;
  redlock: Redlock;
  slotTtlMs?: number;
  slotRefreshMs?: number;
  enqueueIntervalMs?: number;
  processIntervalMs?: number;
  minProcessAgeMs?: number;
  leaseDurationMs?: number;
  handlerTimeoutMs?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
}) => {
  const workerId = randomUUID();
  const entries = new Map<string, CronEntry>();
  const lastEnqueuedAt = new Map<string, number>();
  let slotTimer: ReturnType<typeof setInterval> | null = null;
  let enqueueTimer: ReturnType<typeof setInterval> | null = null;
  let processTimer: ReturnType<typeof setInterval> | null = null;
  let currentSlot: number | null = null;

  // ── helpers ────────────────────────────────────────────────────────────

  const prevFireMs = (pattern: string) => CronExpressionParser.parse(pattern, { tz: "UTC" }).prev().toDate().getTime();

  const nextFireMs = (pattern: string) => CronExpressionParser.parse(pattern, { tz: "UTC" }).next().toDate().getTime();

  const shuffleInPlace = <T>(arr: T[]): void => {
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      // eslint-disable-next-line no-param-reassign
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  };

  // Races `task` against a timeout. If the timeout wins, aborts `ac` (so
  // well-behaved handlers can short-circuit network calls) and rejects with a
  // descriptive error. Used for HANG recovery — see executeUnderLease for the
  // two-knob recovery model that justifies racing on top of redlock.using.
  const withTimeout = async (task: (signal: AbortSignal) => Promise<void>, ac: AbortController, timeoutMs: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error(`handler exceeded ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      await Promise.race([task(ac.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // ── run-hash status writes ──────────────────────────────────────────────────

  const markRunning = (id: string, attempt: number) =>
    redis.hset(
      RUN_KEY(id),
      F.Status,
      RunStatus.Running,
      F.WorkerId,
      workerId,
      F.StartedAt,
      String(Date.now()),
      F.Attempts,
      String(attempt)
    );

  const markCompleted = async (id: string) => {
    await redis.hset(RUN_KEY(id), F.Status, RunStatus.Completed, F.CompletedAt, String(Date.now()));
    await redis.zrem(PENDING_ZSET, id);
  };

  // `err` is optional: the max-attempts-reached path writes a "failed" status
  // without a last_error.
  const markFailedFinal = async (id: string, err?: unknown) => {
    if (err === undefined) {
      await redis.hset(RUN_KEY(id), F.Status, RunStatus.Failed, F.CompletedAt, String(Date.now()));
    } else {
      await redis.hset(
        RUN_KEY(id),
        F.Status,
        RunStatus.Failed,
        F.LastError,
        String(err).slice(0, ERROR_MESSAGE_MAX_LEN),
        F.CompletedAt,
        String(Date.now())
      );
    }
    await redis.zrem(PENDING_ZSET, id);
  };

  const markPendingRetry = async (id: string, err: unknown, nextAttemptAt: number) => {
    await redis.hset(
      RUN_KEY(id),
      F.Status,
      RunStatus.Pending,
      F.LastError,
      String(err).slice(0, ERROR_MESSAGE_MAX_LEN),
      F.NextAttemptAt,
      String(nextAttemptAt)
    );
    // zset score = next_attempt_at so processTick's zrangebyscore filter skips
    // this run until its backoff window elapses.
    await redis.zadd(PENDING_ZSET, nextAttemptAt, id);
  };

  // ── registration ────────────────────────────────────────────────────────────

  // Registers a cron entry with this pod. `runHashTtlS` controls how long each
  // run's hash lives in Redis after enqueue.
  const register = ({
    name,
    pattern,
    handler,
    runHashTtlS,
    maxAttempts = 3,
    enabled = true
  }: {
    name: string;
    pattern: string;
    handler: Handler;
    runHashTtlS: number;
    maxAttempts?: number;
    enabled?: boolean;
  }) => {
    if (!enabled) {
      logger.info(`cron[${name}]: disabled`);
      return;
    }
    if (entries.has(name)) throw new Error(`cron[${name}] already registered`);
    CronExpressionParser.parse(pattern, { tz: "UTC" }); // validate at registration
    entries.set(name, { name, pattern, maxAttempts, handler, runHashTtlS });
    logger.info(`cron[${name}]: registered (pattern="${pattern}")`);
  };

  // ── slot election ───────────────────────────────────────────────────────────

  // Caps the number of pods that participate in cron ticking. Each pod holds
  // one of N slots via SET NX/XX with a short TTL: refreshes its own slot if
  // it still owns one, otherwise tries to claim a free slot.
  const claimOrRefreshSlot = async () => {
    if (currentSlot !== null) {
      const ok = await redis.set(SLOT_KEY(currentSlot), workerId, "PX", slotTtlMs, "XX");
      if (ok) return;
      logger.info(`cron: lost slot ${currentSlot} [worker=${workerId}]`);
      currentSlot = null;
    }
    for (let i = 0; i < PARTICIPANT_SLOTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const got = await redis.set(SLOT_KEY(i), workerId, "PX", slotTtlMs, "NX");
      if (got) {
        currentSlot = i;
        logger.info(`cron: claimed slot ${i} [worker=${workerId}]`);
        return;
      }
    }
  };

  // ── enqueue ─────────────────────────────────────────────────────────────────

  // For each registered entry, computes the most recent scheduled fire time
  // and atomically inserts a run hash + pending-zset entry if not already
  // present. The Lua script makes the existence check + write a single op so
  // multiple pods racing to enqueue the same fire produce exactly one run.
  const enqueueDueFires = async () => {
    for (const entry of entries.values()) {
      const scheduledAt = prevFireMs(entry.pattern);
      // eslint-disable-next-line no-continue
      if (lastEnqueuedAt.get(entry.name) === scheduledAt) continue;

      const id = `${entry.name}:${scheduledAt}`;
      // eslint-disable-next-line no-await-in-loop
      const initialized = await redis.eval(
        ENQUEUE_RUN_LUA,
        2,
        RUN_KEY(id),
        PENDING_ZSET,
        entry.name,
        String(scheduledAt),
        String(entry.runHashTtlS),
        id,
        String(Date.now())
      );
      if (initialized)
        logger.info(
          `cron[${entry.name}]: enqueued run [id=${id}] [scheduled_at=${new Date(scheduledAt).toISOString()}]`
        );
      lastEnqueuedAt.set(entry.name, scheduledAt);
    }
  };

  // Slow timer (~30s) that only creates run hashes for due fires. Split from
  // processing so the pod that enqueues doesn't immediately consume everything
  // it just created — leaves time for other slot-holders' process ticks to race.
  const enqueueTick = async () => {
    if (currentSlot === null) return;
    await enqueueDueFires();
  };

  // ── process ─────────────────────────────────────────────────────────────────

  // Executes one attempt of `entry` under an already-acquired redlock. Wires
  // up the AbortController, writes the running state, races the handler
  // against handlerTimeoutMs, and branches into success / retry / final
  // failure on completion.
  //
  // Two-knob recovery model:
  //   leaseDurationMs  → governs CRASH recovery. When the holder pod dies,
  //                      its lease key TTLs out and other pods see the run as
  //                      stalled via the isStalled path in processCandidate.
  //   handlerTimeoutMs → governs HANG recovery. When a handler wedges in a
  //                      live pod, redlock would auto-extend the lease
  //                      forever. The withTimeout race fires ac.abort() after
  //                      handlerTimeoutMs and rejects, so the catch runs,
  //                      status flips back to pending, and redlock.using
  //                      releases the lease on return.
  const executeUnderLease = async (entry: CronEntry, id: string, attempt: number, leaseSignal: AbortSignal) => {
    const ac = new AbortController();
    leaseSignal.addEventListener?.("abort", () => ac.abort());

    await markRunning(id, attempt);
    const startMs = Date.now();
    logger.info(`cron[${entry.name}]: start (attempt ${attempt}/${entry.maxAttempts}) [id=${id}]`);

    try {
      await withTimeout((sig) => entry.handler(sig), ac, handlerTimeoutMs);
      await markCompleted(id);
      logger.info(`cron[${entry.name}]: complete [id=${id}] [duration_ms=${Date.now() - startMs}]`);
    } catch (err) {
      // Exponential backoff: 1×, 2×, 4× ... capped at retryBackoffMaxMs.
      const backoffMs = Math.min(retryBackoffBaseMs * 2 ** (attempt - 1), retryBackoffMaxMs);
      const nextAttemptAt = Date.now() + backoffMs;
      // If the retry wouldn't fit before the next scheduled fire, treat this
      // run as final — the upcoming fire (separate id) is the natural retry.
      // Avoids overlapping attempts of the same cron and avoids squashing
      // backoff to ~0 near the end of an interval.
      const fitsBeforeNextFire = nextAttemptAt + NEXT_FIRE_BUFFER_MS < nextFireMs(entry.pattern);
      const final = attempt >= entry.maxAttempts || !fitsBeforeNextFire;

      if (final) await markFailedFinal(id, err);
      else await markPendingRetry(id, err, nextAttemptAt);

      logger.error(
        { err },
        `cron[${entry.name}]: attempt ${attempt} failed (${final ? "giving up" : "will retry"}) [id=${id}]`
      );
    }
  };

  // Inspects one pending zset id: validates the run hash, applies the
  // min-age and max-attempts gates, and races for the lease. Anything that
  // can be decided without taking a lock is decided here so we only ever
  // hand a "ready, attempt-eligible" run to executeUnderLease.
  const processCandidate = async (id: string) => {
    const data = await redis.hgetall(RUN_KEY(id));
    if (!data?.name) {
      // Hash expired (TTL) but zset entry lingered; clean up.
      await redis.zrem(PENDING_ZSET, id);
      return;
    }

    const entry = entries.get(data.name);
    if (!entry) return; // not handled on this pod

    const isPending = data.status === RunStatus.Pending;
    const isStalled = data.status === RunStatus.Running && (await redis.exists(LEASE_KEY(id))) === 0;
    if (!isPending && !isStalled) return;

    // Min-age delay on first pickup so the pod that enqueued doesn't
    // immediately grab everything before other slot-holders' process ticks
    // fire. Stalled runs bypass this — they're already past first pickup.
    if (isPending) {
      const enqueuedAtMs = Number(data[F.EnqueuedAtMs] ?? 0);
      if (Date.now() - enqueuedAtMs < minProcessAgeMs) return;
    }

    const attempts = Number(data.attempts ?? 0);
    if (attempts >= entry.maxAttempts) {
      await markFailedFinal(id);
      logger.error(`cron[${data.name}]: max attempts reached [id=${id}]`);
      return;
    }

    if (isStalled) {
      logger.info(`cron[${data.name}]: re-claiming stalled run [id=${id}] [previous_worker=${data.worker_id}]`);
    }

    try {
      await redlock.using([LEASE_KEY(id)], leaseDurationMs, (signal) =>
        executeUnderLease(entry, id, attempts + 1, signal as AbortSignal)
      );
    } catch {
      // Lock contention — another pod is executing this run; move on.
    }
  };

  // Fast timer (~5s) that scans the pending zset and races for runs to
  // execute. Ids are shuffled per tick so different slot-holders try
  // different ids first, spreading lease contention and distributing handler
  // load across pods.
  const processTick = async () => {
    if (currentSlot === null) return;

    // Filter by zset score so backed-off retries (score = next_attempt_at)
    // are skipped until their backoff window elapses.
    const ids = await redis.zrangebyscore(PENDING_ZSET, "-inf", Date.now(), "LIMIT", 0, PROCESS_BATCH_SIZE);
    shuffleInPlace(ids);

    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      await processCandidate(id);
    }
  };

  // ── lifecycle ───────────────────────────────────────────────────────────────

  // Starts the slot-refresh, enqueue, and process timers, and claims a slot
  // immediately so the pod doesn't wait a full `slotRefreshMs` before
  // participating.
  const start = () => {
    slotTimer = setInterval(() => {
      void claimOrRefreshSlot();
    }, slotRefreshMs);
    enqueueTimer = setInterval(() => {
      void enqueueTick();
    }, enqueueIntervalMs);
    processTimer = setInterval(() => {
      void processTick();
    }, processIntervalMs);
    void claimOrRefreshSlot();
  };

  // Stops the timers and atomically releases the held slot (only if we still
  // own it) so another pod can take over without waiting for the slot TTL.
  const stop = async () => {
    if (slotTimer) clearInterval(slotTimer);
    if (enqueueTimer) clearInterval(enqueueTimer);
    if (processTimer) clearInterval(processTimer);
    if (currentSlot !== null) {
      await redis.eval(RELEASE_SLOT_IF_MINE_LUA, 1, SLOT_KEY(currentSlot), workerId);
      logger.info(`cron: released slot ${currentSlot} [worker=${workerId}]`);
    }
  };

  return { register, start, stop };
};
