import { hostname } from "node:os";
import type { EventData, EventHandler, Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Document, Persistence, PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { isErr, ok, type Result } from "@michaelthielemann/kestrel/result";

export const QUEUE = "events_queue";

export type QueueState = "pending" | "running" | "done" | "dead";

export interface QueueRow extends Document {
  name: string;
  payload: EventData;
  state: QueueState;
  attempts: number;
  createdAt: number;
  availableAt: number;
  lockedAt: number | null;
  lockedBy: string | null;
  finishedAt: number | null;
  error: string | null;
}

export interface Config {
  pollMs: number;
  batch: number;
  maxAttempts: number;
  backoffSeconds: number[];
  lockTtlSeconds: number;
  retentionDays: number;
}

export interface QueueStatus {
  pending: number;
  running: number;
  dead: number;
  done24h: number;
  oldestPendingAt: number | null;
  worker: { running: boolean; lastTickAt: number | null };
}

export interface DeadEntry {
  id: string;
  name: string;
  attempts: number;
  error: string;
  createdAt: number;
  availableAt: number;
}

export interface EventsQueue extends Events {
  status(): Promise<Result<QueueStatus, PersistenceError>>;
  listDead(limit: number): Promise<Result<{ items: DeadEntry[] }, PersistenceError>>;
  retryDead(id: string): Promise<Result<{ retried: number }, PersistenceError>>;
  purgeDone(): Promise<Result<{ removed: number }, PersistenceError>>;
  /** Processes one batch: reclaims expired locks, claims due rows, runs the handlers. Returns how many rows it handled. */
  tick(): Promise<number>;
  startWorker(): void;
  stopWorker(): Promise<void>;
  workerRunning(): boolean;
}

/** `emit` rejects with this when the row could not be written; the emit step turns it into the persistence error. */
export class QueueWriteError extends Error {
  readonly failure: PersistenceError;
  constructor(failure: PersistenceError) {
    super(`events/queue: cannot persist event: ${failure.message}`);
    this.failure = failure;
  }
}

export interface QueueDeps {
  db: Persistence;
  logger: Logger;
  now?: () => number;
  instanceId?: string;
}

const DAY_MS = 24 * 3600 * 1000;

function errorText(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(errorText).join("; ");
  return error instanceof Error ? error.message : String(error);
}

export async function createEventsQueue(config: Config, deps: QueueDeps): Promise<EventsQueue> {
  const { db, logger } = deps;
  const now = deps.now ?? Date.now;
  const instanceId = deps.instanceId ?? `${process.pid}@${hostname()}`;
  const handlers = new Map<string, Set<EventHandler>>();
  const ensured = await db.ensureCollection(QUEUE, {
    name: "string",
    payload: "json",
    state: "string",
    attempts: "number",
    createdAt: "number",
    availableAt: "number",
    lockedAt: "number",
    lockedBy: "string",
    finishedAt: "number",
    error: "string",
  });
  if (isErr(ensured)) throw new Error(`events/queue: cannot create the queue collection: ${ensured.error.message}`);

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let ticking: Promise<number> | undefined;
  let lastTickAt: number | null = null;

  async function runHandlers(row: QueueRow): Promise<unknown[]> {
    const errors: unknown[] = [];
    const frozen = Object.freeze({ ...row.payload });
    for (const handler of [...(handlers.get(row.name) ?? [])]) {
      try {
        await handler(row.name, frozen);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async function settle(row: QueueRow, errors: unknown[]): Promise<void> {
    const at = now();
    const patch: Partial<Omit<QueueRow, "id">> = { lockedAt: null, lockedBy: null };
    if (errors.length === 0) Object.assign(patch, { state: "done", finishedAt: at, error: null });
    else {
      const attempts = row.attempts + 1;
      const message = errorText(errors.length === 1 ? errors[0] : new AggregateError(errors));
      if (attempts >= config.maxAttempts) {
        Object.assign(patch, { state: "dead", attempts, finishedAt: at, error: message });
        logger.error("events/queue: event moved to dead-letter", { id: row.id, event: row.name, attempts, error: message });
      } else {
        const backoff = config.backoffSeconds[Math.min(attempts - 1, config.backoffSeconds.length - 1)] ?? 0;
        Object.assign(patch, { state: "pending", attempts, availableAt: at + backoff * 1000, error: message });
        logger.error("events/queue: handler failed, will retry", { id: row.id, event: row.name, attempts, retryInSeconds: backoff, error: message });
      }
    }
    const updated = await db.updateOne<QueueRow>(QUEUE, row.id, patch);
    if (isErr(updated)) logger.error("events/queue: cannot record the outcome, the lock expires and the event runs again", { id: row.id, error: updated.error.message });
  }

  async function claim(): Promise<QueueRow[]> {
    const at = now();
    const expired = await db.updateMany<QueueRow>(QUEUE, { state: "running", lockedAt: { lte: at - config.lockTtlSeconds * 1000 } }, { state: "pending", lockedAt: null, lockedBy: null });
    if (isErr(expired)) throw new Error(expired.error.message);
    if (expired.value > 0) logger.info("events/queue: reclaimed expired locks", { count: expired.value });
    const due = await db.findMany<QueueRow>(QUEUE, { state: "pending", availableAt: { lte: at } }, { sort: { availableAt: "asc", createdAt: "asc" }, limit: config.batch });
    if (isErr(due)) throw new Error(due.error.message);
    const claimed: QueueRow[] = [];
    for (const row of due.value.items) {
      const locked = await db.updateOne<QueueRow>(QUEUE, row.id, { state: "running", lockedAt: at, lockedBy: instanceId });
      if (isErr(locked)) continue;
      claimed.push(locked.value);
    }
    return claimed;
  }

  async function tickOnce(): Promise<number> {
    lastTickAt = now();
    const rows = await claim();
    for (const row of rows) await settle(row, await runHandlers(row));
    return rows.length;
  }

  function tick(): Promise<number> {
    if (ticking) return ticking;
    ticking = tickOnce()
      .catch((error: unknown) => {
        logger.error("events/queue: worker tick failed", { error: errorText(error) });
        return 0;
      })
      .finally(() => {
        ticking = undefined;
      });
    return ticking;
  }

  function schedule(delay: number): void {
    if (!running) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick().then((handled) => schedule(handled >= config.batch ? 0 : config.pollMs));
    }, delay);
    timer.unref();
  }

  return {
    async emit(name, data) {
      const at = now();
      const created = await db.createOne<QueueRow>(QUEUE, { name, payload: { ...data }, state: "pending", attempts: 0, createdAt: at, availableAt: at, lockedAt: null, lockedBy: null, finishedAt: null, error: null });
      if (isErr(created)) throw new QueueWriteError(created.error);
    },
    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    async status() {
      const at = now();
      const counts = await Promise.all([db.count(QUEUE, { state: "pending" }), db.count(QUEUE, { state: "running" }), db.count(QUEUE, { state: "dead" }), db.count(QUEUE, { state: "done", finishedAt: { gte: at - DAY_MS } })]);
      for (const c of counts) if (isErr(c)) return c;
      const oldest = await db.findMany<QueueRow>(QUEUE, { state: "pending" }, { sort: { availableAt: "asc" }, limit: 1 });
      if (isErr(oldest)) return oldest;
      const [pending, running_, dead, done24h] = counts.map((c) => (c.ok ? c.value : 0)) as [number, number, number, number];
      return ok({ pending, running: running_, dead, done24h, oldestPendingAt: oldest.value.items[0]?.availableAt ?? null, worker: { running, lastTickAt } });
    },
    async listDead(limit) {
      const page = await db.findMany<QueueRow>(QUEUE, { state: "dead" }, { sort: { finishedAt: "desc" }, limit });
      if (isErr(page)) return page;
      return ok({ items: page.value.items.map((r) => ({ id: r.id, name: r.name, attempts: r.attempts, error: r.error ?? "", createdAt: r.createdAt, availableAt: r.availableAt })) });
    },
    async retryDead(id) {
      const patch: Partial<Omit<QueueRow, "id">> = { state: "pending", attempts: 0, availableAt: now(), finishedAt: null, error: null };
      if (id === "all") {
        const retried = await db.updateMany<QueueRow>(QUEUE, { state: "dead" }, patch);
        if (isErr(retried)) return retried;
        return ok({ retried: retried.value });
      }
      const row = await db.findOne<QueueRow>(QUEUE, { id, state: "dead" });
      if (isErr(row)) return row;
      if (!row.value) return ok({ retried: 0 });
      const updated = await db.updateOne<QueueRow>(QUEUE, id, patch);
      if (isErr(updated)) return updated;
      return ok({ retried: 1 });
    },
    async purgeDone() {
      const removed = await db.deleteMany(QUEUE, { state: "done", finishedAt: { lt: now() - config.retentionDays * DAY_MS } });
      if (isErr(removed)) return removed;
      return ok({ removed: removed.value });
    },
    tick,
    startWorker() {
      if (running) return;
      running = true;
      schedule(0);
    },
    async stopWorker() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (ticking) await ticking;
    },
    workerRunning: () => running,
  };
}

export function retryTarget(arg: string): "all" | "one" {
  if (arg === "all" || arg === "one") return arg;
  throw new Error(`events/queue: retryDead takes "all" or "one", got "${arg}"`);
}

export function persistenceFailure(error: unknown): PersistenceError | undefined {
  return error instanceof QueueWriteError ? error.failure : undefined;
}

