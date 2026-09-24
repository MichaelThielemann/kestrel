import { hostname } from "node:os";
import type { EventData } from "@michaelthielemann/kestrel-contracts/events";
import { relaySummary, type DeliveryStatus, type RelayEntry, type RelayReport } from "@michaelthielemann/kestrel-contracts/events.steps";
import type { Document, Persistence, PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";
import type { EventEntry } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import type { Runner } from "@michaelthielemann/kestrel/runner";

export const QUEUE = "events_queue";

export type QueueState = "pending" | "running" | "done" | "dead";

export interface QueueRow extends Document {
  name: string;
  payload: EventData;
  /** The one pipeline this row delivers to; `null` means the row is not fanned out to a pipeline yet. */
  pipeline: string | null;
  state: QueueState;
  attempts: number;
  createdAt: number;
  availableAt: number;
  lockedAt: number | null;
  lockedBy: string | null;
  finishedAt: number | null;
  error: string | null;
  /** The run whose `events.emit` wrote this row; `null` for a row raised through `events@1` outside a pipeline. */
  runId: string | null;
}

export interface Config {
  pollMs: number;
  batch: number;
  maxAttempts: number;
  backoffSeconds: number[];
  lockTtlSeconds: number;
  retentionDays: number;
  /** How long `events.relay` may spend delivering this run's rows before it is the worker's turn. */
  relayMs: number;
  /** Pipelines whose rows the relay claims and delivers in the request; `"all"` (the default) means every subscribed pipeline. A row of a pipeline left out gets no head start and is reported `queued`. */
  relayPipelines: string[] | "all";
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
  /** The pipeline this row failed to deliver to; `""` when the row names no pipeline. */
  pipeline: string;
  attempts: number;
  error: string;
  createdAt: number;
  availableAt: number;
  /** The run this row's event came from; `""` when the row names none. */
  runId: string;
}

export interface EventsQueue {
  /** Writes one row per pipeline subscribed to `name`; throws QueueWriteError` on a failed insert. */
  enqueue(name: string, data: EventData): Promise<void>;
  /** Installs the event -> subscribed pipelines table and the function that runs one. */
  setDelivery(entries: readonly EventEntry[], run: Runner): void;
  /** Copies every unfanned row (`pipeline: null`) to one row per currently subscribed pipeline. Returns how many were fanned out. */
  fanOutUnfanned(): Promise<number>;
  status(): Promise<Result<QueueStatus, PersistenceError>>;
  /** The dead-letter rows across every process: deliveries this module gave up on. */
  deliveryStatus(): Promise<Result<DeliveryStatus, PersistenceError>>;
  listDead(limit: number): Promise<Result<{ items: DeadEntry[] }, PersistenceError>>;
  retryDead(id: string): Promise<Result<{ retried: number }, PersistenceError>>;
  purgeDone(): Promise<Result<{ removed: number }, PersistenceError>>;
  /** Processes one batch: fans out unfanned rows, reclaims expired locks, claims due rows, runs one pipeline per row. Returns how many rows it handled. */
  tick(): Promise<number>;
  startWorker(): void;
  stopWorker(): Promise<void>;
  workerRunning(): boolean;
  /** Delivers the rows this run enqueued, in place of the worker, within `relayMs`. Never throws. */
  relay(runId: string): Promise<RelayReport>;
}

/** `enqueue` rejects with this when a row could not be written; the emit step turns it into the persistence error. */
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
  return error instanceof Error ? error.message : String(error);
}

export async function createEventsQueue(config: Config, deps: QueueDeps): Promise<EventsQueue> {
  const { db, logger } = deps;
  const now = deps.now ?? Date.now;
  const instanceId = deps.instanceId ?? `${process.pid}@${hostname()}`;
  let delivery: { table: Map<string, string[]>; run: Runner } | undefined;
  const ensured = await db.ensureCollection(QUEUE, {
    name: "string",
    payload: "json",
    pipeline: "string",
    state: "string",
    attempts: "number",
    createdAt: "number",
    availableAt: "number",
    lockedAt: "number",
    lockedBy: "string",
    finishedAt: "number",
    error: "string",
    runId: "string",
  });
  if (isErr(ensured)) throw new Error(`events/queue: cannot create the queue collection: ${ensured.error.message}`);

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let ticking: Promise<number> | undefined;
  let lastTickAt: number | null = null;
  const pendingRelays = new Map<string, { ids: string[]; queued: RelayEntry[]; at: number }>();

  function relayEligible(pipeline: string | null): boolean {
    if (config.relayPipelines === "all") return true;
    return pipeline !== null && config.relayPipelines.includes(pipeline);
  }

  async function runRow(row: QueueRow): Promise<string | undefined> {
    if (!delivery) return "events/queue: no delivery installed yet";
    if (!row.pipeline) return "events/queue: row names no pipeline";
    const runId = typeof row.payload.runId === "string" ? row.payload.runId : undefined;
    const res = await delivery.run(row.pipeline, { trigger: { kind: "event", name: row.name }, payload: row.payload, ...(runId === undefined ? {} : { parentRunId: runId }) });
    if (res.status >= 400) return res.error ?? res.code ?? `status ${res.status}`;
    return undefined;
  }

  async function settle(row: QueueRow, error: string | undefined): Promise<void> {
    const at = now();
    const patch: Partial<Omit<QueueRow, "id">> = { lockedAt: null, lockedBy: null };
    if (error === undefined) Object.assign(patch, { state: "done", finishedAt: at, error: null });
    else {
      const attempts = row.attempts + 1;
      if (attempts >= config.maxAttempts) {
        Object.assign(patch, { state: "dead", attempts, finishedAt: at, error });
        logger.error("events/queue: event moved to dead-letter", { id: row.id, event: row.name, pipeline: row.pipeline, attempts, error });
      } else {
        const backoff = config.backoffSeconds[Math.min(attempts - 1, config.backoffSeconds.length - 1)] ?? 0;
        Object.assign(patch, { state: "pending", attempts, availableAt: at + backoff * 1000, error });
        logger.error("events/queue: handler failed, will retry", { id: row.id, event: row.name, pipeline: row.pipeline, attempts, retryInSeconds: backoff, error });
      }
    }
    const updated = await db.updateOne<QueueRow>(QUEUE, row.id, patch);
    if (isErr(updated)) logger.error("events/queue: cannot record the outcome, the lock expires and the event runs again", { id: row.id, error: updated.error.message });
  }

  async function fanOutUnfanned(): Promise<number> {
    if (!delivery) return 0;
    const stale = await db.findMany<QueueRow>(QUEUE, { pipeline: null, state: { in: ["pending", "running"] } }, { sort: { createdAt: "asc" }, limit: config.batch });
    if (isErr(stale)) {
      logger.error("events/queue: cannot list unfanned rows", { error: stale.error.message });
      return 0;
    }
    let fanned = 0;
    let dropped = 0;
    for (const row of stale.value.items) {
      const pipelines = delivery.table.get(row.name) ?? [];
      if (pipelines.length === 0) {
        const deleted = await db.deleteOne(QUEUE, row.id);
        if (isErr(deleted)) {
          logger.error("events/queue: cannot drop an unfanned row nobody subscribes to, retrying next tick", { id: row.id, error: deleted.error.message });
          continue;
        }
        dropped++;
        continue;
      }
      let allPresent = true;
      for (const pipeline of pipelines) {
        const created = await db.createOne<QueueRow>(QUEUE, { id: `${row.id}:${pipeline}`, name: row.name, payload: row.payload, pipeline, state: "pending", attempts: 0, createdAt: row.createdAt, availableAt: now(), lockedAt: null, lockedBy: null, finishedAt: null, error: null, runId: row.runId });
        if (isErr(created) && created.error.code !== "CONFLICT") {
          allPresent = false;
          logger.error("events/queue: cannot fan out a stored event, leaving the original for the next tick", { id: row.id, event: row.name, pipeline, error: created.error.message });
          break;
        }
      }
      if (!allPresent) continue;
      const deleted = await db.deleteOne(QUEUE, row.id);
      if (isErr(deleted)) {
        logger.error("events/queue: fanned out a stored event but could not delete the original", { id: row.id, error: deleted.error.message });
        continue;
      }
      fanned++;
    }
    if (fanned > 0) logger.info(`events/queue: fanned out ${fanned} stored events`);
    if (dropped > 0) logger.info(`events/queue: dropped ${dropped} stored events no pipeline subscribes to`);
    return fanned;
  }

  async function claim(): Promise<QueueRow[]> {
    if (!delivery) return [];
    const at = now();
    const expired = await db.updateMany<QueueRow>(QUEUE, { state: "running", lockedAt: { lte: at - config.lockTtlSeconds * 1000 } }, { state: "pending", lockedAt: null, lockedBy: null });
    if (isErr(expired)) throw new Error(expired.error.message);
    if (expired.value > 0) logger.info("events/queue: reclaimed expired locks", { count: expired.value });
    const due = await db.findMany<QueueRow>(QUEUE, { state: "pending", pipeline: { ne: null }, availableAt: { lte: at } }, { sort: { availableAt: "asc", createdAt: "asc" }, limit: config.batch });
    if (isErr(due)) throw new Error(due.error.message);
    const claimed: QueueRow[] = [];
    for (const row of due.value.items) {
      const won = await db.updateMany<QueueRow>(QUEUE, { id: row.id, state: "pending" }, { state: "running", lockedAt: at, lockedBy: instanceId });
      if (isErr(won) || won.value !== 1) continue;
      claimed.push({ ...row, state: "running", lockedAt: at, lockedBy: instanceId });
    }
    return claimed;
  }

  function sweepPendingRelays(): void {
    const at = now();
    for (const [runId, entry] of pendingRelays) if (at - entry.at > config.lockTtlSeconds * 1000) pendingRelays.delete(runId);
  }

  async function tickOnce(): Promise<number> {
    lastTickAt = now();
    sweepPendingRelays();
    await fanOutUnfanned();
    const rows = await claim();
    for (const row of rows) await settle(row, await runRow(row));
    return rows.length;
  }

  async function claimForRelay(row: QueueRow, at: number): Promise<boolean> {
    const won = await db.updateMany<QueueRow>(QUEUE, { id: row.id, state: "pending" }, { state: "running", lockedAt: at, lockedBy: instanceId });
    return !isErr(won) && won.value === 1;
  }

  function relayEntryOf(row: QueueRow, error: string | undefined): RelayEntry {
    if (error === undefined) return { event: row.name, pipeline: row.pipeline ?? "", status: "done", attempts: row.attempts, dead: false, error: null };
    const attempts = row.attempts + 1;
    return { event: row.name, pipeline: row.pipeline ?? "", status: "error", attempts, dead: attempts >= config.maxAttempts, error };
  }

  function pendingEntryOf(row: QueueRow): RelayEntry {
    return { event: row.name, pipeline: row.pipeline ?? "", status: "pending", attempts: row.attempts, dead: false, error: null };
  }

  async function relay(runId: string): Promise<RelayReport> {
    const entry = pendingRelays.get(runId);
    pendingRelays.delete(runId);
    if (!entry) return { status: "done", pipelines: [] };
    if (entry.ids.length === 0) return { status: relaySummary(entry.queued), pipelines: entry.queued };
    try {
      const relayStartedAt = now();
      const found = await db.findMany<QueueRow>(QUEUE, { id: { in: entry.ids } });
      if (isErr(found)) {
        logger.error("events/queue: relay could not load its rows", { error: found.error.message });
        const pipelines = [...entry.queued, ...entry.ids.map(() => ({ event: "", pipeline: "", status: "pending" as const, attempts: 0, dead: false, error: null }))];
        return { status: relaySummary(pipelines), pipelines };
      }
      const pipelines: RelayEntry[] = [...entry.queued];
      for (const row of found.value.items) {
        if (now() - relayStartedAt >= config.relayMs) {
          pipelines.push(pendingEntryOf(row));
          continue;
        }
        try {
          const at = now();
          if (!(await claimForRelay(row, at))) {
            pipelines.push(pendingEntryOf(row));
            continue;
          }
          const claimed: QueueRow = { ...row, state: "running", lockedAt: at, lockedBy: instanceId };
          const error = await runRow(claimed);
          await settle(claimed, error);
          pipelines.push(relayEntryOf(row, error));
        } catch (error) {
          logger.error("events/queue: relay could not deliver a row", { id: row.id, error: errorText(error) });
          pipelines.push(pendingEntryOf(row));
        }
      }
      return { status: relaySummary(pipelines), pipelines };
    } catch (error) {
      logger.error("events/queue: relay could not load its rows", { error: errorText(error) });
      const pipelines = [...entry.queued, ...entry.ids.map(() => ({ event: "", pipeline: "", status: "pending" as const, attempts: 0, dead: false, error: null }))];
      return { status: relaySummary(pipelines), pipelines };
    }
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
    async enqueue(name, data) {
      const at = now();
      const runId = typeof data.runId === "string" ? data.runId : null;
      const pipelines = delivery?.table.get(name);
      if (delivery && (!pipelines || pipelines.length === 0)) return;
      const targets = pipelines ?? [null];
      const ids: string[] = [];
      const queued: RelayEntry[] = [];
      for (const pipeline of targets) {
        const eligible = runId !== null && relayEligible(pipeline);
        const availableAt = eligible ? at + config.relayMs : at;
        const created = await db.createOne<QueueRow>(QUEUE, { name, payload: { ...data }, pipeline, state: "pending", attempts: 0, createdAt: at, availableAt, lockedAt: null, lockedBy: null, finishedAt: null, error: null, runId });
        if (isErr(created)) throw new QueueWriteError(created.error);
        if (eligible) ids.push(created.value.id);
        else if (runId !== null && pipeline !== null) queued.push({ event: name, pipeline, status: "queued", attempts: 0, dead: false, error: null });
      }
      if (runId !== null && (ids.length > 0 || queued.length > 0)) {
        const entry = pendingRelays.get(runId) ?? { ids: [], queued: [], at };
        entry.ids.push(...ids);
        entry.queued.push(...queued);
        pendingRelays.set(runId, entry);
      }
    },
    setDelivery(entries, run) {
      const table = new Map<string, string[]>();
      for (const entry of entries) {
        const list = table.get(entry.event) ?? [];
        list.push(entry.pipeline);
        table.set(entry.event, list);
      }
      delivery = { table, run };
    },
    fanOutUnfanned,
    async status() {
      const at = now();
      const counts = await Promise.all([db.count(QUEUE, { state: "pending" }), db.count(QUEUE, { state: "running" }), db.count(QUEUE, { state: "dead" }), db.count(QUEUE, { state: "done", finishedAt: { gte: at - DAY_MS } })]);
      for (const c of counts) if (isErr(c)) return c;
      const oldest = await db.findMany<QueueRow>(QUEUE, { state: "pending" }, { sort: { availableAt: "asc" }, limit: 1 });
      if (isErr(oldest)) return oldest;
      const [pendingCount, runningCount, deadCount, done24hCount] = counts;
      const pending = pendingCount.ok ? pendingCount.value : 0;
      const running_ = runningCount.ok ? runningCount.value : 0;
      const dead = deadCount.ok ? deadCount.value : 0;
      const done24h = done24hCount.ok ? done24hCount.value : 0;
      return ok({ pending, running: running_, dead, done24h, oldestPendingAt: oldest.value.items[0]?.availableAt ?? null, worker: { running, lastTickAt } });
    },
    async deliveryStatus() {
      const dead = await db.count(QUEUE, { state: "dead" });
      if (isErr(dead)) return dead;
      const newest = await db.findMany<QueueRow>(QUEUE, { state: "dead" }, { sort: { finishedAt: "desc" }, limit: 1 });
      if (isErr(newest)) return newest;
      return ok({ dead: dead.value, scope: "store", since: null, lastDeadAt: newest.value.items[0]?.finishedAt ?? null });
    },
    async listDead(limit) {
      const page = await db.findMany<QueueRow>(QUEUE, { state: "dead" }, { sort: { finishedAt: "desc" }, limit });
      if (isErr(page)) return page;
      return ok({ items: page.value.items.map((r) => ({ id: r.id, name: r.name, pipeline: r.pipeline ?? "", attempts: r.attempts, error: r.error ?? "", createdAt: r.createdAt, availableAt: r.availableAt, runId: r.runId ?? "" })) });
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
    relay,
  };
}

export function retryTarget(arg: string): "all" | "one" {
  if (arg === "all" || arg === "one") return arg;
  throw new Error(`events/queue: retryDead takes "all" or "one", got "${arg}"`);
}

export function persistenceFailure(error: unknown): PersistenceError | undefined {
  return error instanceof QueueWriteError ? error.failure : undefined;
}
