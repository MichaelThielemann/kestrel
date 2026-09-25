import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content } from "@michaelthielemann/kestrel-contracts/content";
import { publishedLocale } from "@michaelthielemann/kestrel-contracts/content-locale";
import { err, failure, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Filter } from "@michaelthielemann/kestrel-contracts/query";
import type { Renderer, RenderInput, RenderOutput, RendererError } from "@michaelthielemann/kestrel-contracts/renderer";
import type { Site } from "@michaelthielemann/kestrel-contracts/site";
import { logWarn, type Logger } from "@michaelthielemann/kestrel/logger";
import { observeReads, type ObservedRead } from "@michaelthielemann/kestrel/reads";
import { canonicalJson, normalizeReads, type DependencySpec } from "./dependencies.ts";
import { dependencyPrefix, dependencyRowId, scan, setIdOf, statusIdOf, type DependencyKind, type OutputRef } from "./keys.ts";
import { exportLlms, validateLlmsConfig, type LlmsSource } from "./llms.ts";
import { createBackgroundLoop, type BackgroundLoop, type PassOutcome } from "./loop.ts";
import type { configSchema } from "./module.ts";

export const STATUS = "delivery_publish_status";
export const DEPENDENCIES = "delivery_dependencies";
export const DEPENDENCY_SETS = "delivery_dependency_sets";
export const STATE = "delivery_state";
export const CHANGES = "delivery_changes";

/** Raised through `events@1` for every marked output with `dependencies.render: "events"`; its data carries `coalesceKey`. */
export const OUTPUT_STALE = "delivery.outputStale";
/** Raised through `events@1` by `delivery.requestLlms` with `dependencies.render: "events"`; its data carries `coalesceKey: "llms"`. */
export const LLMS_STALE = "delivery.llmsStale";

export type Config = z.output<typeof configSchema>;
export type TypeConfig = Config["types"][string];
export type DependenciesConfig = Config["dependencies"];

export type State = "live" | "error" | "draft";
export type RowState = State | "deleted";

export type DeliveryError = KestrelError<"TRANSIENT">;

/** A status row as stored. `version` is compared on every status write; `deleted` rows are tombstones and never leave this module. */
export interface StatusRow extends Document {
  type: string;
  docId: string;
  locale: string;
  state: RowState;
  path: string | null;
  /** The blob keys this row's live or error output currently owns; `null` when they are not recorded yet. */
  writtenKeys: string[] | null;
  error: string | null;
  publishedAt: number | null;
  updatedAt: number;
  version: number | null;
  depSet: string | null;
  depCount: number | null;
  staleAt: number | null;
  staleToken: string | null;
  staleRetryAt: number | null;
  staleAttempts: number | null;
  staleError: string | null;
  claimedBy: string | null;
  claimedAt: number | null;
}

/** The publish status of one output (document × locale) as `readStatus` and `_delivery` report it. */
export interface PublishStatus {
  id: string;
  type: string;
  docId: string;
  locale: string;
  state: State;
  path: string | null;
  error: string | null;
  publishedAt: number | null;
  updatedAt: number;
  /** Marked for a re-render because something its last render read changed. */
  stale: boolean;
  staleSince: number | null;
  /** Marked, and the re-render failed `dependencies.maxAttempts` times. */
  staleFailed: boolean;
  staleError: string | null;
  /** How many dependencies the last render recorded; `null` when they are unknown. */
  dependencies: number | null;
}

export interface StaleStatus {
  stale: number;
  failed: number;
  rendering: number;
  unknown: number;
  oldestStaleAt: number | null;
  abandoned: number;
}

export interface OutputTarget {
  type: string;
  docId: string;
  locale: string;
}

export interface Delivery {
  publish(type: string, id: string): Promise<Result<PublishStatus[], DeliveryError>>;
  unpublish(type: string, id: string): Promise<Result<number, DeliveryError>>;
  status(type: string, id: string): Promise<Result<PublishStatus[], DeliveryError>>;
  publishAll(type: string): Promise<Result<{ documents: number; live: number; errors: number }, DeliveryError>>;
  exportLlms(): Promise<Result<{ entries: number; full: boolean }, DeliveryError>>;
  /** Marks every `live` or `error` output whose last render read one of `ids` of `type`, a list `type`'s store now puts one of them in, a link whose path changed, or nothing known. */
  markDependents(type: string, ids: readonly string[]): Promise<Result<{ marked: number }, DeliveryError>>;
  /** Marks every output of a delivered type, creating a marked `draft` row for each document and locale without one. */
  markAll(type: string): Promise<Result<{ marked: number }, DeliveryError>>;
  /** Marks every output of every delivered type when `build` differs from the stored one, then stores it. */
  checkBuild(build: string): Promise<Result<{ changed: boolean; marked: number }, DeliveryError>>;
  /** Renders one marked output under a claim; a failed render answers `Err` after recording the attempt on the row. */
  republishOutput(target: OutputTarget): Promise<Result<{ rendered: boolean; state: State | null }, DeliveryError>>;
  requestLlms(): Promise<Result<void, DeliveryError>>;
  resumeStale(): Promise<Result<{ released: number; swept: number; dispatched: number; aged: number }, DeliveryError>>;
  retryStale(): Promise<Result<{ retried: number }, DeliveryError>>;
  readStaleStatus(): Promise<Result<StaleStatus, DeliveryError>>;
  /** Stops the background loop and waits for the render in progress. */
  close(): Promise<void>;
}

export interface DeliveryDeps {
  content: Content;
  site: Site;
  renderer: Renderer;
  blobs: Blobstore;
  db: Persistence;
  logger: Logger;
  /** Required with `dependencies.render: "events"`. */
  events?: Events | undefined;
}

interface DependencyRow extends Document {
  type: string;
  docId: string;
  locale: string;
  output: string;
  kind: DependencyKind;
  depType: string;
  depId: string | null;
  depLocale: string | null;
  filter: Record<string, unknown> | null;
  rules: Record<string, unknown> | null;
  path: string | null;
}

type SetState = "pending" | "current" | "retired";

interface DependencySet extends Document {
  output: string;
  keys: string[];
  createdAt: number;
  state: SetState | null;
  replaces: string | null;
}

interface ChangeRow extends Document {
  type: string;
  ids: string[];
}

interface StateRow extends Document {
  value: string | null;
  seq: number | null;
  updatedAt: number | null;
}

interface Target {
  state: State;
  path: string | null;
  error: string | null;
}

type SetPlan = { kind: "none" } | { kind: "empty" } | { kind: "known"; reads: ObservedRead[]; rendererReads: ObservedRead[] } | { kind: "failure"; reads: ObservedRead[] };

interface Work {
  renderPath: string | null;
  written: string[];
  set: SetPlan;
  failure: string | null;
}

interface Change {
  type: string;
  ids: readonly string[];
}

interface Flight {
  since: number;
}

interface RenderOutcome {
  status: PublishStatus | null;
  failure: string | null;
}

const PAGE = 100;
const MARK_CHUNK = 200;
const ROW_PAGE = 500;
const LOOP_BATCH = 5;
const RESUME_MIN_AGE_MS = 60_000;
const UNPUBLISH_TRIES = 5;
const LLMS_COALESCE_KEY = "llms";
const SEQUENCE = "changes";
const SEQUENCE_WIDTH = 16;
const SEQUENCE_TRIES = 100;
const CHANGE_PAGE = 200;
const CHANGE_KEEP = 10_000;
const CHANGE_PRUNE_EVERY = 100;
const PATH_CHANGE = "/";
const MARKABLE: RowState[] = ["live", "error"];
const ALL_OUTPUTS: RowState[] = ["live", "error", "draft"];

function isTransientError(error: KestrelError): error is DeliveryError {
  return error.code === "TRANSIENT";
}

function transientOnly(error: KestrelError, source: string): DeliveryError {
  if (!isTransientError(error)) throw new Error(`delivery/static: unexpected ${source} failure ${error.code}: ${error.message}`);
  return error;
}

function transient(message: string): DeliveryError {
  return failure("TRANSIENT", message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readsOf(plan: SetPlan): readonly ObservedRead[] {
  return plan.kind === "known" || plan.kind === "failure" ? plan.reads : [];
}

function sequenceId(n: number): string {
  return String(n).padStart(SEQUENCE_WIDTH, "0");
}

function touches(reads: readonly ObservedRead[] | null, change: Change, self: OutputRef, livePath: string | null): boolean {
  if (change.type === PATH_CHANGE) return livePath !== null && change.ids.includes(livePath);
  const ids = change.type === self.type ? change.ids.filter((id) => id !== self.docId) : change.ids;
  if (change.ids.length > 0 && ids.length === 0) return false;
  if (reads === null) return true;
  return reads.some((read) => read.type === change.type && (read.kind === "type" || read.kind === "query" || ids.length === 0 || ids.includes(read.id)));
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export function keyFor(prefix: string, path: string, extension: string): string {
  const dir = path === "/" ? "" : `${path.slice(1)}/`;
  return `${prefix}${dir}index.${extension}`;
}

/** The reserved path `path` equals or lies under, if any. */
export function reservedMatch(path: string, reservedPaths: readonly string[]): string | undefined {
  return reservedPaths.find((reserved) => path === reserved || path.startsWith(`${reserved}/`));
}

function idExcludes(filter: Record<string, unknown>, id: string): boolean {
  const condition = filter.id;
  if (condition === undefined) return false;
  if (typeof condition === "string") return condition !== id;
  if (isRecord(condition)) {
    if (typeof condition.eq === "string") return condition.eq !== id;
    if (Array.isArray(condition.in)) return !condition.in.includes(id);
  }
  return false;
}

export async function createDeliveryStatic(config: Config, deps: DeliveryDeps, now: () => number = Date.now): Promise<Delivery> {
  const { content, site, renderer, blobs, db, logger } = deps;
  const dependencies = config.dependencies;
  const model = content.model();
  const locales = model.locales ?? [];
  for (const [type, tc] of Object.entries(config.types)) {
    const fields = model.types[type]?.fields;
    if (!fields) throw new Error(`delivery/static: unknown content type "${type}"`);
    for (const f of [tc.slugField, tc.statusField]) if (!(f in fields)) throw new Error(`delivery/static: field "${f}" does not exist on "${type}"`);
  }
  const supported = new Set(renderer.formats());
  for (const f of config.formats) if (!supported.has(f)) throw new Error(`delivery/static: renderer does not support format "${f}" (has ${[...supported].join(", ") || "none"})`);
  validateLlmsConfig(config.llms, model, config.formats);
  if (dependencies.render === "events" && deps.events === undefined) throw new Error('delivery/static: dependencies.render "events" needs an events@1 provider');
  const events = deps.events;

  const prepared = [
    await db.ensureCollection(STATUS, {
      type: "string",
      docId: "string",
      locale: "string",
      state: "string",
      path: "string",
      writtenKeys: "json",
      error: "string",
      publishedAt: "number",
      updatedAt: "number",
      version: "number",
      depSet: "string",
      depCount: "number",
      staleAt: "number",
      staleToken: "string",
      staleRetryAt: "number",
      staleAttempts: "number",
      staleError: "string",
      claimedBy: "string",
      claimedAt: "number",
    }),
    await db.ensureCollection(DEPENDENCIES, { type: "string", docId: "string", locale: "string", output: "string", kind: "string", depType: "string", depId: "string", depLocale: "string", filter: "json", rules: "json", path: "string" }),
    await db.ensureCollection(DEPENDENCY_SETS, { output: "string", keys: "json", createdAt: "number", state: "string", replaces: "string" }),
    await db.ensureCollection(STATE, { value: "string", seq: "number", updatedAt: "number" }),
    await db.ensureCollection(CHANGES, { type: "string", ids: "json" }),
  ];
  for (const p of prepared) if (isErr(p)) throw new Error(`delivery/static: cannot prepare its collections: ${p.error.message}`);
  const versioned = await db.updateMany<StatusRow>(STATUS, { version: null }, { version: 0 });
  if (isErr(versioned)) throw new Error(`delivery/static: cannot give older status rows a version: ${versioned.error.message}`);

  const uploadedAssets = new Set<string>();
  const warnedUnread = new Set<string>();
  const claimTtlMs = dependencies.claimTtlSeconds * 1000;
  let abandoned = 0;
  let llmsRequested = false;
  let stopping = false;
  let loop: BackgroundLoop | undefined;
  const deliveredTypes = Object.keys(config.types);
  const deliveredLocales = locales.length > 0 ? [...locales] : [""];

  const typeConfig = (type: string): TypeConfig => {
    const tc = config.types[type];
    if (!tc) throw new Error(`delivery/static: type "${type}" is not configured for delivery`);
    return tc;
  };
  const dbFailure = (error: KestrelError): DeliveryError => transientOnly(error, "persistence@1");
  const attemptsOf = (row: StatusRow): number => row.staleAttempts ?? 0;
  const backoffMs = (attempts: number): number => (dependencies.backoffSeconds[Math.min(attempts - 1, dependencies.backoffSeconds.length - 1)] ?? 0) * 1000;

  const toPublic = (row: StatusRow): PublishStatus => {
    const marked = row.staleToken !== null;
    return {
      id: row.id,
      type: row.type,
      docId: row.docId,
      locale: row.locale,
      state: row.state === "deleted" ? "draft" : row.state,
      path: row.state === "deleted" ? null : row.path,
      error: row.error,
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
      stale: marked,
      staleSince: marked ? row.staleAt : null,
      staleFailed: marked && attemptsOf(row) >= dependencies.maxAttempts,
      staleError: marked ? row.staleError : null,
      dependencies: row.depSet === null ? null : (row.depCount ?? null),
    };
  };

  const readRow = async (type: string, docId: string, locale: string): Promise<Result<StatusRow | null, DeliveryError>> => {
    const found = await db.findOne<StatusRow>(STATUS, { type, docId, locale });
    if (isErr(found)) return err(dbFailure(found.error));
    return ok(found.value);
  };

  const pagedRows = async (filter: Filter, visit: (rows: StatusRow[]) => Promise<Result<void, DeliveryError>> | Result<void, DeliveryError>): Promise<Result<void, DeliveryError>> => {
    let last: string | undefined;
    for (;;) {
      const page = await db.findMany<StatusRow>(STATUS, last === undefined ? filter : { ...filter, id: { gt: last } }, { sort: { id: "asc" }, limit: ROW_PAGE });
      if (isErr(page)) return err(dbFailure(page.error));
      const visited = await visit(page.value.items);
      if (isErr(visited)) return visited;
      last = page.value.items.at(-1)?.id;
      if (page.value.items.length < ROW_PAGE || last === undefined) return ok();
    }
  };

  const removeKeys = async (keys: readonly string[]): Promise<Result<void, DeliveryError>> => {
    for (const key of keys) {
      const removed = await blobs.remove(key);
      if (isErr(removed)) return err(transientOnly(removed.error, "blobstore@1"));
    }
    return ok();
  };
  const legacyKeysFor = (path: string): string[] => config.formats.map((format) => keyFor(config.prefix, path, format));

  const pathOwned = async (path: string, excludeId?: string): Promise<Result<boolean, DeliveryError>> => {
    const filter: Filter = excludeId === undefined ? { path, state: { in: MARKABLE } } : { path, state: { in: MARKABLE }, id: { ne: excludeId } };
    const owners = await db.count(STATUS, filter);
    if (isErr(owners)) return err(dbFailure(owners.error));
    return ok(owners.value > 0);
  };

  const ownedKeys = async (row: Pick<StatusRow, "id" | "path" | "writtenKeys">): Promise<string[]> => {
    if (row.writtenKeys !== null) return row.writtenKeys;
    if (row.path === null) return [];
    const derived = legacyKeysFor(row.path);
    const recorded = await db.updateMany<StatusRow>(STATUS, { id: row.id, writtenKeys: null }, { writtenKeys: derived });
    if (isErr(recorded)) logger.error("delivery/static: could not record the keys derived for an output with no recorded keys, the next removal derives them again", { id: row.id, error: recorded.error.message });
    return derived;
  };

  const removeStaleKeys = async (path: string, keys: readonly string[], excludeId?: string): Promise<Result<void, DeliveryError>> => {
    if (keys.length === 0) return ok();
    const owned = await pathOwned(path, excludeId);
    if (isErr(owned)) return owned;
    if (owned.value) return ok();
    return removeFiles(path, keys);
  };

  const removeFiles = async (path: string, keys: readonly string[]): Promise<Result<void, DeliveryError>> => {
    const removed = await removeKeys(keys);
    if (isErr(removed)) return removed;
    const recorded = await recordChange(PATH_CHANGE, [path]);
    const marked = await markOwners(path);
    if (isErr(recorded)) return recorded;
    return marked;
  };

  const deleteDependencyRows = async (ids: readonly string[]): Promise<Result<void, DeliveryError>> => {
    for (const chunk of chunks(ids, MARK_CHUNK)) {
      const deleted = await db.deleteMany(DEPENDENCIES, { id: { in: chunk } });
      if (isErr(deleted)) return err(dbFailure(deleted.error));
    }
    return ok();
  };

  const deleteSet = async (setId: string, keepRows: boolean): Promise<Result<void, DeliveryError>> => {
    if (!keepRows) {
      const set = await db.findOne<DependencySet>(DEPENDENCY_SETS, { id: setId });
      if (isErr(set)) return err(dbFailure(set.error));
      if (set.value) {
        const rows = await deleteDependencyRows(set.value.keys);
        if (isErr(rows)) return rows;
      }
    }
    const deleted = await db.deleteMany(DEPENDENCY_SETS, { id: setId });
    if (isErr(deleted)) return err(dbFailure(deleted.error));
    return ok();
  };

  const setState = async (setId: string, state: SetState): Promise<Result<void, DeliveryError>> => {
    const updated = await db.updateMany<DependencySet>(DEPENDENCY_SETS, { id: setId }, { state });
    if (isErr(updated)) return err(dbFailure(updated.error));
    return ok();
  };

  const retireSet = async (setId: string, keepRows: boolean): Promise<Result<void, DeliveryError>> => {
    const retired = await setState(setId, "retired");
    if (isErr(retired)) return retired;
    return deleteSet(setId, keepRows);
  };

  const readSequence = async (): Promise<Result<number, DeliveryError>> => {
    const row = await db.findOne<StateRow>(STATE, { id: SEQUENCE });
    if (isErr(row)) return err(dbFailure(row.error));
    return ok(row.value?.seq ?? 0);
  };

  const nextSequence = async (): Promise<Result<number, DeliveryError>> => {
    for (let tries = 0; tries < SEQUENCE_TRIES; tries++) {
      const row = await db.findOne<StateRow>(STATE, { id: SEQUENCE });
      if (isErr(row)) return err(dbFailure(row.error));
      if (row.value === null) {
        const created = await db.createOne<StateRow>(STATE, { id: SEQUENCE, value: null, seq: 1, updatedAt: null });
        if (!isErr(created)) return ok(1);
        if (created.error.code !== "CONFLICT") return err(dbFailure(created.error));
        continue;
      }
      const current = row.value.seq;
      const bumped = await db.updateMany<StateRow>(STATE, { id: SEQUENCE, seq: current }, { seq: (current ?? 0) + 1 });
      if (isErr(bumped)) return err(dbFailure(bumped.error));
      if (bumped.value === 1) return ok((current ?? 0) + 1);
    }
    return err(transient("delivery/static: the change sequence kept moving – try again"));
  };

  const pruneChanges = async (newest: number): Promise<Result<void, DeliveryError>> => {
    if (newest <= CHANGE_KEEP) return ok();
    const pruned = await db.deleteMany(CHANGES, { id: { lte: sequenceId(newest - CHANGE_KEEP) } });
    if (isErr(pruned)) return err(dbFailure(pruned.error));
    return ok();
  };

  const recordChange = async (type: string, ids: readonly string[]): Promise<Result<void, DeliveryError>> => {
    const seq = await nextSequence();
    if (isErr(seq)) return seq;
    const written = await db.createOne<ChangeRow>(CHANGES, { id: sequenceId(seq.value), type, ids: [...ids] });
    if (isErr(written)) return err(dbFailure(written.error));
    if (seq.value % CHANGE_PRUNE_EVERY === 0) {
      const pruned = await pruneChanges(seq.value);
      if (isErr(pruned)) logger.error("delivery/static: could not prune the change log, the next prune removes the rows", { error: pruned.error.message });
    }
    return ok();
  };

  const logged = (what: string, data: object) => (outcome: Result<void, DeliveryError>): void => {
    if (isErr(outcome)) logger.error(`delivery/static: ${what}`, { ...data, error: outcome.error.message });
  };

  const dispatch = async (rows: readonly StatusRow[]): Promise<Result<void, DeliveryError>> => {
    if (rows.length === 0) return ok();
    if (dependencies.render === "background") {
      loop?.wake();
      return ok();
    }
    for (const row of rows) {
      try {
        await events?.emit(OUTPUT_STALE, { type: row.type, docId: row.docId, locale: row.locale, coalesceKey: statusIdOf(row.type, row.docId, row.locale) });
      } catch (error) {
        return err(transient(`delivery/static: could not queue the re-render of ${row.type}/${row.docId}/${row.locale} (${errorText(error)})`));
      }
    }
    return ok();
  };

  const dispatchToken = async (token: string): Promise<Result<number, DeliveryError>> => {
    let count = 0;
    const walked = await pagedRows({ staleToken: token }, async (rows) => {
      count += rows.length;
      return dispatch(rows);
    });
    if (isErr(walked)) return walked;
    return ok(count);
  };

  const writeMarks = async (ids: readonly string[], states: RowState[]): Promise<Result<string, DeliveryError>> => {
    const token = randomUUID();
    const at = now();
    for (const chunk of chunks([...new Set(ids)], MARK_CHUNK)) {
      const marked = await db.updateMany<StatusRow>(STATUS, { id: { in: chunk }, state: { in: states }, type: { in: deliveredTypes }, locale: { in: deliveredLocales } }, { staleAt: at, staleToken: token, staleRetryAt: at, staleAttempts: 0, staleError: null });
      if (isErr(marked)) return err(dbFailure(marked.error));
    }
    return ok(token);
  };

  const markRows = async (ids: readonly string[], states: RowState[]): Promise<Result<number, DeliveryError>> => {
    if (ids.length === 0) return ok(0);
    const token = await writeMarks(ids, states);
    if (isErr(token)) return token;
    return dispatchToken(token.value);
  };

  const remark = async (rowId: string, output: OutputRef, why: string): Promise<Result<void, DeliveryError>> => {
    const token = await writeMarks([rowId], MARKABLE);
    if (isErr(token)) {
      logger.error(`delivery/static: could not mark an output ${why}`, { ...output, error: token.error.message });
      return err(transient(`delivery/static: could not mark ${output.type}/${output.docId}/${output.locale} ${why} – try again (${token.error.message})`));
    }
    const dispatched = await dispatchToken(token.value);
    if (isErr(dispatched)) logger.error(`delivery/static: marked an output ${why} but could not raise its job; it stays marked and the recovery pass raises it`, { ...output, error: dispatched.error.message });
    return ok();
  };

  const markOwners = async (path: string): Promise<Result<void, DeliveryError>> => {
    const owners = await db.findMany<StatusRow>(STATUS, { path, state: { in: MARKABLE } }, { limit: 10 });
    if (isErr(owners)) return err(dbFailure(owners.error));
    if (owners.value.items.length === 0) return ok();
    const marked = await markRows(owners.value.items.map((row) => row.id), MARKABLE);
    if (isErr(marked)) return marked;
    return ok();
  };

  const writeSet = async (output: OutputRef, outputId: string, renderId: string, specs: DependencySpec[], inherited: string[], replaces: string | null): Promise<{ setId: string; created: string[]; count: number } | null> => {
    const rows: DependencyRow[] = specs.map((spec, n) => ({ id: dependencyRowId(spec, output, renderId, n), type: output.type, docId: output.docId, locale: output.locale, output: outputId, ...spec }));
    const created = rows.map((row) => row.id);
    const setId = setIdOf(output.type, output.docId, output.locale, renderId);
    const keys = [...inherited, ...created];
    const set = await db.createOne<DependencySet>(DEPENDENCY_SETS, { id: setId, output: outputId, keys, createdAt: now(), state: "pending", replaces });
    if (isErr(set)) {
      logger.error("delivery/static: could not record the dependencies of a render, the output is marked by every change until its next render", { ...output, error: set.error.message });
      return null;
    }
    if (rows.length > 0) {
      const written = await db.createMany<DependencyRow>(DEPENDENCIES, rows);
      if (isErr(written)) {
        logger.error("delivery/static: could not record the dependencies of a render, the output is marked by every change until its next render", { ...output, error: written.error.message });
        const rowsGone = await deleteDependencyRows(created);
        if (isErr(rowsGone)) logger.error("delivery/static: could not remove a partly written dependency set, the sweep removes it", { ...output, error: rowsGone.error.message });
        else logged("could not remove a partly written dependency set, the sweep removes it", output)(await deleteSet(setId, true));
        return null;
      }
    }
    return { setId, created, count: keys.length };
  };

  const recordSet = async (output: OutputRef, before: StatusRow | null, renderId: string, plan: SetPlan): Promise<{ setId: string; created: string[]; count: number; inheritsPrevious: boolean } | null> => {
    const outputId = before?.id ?? statusIdOf(output.type, output.docId, output.locale);
    switch (plan.kind) {
      case "none":
        return null;
      case "empty": {
        const written = await writeSet(output, outputId, renderId, [], [], before?.depSet ?? null);
        return written === null ? null : { ...written, inheritsPrevious: false };
      }
      case "known": {
        if (dependencies.rendererReadsDocument && !plan.rendererReads.some((r) => r.kind === "document" && r.type === output.type && r.id === output.docId)) {
          if (!warnedUnread.has(output.type)) {
            warnedUnread.add(output.type);
            logWarn(logger, `delivery/static: a render of ${output.type} did not read its own document through this instance, so what it read was not observed; such outputs are re-rendered on every change`, { type: output.type, docId: output.docId, locale: output.locale });
          }
          return null;
        }
        const specs = normalizeReads(plan.reads, output, dependencies.maxPerRender);
        if (specs === null) return null;
        const written = await writeSet(output, outputId, renderId, specs, [], before?.depSet ?? null);
        return written === null ? null : { ...written, inheritsPrevious: false };
      }
      case "failure": {
        if (before?.depSet === null || before?.depSet === undefined) return null;
        const previous = await db.findOne<DependencySet>(DEPENDENCY_SETS, { id: before.depSet });
        if (isErr(previous) || previous.value === null) return null;
        const specs = normalizeReads(plan.reads, output, dependencies.maxPerRender);
        if (specs === null) return null;
        const written = await writeSet(output, outputId, renderId, specs, previous.value.keys, before.depSet);
        return written === null ? null : { ...written, inheritsPrevious: true };
      }
    }
  };

  const commit = async (flight: Flight, output: OutputRef, before: StatusRow | null, renderId: string, target: Target, work: Work): Promise<Result<RenderOutcome, DeliveryError>> => {
    const set = await recordSet(output, before, renderId, work.set);
    const dropOwnSet = async (): Promise<void> => {
      if (set === null) return;
      const rowsGone = await deleteDependencyRows(set.created);
      if (isErr(rowsGone)) {
        logger.error("delivery/static: could not remove the dependencies of a render that lost, the sweep removes them", { ...output, error: rowsGone.error.message });
        return;
      }
      const removed = await db.deleteMany(DEPENDENCY_SETS, { id: set.setId });
      if (isErr(removed)) logger.error("delivery/static: could not remove the dependency set of a render that lost, the sweep removes it", { ...output, error: removed.error.message });
    };
    const at = now();
    const newKeys: string[] | null = target.state === "live" ? work.written : target.path === null ? [] : null;
    const fields: Partial<Omit<StatusRow, "id">> = {
      state: target.state,
      path: target.path,
      error: target.error,
      updatedAt: at,
      version: (before?.version ?? 0) + 1,
      depSet: set?.setId ?? null,
      depCount: set?.count ?? null,
      ...(target.state === "live" ? { publishedAt: at } : {}),
      ...(newKeys === null ? {} : { writtenKeys: newKeys }),
    };
    let won: boolean;
    if (before) {
      const swapped = await db.updateMany<StatusRow>(STATUS, { id: before.id, version: before.version }, fields);
      if (isErr(swapped)) {
        await dropOwnSet();
        return err(dbFailure(swapped.error));
      }
      won = swapped.value === 1;
    } else {
      const created = await db.createOne<StatusRow>(STATUS, {
        id: statusIdOf(output.type, output.docId, output.locale),
        type: output.type,
        docId: output.docId,
        locale: output.locale,
        state: target.state,
        path: target.path,
        writtenKeys: newKeys,
        error: target.error,
        publishedAt: target.state === "live" ? at : null,
        updatedAt: at,
        version: 1,
        depSet: set?.setId ?? null,
        depCount: set?.count ?? null,
        staleAt: null,
        staleToken: null,
        staleRetryAt: null,
        staleAttempts: 0,
        staleError: null,
        claimedBy: null,
        claimedAt: null,
      });
      if (isErr(created) && created.error.code !== "CONFLICT") {
        await dropOwnSet();
        return err(dbFailure(created.error));
      }
      won = !isErr(created);
    }

    if (won) {
      const ownId = before?.id ?? statusIdOf(output.type, output.docId, output.locale);
      const oldPath = before === null ? null : before.path;
      if (before !== null && oldPath !== null && oldPath !== target.path) {
        const staleKeys = await ownedKeys(before);
        logged("could not remove the files of a path this output left", { ...output, path: oldPath })(await removeStaleKeys(oldPath, staleKeys));
      } else if (before !== null && oldPath !== null && oldPath === target.path && target.state === "live") {
        const priorKeys = await ownedKeys(before);
        const stale = priorKeys.filter((key) => !work.written.includes(key));
        if (stale.length > 0) logged("could not remove files a re-render no longer writes", { ...output, path: oldPath })(await removeStaleKeys(oldPath, stale, ownId));
      }
      const previousSet = before?.depSet ?? null;
      if (previousSet !== null && previousSet !== set?.setId) logged("could not retire the previous dependency set, the sweep removes it", output)(await setState(previousSet, "retired"));
      if (set !== null) logged("could not adopt the new dependency set, the sweep adopts it", output)(await setState(set.setId, "current"));
      if (previousSet !== null && previousSet !== set?.setId) logged("could not remove the previous dependency set, the sweep removes it", output)(await deleteSet(previousSet, set?.inheritsPrevious === true));
      const keepsItsMark = work.failure !== null && typeof before?.staleToken === "string";
      let overlaps = false;
      if (target.state !== "draft" && !keepsItsMark) {
        const checked = await overlapped(flight, output, set === null ? null : readsOf(work.set), target.state === "live" ? target.path : null);
        if (isErr(checked)) logger.error("delivery/static: could not read the change log, the output is marked again to be safe", { ...output, error: checked.error.message });
        overlaps = isErr(checked) || checked.value;
      }
      if (overlaps) {
        const remarked = await remark(ownId, output, "whose render overlapped a change");
        if (isErr(remarked)) return remarked;
      } else if (work.failure === null && before?.staleToken) {
        const cleared = await db.updateMany<StatusRow>(STATUS, { id: ownId, staleToken: before.staleToken }, { staleToken: null, staleAt: null, staleRetryAt: null, staleAttempts: 0, staleError: null });
        if (isErr(cleared)) return err(dbFailure(cleared.error));
      }
      const after = await db.findOne<StatusRow>(STATUS, { id: ownId });
      if (isErr(after)) return err(dbFailure(after.error));
      return ok({ status: after.value === null ? null : toPublic(after.value), failure: work.failure });
    }

    const after = await readRow(output.type, output.docId, output.locale);
    if (isErr(after)) return after;
    const current = after.value;
    if (current === null && before?.state === "deleted") {
      await dropOwnSet();
      return commit(flight, output, null, renderId, target, work);
    }
    const stillServed = current !== null && (current.state === "live" || current.state === "error");
    if (work.written.length > 0 && work.renderPath !== null && !(stillServed && current.path === work.renderPath)) {
      const owned = await pathOwned(work.renderPath);
      if (isErr(owned)) return owned;
      if (!owned.value) logged("could not remove the files of a render that lost", { ...output, path: work.renderPath })(await removeFiles(work.renderPath, work.written));
    }
    await dropOwnSet();
    if (stillServed) {
      const remarked = await remark(current.id, output, "after a newer write won against its render");
      if (isErr(remarked)) return remarked;
    }
    const reread = await readRow(output.type, output.docId, output.locale);
    if (isErr(reread)) return reread;
    return ok({ status: reread.value === null || reread.value.state === "deleted" ? null : toPublic(reread.value), failure: work.failure });
  };

  const startFlight = async (): Promise<Result<Flight, DeliveryError>> => {
    const since = await readSequence();
    if (isErr(since)) return since;
    return ok({ since: since.value });
  };

  const overlapped = async (flight: Flight, self: OutputRef, reads: readonly ObservedRead[] | null, livePath: string | null): Promise<Result<boolean, DeliveryError>> => {
    let last = sequenceId(flight.since);
    for (;;) {
      const page = await db.findMany<ChangeRow>(CHANGES, { id: { gt: last } }, { sort: { id: "asc" }, limit: CHANGE_PAGE });
      if (isErr(page)) return err(dbFailure(page.error));
      for (const change of page.value.items) if (touches(reads, change, self, livePath)) return ok(true);
      const tail = page.value.items.at(-1);
      if (page.value.items.length < CHANGE_PAGE || tail === undefined) break;
      last = tail.id;
    }
    const newest = await readSequence();
    if (isErr(newest)) return newest;
    return ok(newest.value - CHANGE_KEEP > flight.since);
  };

  const renderWithTimeout = async (input: RenderInput): Promise<Result<RenderOutput, RendererError> | "timeout"> => {
    const rendering = renderer.render(input);
    const settled = rendering.then(
      (value) => ({ value }),
      (reason: unknown) => ({ reason }),
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), dependencies.renderTimeoutSeconds * 1000);
      timer.unref();
    });
    const winner = await Promise.race([settled, timeout]);
    clearTimeout(timer);
    if (winner === "timeout") {
      abandoned += 1;
      void settled.then(() => {
        abandoned -= 1;
      });
      return "timeout";
    }
    if ("reason" in winner) throw winner.reason;
    return winner.value;
  };

  const renderFormats = async (type: string, id: string, locale: string | undefined, path: string, document: Record<string, unknown>): Promise<{ outputs: RenderOutput[] } | { failure: string }> => {
    const outputs: RenderOutput[] = [];
    for (const format of config.formats) {
      const rendered = await renderWithTimeout({ type, id, ...(locale === undefined ? {} : { locale }), path, format, document });
      if (rendered === "timeout") return { failure: `render timed out after ${dependencies.renderTimeoutSeconds}s` };
      if (isErr(rendered)) return { failure: rendered.error.message };
      for (const asset of rendered.value.assets ?? []) {
        const assetPath = asset.path.replace(/^\/+/, "");
        if (assetPath === "" || assetPath.split("/").some((p) => p === "..")) throw new Error(`delivery/static: invalid asset path ${JSON.stringify(asset.path)}`);
        const reservedAsset = reservedMatch(`/${assetPath}`, config.reservedPaths);
        if (reservedAsset !== undefined) return { failure: `asset /${assetPath} lies under the reserved path ${reservedAsset}` };
      }
      outputs.push(rendered.value);
    }
    return { outputs };
  };

  const publishLocale = async (type: string, id: string, locale: string | undefined): Promise<Result<RenderOutcome, DeliveryError>> => {
    const flight = await startFlight();
    if (isErr(flight)) return flight;
    return renderLocale(flight.value, type, id, locale);
  };

  const renderLocale = async (flight: Flight, type: string, id: string, locale: string | undefined): Promise<Result<RenderOutcome, DeliveryError>> => {
    const tc = typeConfig(type);
    const output: OutputRef = { type, docId: id, locale: locale ?? "" };
    const found = await readRow(type, id, output.locale);
    if (isErr(found)) return found;
    const before = found.value;
    const renderId = randomUUID();
    const statusFilter = { [tc.statusField]: tc.publishedValue };
    const viewResult = await publishedLocale(content, type, id, locale, statusFilter, { fallback: config.fallback });
    if (isErr(viewResult)) return err(transientOnly(viewResult.error, "content@1"));
    const view = viewResult.value;
    if (!view) {
      if (before?.state === "deleted") return ok({ status: null, failure: null });
      return commit(flight, output, before, renderId, { state: "draft", path: null, error: null }, { renderPath: null, written: [], set: { kind: "none" }, failure: null });
    }
    const rules = { home: tc.home, slugField: tc.slugField, prefixPrimary: config.prefixPrimary, fallback: config.fallback, filter: statusFilter };
    const options = { ...(locale === undefined ? {} : { locale }), rules };
    const linkScope = await observeReads(() => site.resolveLinks(type, view, options));
    if (linkScope.result.status === "rejected") throw linkScope.result.reason;
    const linked = linkScope.result.value;
    if (isErr(linked)) return err(transientOnly(linked.error, "site@1"));
    const doc = linked.value;
    const path = site.pathOf(type, doc, options);
    const keptPath = before !== null && (before.state === "live" || before.state === "error") ? before.path : null;
    const failed = (message: string, work: Omit<Work, "failure" | "set">, reads: ObservedRead[]): Promise<Result<RenderOutcome, DeliveryError>> =>
      commit(flight, output, before, renderId, { state: "error", path: keptPath, error: message }, { ...work, set: { kind: "failure", reads }, failure: message });
    if (path === null) return commit(flight, output, before, renderId, { state: "error", path: null, error: `no ${tc.slugField}` }, { renderPath: null, written: [], set: { kind: "empty" }, failure: null });
    const reservedPage = reservedMatch(path, config.reservedPaths);
    if (reservedPage !== undefined) return failed(`path ${path} is reserved (${reservedPage})`, { renderPath: null, written: [] }, linkScope.reads);

    const renderScope = await observeReads(() => renderFormats(type, id, locale, path, doc));
    const reads = [...linkScope.reads, ...renderScope.reads];
    if (renderScope.result.status === "rejected") return failed(errorText(renderScope.result.reason), { renderPath: null, written: [] }, reads);
    const rendered = renderScope.result.value;
    if ("failure" in rendered) return failed(rendered.failure, { renderPath: null, written: [] }, reads);

    const written: string[] = [];
    try {
      for (const out of rendered.outputs) {
        const key = keyFor(config.prefix, path, out.extension);
        written.push(key);
        const stored = await blobs.put(key, bytes(out.data), { contentType: out.contentType });
        if (isErr(stored)) return failed(stored.error.message, { renderPath: path, written }, reads);
        for (const asset of out.assets ?? []) {
          const assetKey = `${config.prefix}${asset.path.replace(/^\/+/, "")}`;
          if (uploadedAssets.has(assetKey)) continue;
          const put = await blobs.put(assetKey, bytes(asset.data), { contentType: asset.contentType });
          if (isErr(put)) return failed(put.error.message, { renderPath: path, written }, reads);
          uploadedAssets.add(assetKey);
        }
      }
    } catch (error) {
      return failed(errorText(error), { renderPath: path, written }, reads);
    }
    return commit(flight, output, before, renderId, { state: "live", path, error: null }, { renderPath: path, written, set: { kind: "known", reads, rendererReads: renderScope.reads }, failure: null });
  };

  const publish: Delivery["publish"] = async (type, id) => {
    typeConfig(type);
    const targets = locales.length > 0 ? locales : [undefined];
    const out: PublishStatus[] = [];
    for (const locale of targets) {
      const outcome = await publishLocale(type, id, locale);
      if (isErr(outcome)) return outcome;
      if (outcome.value.status) out.push(outcome.value.status);
    }
    return ok(out);
  };

  const exportLlmsNow: Delivery["exportLlms"] = async () => {
    const filterFor = (type: string): Filter => {
      const tc = typeConfig(type);
      return { [tc.statusField]: tc.publishedValue };
    };
    const liveSources = async (type: string): Promise<Result<LlmsSource[], DeliveryError>> => {
      const out: LlmsSource[] = [];
      for (let offset = 0; ; offset += ROW_PAGE) {
        const page = await db.findMany<StatusRow>(STATUS, { type, state: "live" }, { sort: { path: "asc" }, limit: ROW_PAGE, offset });
        if (isErr(page)) return err(dbFailure(page.error));
        for (const row of page.value.items) {
          if (row.path === null) continue;
          const path = row.path;
          out.push({
            type,
            path,
            locale: row.locale,
            docId: row.docId,
            html: async () => {
              const blob = await blobs.get(keyFor(config.prefix, path, "html"));
              if (isErr(blob)) return err(transientOnly(blob.error, "blobstore@1"));
              return ok(blob.value ? new TextDecoder().decode(blob.value) : null);
            },
          });
        }
        if (page.value.items.length < ROW_PAGE) break;
      }
      return ok(out);
    };
    const exported = await exportLlms(config.llms, { content, blobs, logger, prefix: config.prefix, fallback: config.fallback, defaultLocale: model.defaultLocale, hasLocales: locales.length > 0, types: Object.keys(config.types), filterFor, sources: liveSources });
    if (isErr(exported)) return err(transientOnly(exported.error, "llms export"));
    return ok(exported.value);
  };

  const claim = async (rowId: string): Promise<Result<string | null, DeliveryError>> => {
    const at = now();
    const released = await db.updateMany<StatusRow>(STATUS, { id: rowId, claimedAt: { lte: at - claimTtlMs } }, { claimedBy: null, claimedAt: null });
    if (isErr(released)) return err(dbFailure(released.error));
    const token = randomUUID();
    const won = await db.updateMany<StatusRow>(STATUS, { id: rowId, claimedBy: null }, { claimedBy: token, claimedAt: at });
    if (isErr(won)) return err(dbFailure(won.error));
    return ok(won.value === 1 ? token : null);
  };

  const release = async (rowId: string, token: string): Promise<void> => {
    const released = await db.updateMany<StatusRow>(STATUS, { id: rowId, claimedBy: token }, { claimedBy: null, claimedAt: null });
    if (isErr(released)) logger.error("delivery/static: could not release a render claim, it expires after claimTtlSeconds", { id: rowId, error: released.error.message });
  };

  const recordFailure = async (row: StatusRow, message: string): Promise<void> => {
    if (row.staleToken === null) return;
    const attempts = attemptsOf(row) + 1;
    const recorded = await db.updateMany<StatusRow>(STATUS, { id: row.id, staleToken: row.staleToken }, { staleAttempts: attempts, staleError: message, staleRetryAt: now() + backoffMs(attempts) });
    if (isErr(recorded)) logger.error("delivery/static: could not record a failed re-render", { id: row.id, error: recorded.error.message });
    logger.error("delivery/static: re-render failed", { type: row.type, docId: row.docId, locale: row.locale, attempts, error: message });
  };

  const renderMarked = async (row: StatusRow): Promise<Result<RenderOutcome, DeliveryError>> => {
    let outcome: Result<RenderOutcome, DeliveryError>;
    try {
      outcome = await publishLocale(row.type, row.docId, row.locale === "" ? undefined : row.locale);
    } catch (error) {
      outcome = err(transient(`delivery/static: rendering ${row.type}/${row.docId}/${row.locale} threw: ${errorText(error)}`));
    }
    if (isErr(outcome)) await recordFailure(row, outcome.error.message);
    else if (outcome.value.failure !== null) await recordFailure(row, outcome.value.failure);
    return outcome;
  };

  const requestLlmsNow = async (): Promise<Result<void, DeliveryError>> => {
    if (dependencies.render === "background") {
      llmsRequested = true;
      loop?.wake();
      return ok();
    }
    try {
      await events?.emit(LLMS_STALE, { coalesceKey: LLMS_COALESCE_KEY });
    } catch (error) {
      return err(transient(`delivery/static: could not queue the llms.txt export (${errorText(error)})`));
    }
    return ok();
  };

  const releaseExpiredClaims = async (): Promise<Result<number, DeliveryError>> => {
    const released = await db.updateMany<StatusRow>(STATUS, { claimedAt: { lte: now() - claimTtlMs } }, { claimedBy: null, claimedAt: null });
    if (isErr(released)) return err(dbFailure(released.error));
    return ok(released.value);
  };

  const unwrap = <T>(result: Result<T, DeliveryError>): T => {
    if (isErr(result)) throw new Error(result.error.message);
    return result.value;
  };

  const pass = async (): Promise<PassOutcome> => {
    unwrap(await releaseExpiredClaims());
    const at = now();
    const due = await db.findMany<StatusRow>(STATUS, { staleRetryAt: { lte: at }, claimedBy: null, staleAttempts: { lt: dependencies.maxAttempts }, type: { in: deliveredTypes } }, { sort: { staleRetryAt: "asc" }, limit: LOOP_BATCH });
    if (isErr(due)) throw new Error(due.error.message);
    if (due.value.items.length > 0) {
      const token = randomUUID();
      const claimed = await db.updateMany<StatusRow>(STATUS, { id: { in: due.value.items.map((r) => r.id) }, claimedBy: null }, { claimedBy: token, claimedAt: at });
      if (isErr(claimed)) throw new Error(claimed.error.message);
      const mine = await db.findMany<StatusRow>(STATUS, { claimedBy: token }, { sort: { staleRetryAt: "asc" } });
      if (isErr(mine)) throw new Error(mine.error.message);
      for (const row of mine.value.items) {
        try {
          if (row.staleToken !== null && !stopping) {
            const renewed = await db.updateMany<StatusRow>(STATUS, { id: row.id, claimedBy: token }, { claimedAt: now() });
            if (isErr(renewed) || renewed.value !== 1) continue;
            await renderMarked(row);
            llmsRequested = true;
          }
        } finally {
          await release(row.id, token);
        }
      }
      return { busy: true, sleepMs: null };
    }
    if (llmsRequested) {
      llmsRequested = false;
      const exported = await exportLlmsNow();
      if (isErr(exported)) {
        llmsRequested = true;
        throw new Error(`llms.txt export failed: ${exported.error.message}`);
      }
      return { busy: true, sleepMs: null };
    }
    const next = await db.findMany<StatusRow>(STATUS, { staleRetryAt: { gt: at }, staleAttempts: { lt: dependencies.maxAttempts } }, { sort: { staleRetryAt: "asc" }, limit: 1 });
    if (isErr(next)) throw new Error(next.error.message);
    const retryAt = next.value.items[0]?.staleRetryAt;
    return { busy: false, sleepMs: retryAt === undefined || retryAt === null ? null : Math.max(0, retryAt - now()) };
  };

  if (dependencies.render === "background") loop = createBackgroundLoop(pass, logger, "delivery/static");

  const markDependents: Delivery["markDependents"] = async (type, ids) => {
    const changed = [...new Set(ids)];
    const recorded = await recordChange(type, changed);
    if (isErr(recorded)) return recorded;
    const outputs = new Set<string>();
    const isModelType = model.types[type] !== undefined;
    for (const id of changed) {
      const rows = await scan<DependencyRow>(db, DEPENDENCIES, dependencyPrefix("document", type, id));
      if (isErr(rows)) return err(dbFailure(rows.error));
      const pathGroups = new Map<string, { locale: string; rules: Record<string, unknown>; path: string | null; outputs: string[] }>();
      for (const row of rows.value) {
        if (row.kind === "document") outputs.add(row.output);
        if (row.kind !== "path" || !isModelType) continue;
        const key = `${row.depLocale ?? ""}\u0000${canonicalJson(row.rules)}\u0000${row.path ?? ""}`;
        const group = pathGroups.get(key) ?? { locale: row.depLocale ?? "", rules: row.rules ?? {}, path: row.path, outputs: [] };
        group.outputs.push(row.output);
        pathGroups.set(key, group);
      }
      for (const group of pathGroups.values()) {
        const stub = { id: "", createdAt: 0, updatedAt: 0, ref: { type: "internal", collection: type, id } };
        const resolved = await site.resolveLinks(type, stub, { ...(group.locale === "" ? {} : { locale: group.locale }), rules: group.rules });
        const link = isErr(resolved) ? undefined : resolved.value._links?.[id];
        const current = link !== undefined && "path" in link && typeof link.path === "string" ? link.path : null;
        if (isErr(resolved) || current !== group.path) for (const o of group.outputs) outputs.add(o);
      }
    }
    const typeRows = await scan<DependencyRow>(db, DEPENDENCIES, dependencyPrefix("type", type, null));
    if (isErr(typeRows)) return err(dbFailure(typeRows.error));
    for (const row of typeRows.value) outputs.add(row.output);
    const queryRows = await scan<DependencyRow>(db, DEPENDENCIES, dependencyPrefix("query", type, null));
    if (isErr(queryRows)) return err(dbFailure(queryRows.error));
    const queryGroups = new Map<string, { locale: string | null; filter: Record<string, unknown>; outputs: string[] }>();
    for (const row of queryRows.value) {
      const key = `${row.depLocale ?? ""}\u0000${canonicalJson(row.filter)}`;
      const group = queryGroups.get(key) ?? { locale: row.depLocale, filter: row.filter ?? {}, outputs: [] };
      group.outputs.push(row.output);
      queryGroups.set(key, group);
    }
    for (const group of queryGroups.values()) {
      for (const id of changed) {
        if (idExcludes(group.filter, id)) continue;
        let member = true;
        try {
          const page = await content.list(type, { ...group.filter, id }, { ...(group.locale === null ? {} : { locale: group.locale }), limit: 1 });
          if (!isErr(page)) member = page.value.items.length > 0;
        } catch {
          member = true;
        }
        if (member) {
          for (const o of group.outputs) outputs.add(o);
          break;
        }
      }
    }
    const unknown = await pagedRows({ depSet: null, state: { in: MARKABLE }, type: { in: deliveredTypes }, locale: { in: deliveredLocales } }, (rows) => {
      for (const row of rows) outputs.add(row.id);
      return ok();
    });
    if (isErr(unknown)) return unknown;
    const marked = await markRows([...outputs], MARKABLE);
    if (isErr(marked)) return marked;
    return ok({ marked: marked.value });
  };

  const sweepSets = async (filter: Filter): Promise<Result<number, DeliveryError>> => {
    let swept = 0;
    let last: string | undefined;
    for (;;) {
      const sets = await db.findMany<DependencySet>(DEPENDENCY_SETS, last === undefined ? filter : { ...filter, id: { gt: last } }, { sort: { id: "asc" }, limit: ROW_PAGE });
      if (isErr(sets)) return err(dbFailure(sets.error));
      for (const set of sets.value.items) {
        const owner = await db.findOne<StatusRow>(STATUS, { id: set.output });
        if (isErr(owner)) return err(dbFailure(owner.error));
        if (owner.value?.depSet === set.id) {
          const adopted = await setState(set.id, "current");
          if (isErr(adopted)) return adopted;
          if (set.replaces !== null && set.replaces !== set.id) {
            const replaced = await setState(set.replaces, "retired");
            if (isErr(replaced)) return replaced;
          }
          continue;
        }
        const shared = owner.value?.depSet ? await db.findOne<DependencySet>(DEPENDENCY_SETS, { id: owner.value.depSet }) : undefined;
        if (shared !== undefined && isErr(shared)) return err(dbFailure(shared.error));
        if (shared !== undefined && shared.value === null) continue;
        const keep = new Set(shared?.value?.keys ?? []);
        const rows = await deleteDependencyRows(set.keys.filter((k) => !keep.has(k)));
        if (isErr(rows)) return rows;
        const removed = await db.deleteMany(DEPENDENCY_SETS, { id: set.id });
        if (isErr(removed)) return err(dbFailure(removed.error));
        swept += 1;
      }
      last = sets.value.items.at(-1)?.id;
      if (sets.value.items.length < ROW_PAGE || last === undefined) return ok(swept);
    }
  };

  const markAll: Delivery["markAll"] = async (type) => {
    typeConfig(type);
    const token = randomUUID();
    const at = now();
    const mark = { staleAt: at, staleToken: token, staleRetryAt: at, staleAttempts: 0, staleError: null };
    const existing = await db.updateMany<StatusRow>(STATUS, { type, state: { in: ALL_OUTPUTS }, locale: { in: deliveredLocales } }, mark);
    if (isErr(existing)) return err(dbFailure(existing.error));
    const targets = locales.length > 0 ? locales : [""];
    for (let offset = 0; ; offset += PAGE) {
      const page = await content.list(type, {}, { limit: PAGE, offset });
      if (isErr(page)) return err(transientOnly(page.error, "content@1"));
      const docIds = page.value.items.map((d) => d.id);
      if (docIds.length > 0) {
        const have = new Set<string>();
        const listed = await pagedRows({ type, docId: { in: docIds }, locale: { in: targets } }, (rows) => {
          for (const r of rows) have.add(`${r.docId}\u0000${r.locale}`);
          return ok();
        });
        if (isErr(listed)) return listed;
        for (const docId of docIds) {
          for (const locale of targets) {
            if (have.has(`${docId}\u0000${locale}`)) continue;
            const created = await db.createOne<StatusRow>(STATUS, {
              id: statusIdOf(type, docId, locale),
              type,
              docId,
              locale,
              state: "draft",
              path: null,
              writtenKeys: [],
              error: null,
              publishedAt: null,
              updatedAt: at,
              version: 0,
              depSet: null,
              depCount: null,
              ...mark,
              claimedBy: null,
              claimedAt: null,
            });
            if (isErr(created) && created.error.code !== "CONFLICT") return err(dbFailure(created.error));
          }
        }
      }
      if (page.value.items.length < PAGE) break;
    }
    const dispatched = await dispatchToken(token);
    if (isErr(dispatched)) return dispatched;
    return ok({ marked: dispatched.value });
  };

  return {
    publish,
    async unpublish(type, id) {
      typeConfig(type);
      const rows = await db.findMany<StatusRow>(STATUS, { type, docId: id }, { sort: { locale: "asc" } });
      if (isErr(rows)) return err(dbFailure(rows.error));
      const pending = [...rows.value.items];
      const present = new Set(pending.map((r) => r.locale));
      for (const locale of locales.length > 0 ? locales : [""]) {
        if (present.has(locale)) continue;
        const blocked = await db.createOne<StatusRow>(STATUS, { id: statusIdOf(type, id, locale), type, docId: id, locale, state: "deleted", path: null, writtenKeys: [], error: null, publishedAt: null, updatedAt: now(), version: 1, depSet: null, depCount: null, staleAt: null, staleToken: null, staleRetryAt: null, staleAttempts: 0, staleError: null, claimedBy: null, claimedAt: null });
        if (!isErr(blocked)) continue;
        if (blocked.error.code !== "CONFLICT") return err(dbFailure(blocked.error));
        const raced = await readRow(type, id, locale);
        if (isErr(raced)) return raced;
        if (raced.value) pending.push(raced.value);
      }
      let count = 0;
      for (const row of pending) {
        const output: OutputRef = { type: row.type, docId: row.docId, locale: row.locale };
        let current: StatusRow | null = row;
        let tombstoned = false;
        for (let tries = 0; current !== null && current.state !== "deleted"; tries++) {
          if (tries >= UNPUBLISH_TRIES) return err(transient(`delivery/static: ${type}/${id}/${row.locale} kept changing while it was being unpublished – try again`));
          const swapped: Result<number, KestrelError> = await db.updateMany<StatusRow>(STATUS, { id: current.id, version: current.version }, { state: "deleted", version: (current.version ?? 0) + 1, updatedAt: now(), depSet: null, depCount: null, staleToken: null, staleAt: null, staleRetryAt: null, staleAttempts: 0, staleError: null, claimedBy: null, claimedAt: null });
          if (isErr(swapped)) return err(dbFailure(swapped.error));
          if (swapped.value === 1) {
            tombstoned = true;
            break;
          }
          const reread: Result<StatusRow | null, KestrelError> = await db.findOne<StatusRow>(STATUS, { id: current.id });
          if (isErr(reread)) return err(dbFailure(reread.error));
          current = reread.value;
        }
        if (current === null) continue;
        if (tombstoned) count += 1;
        if (current.path !== null) {
          const keys = await ownedKeys(current);
          const removed = await removeStaleKeys(current.path, keys);
          if (isErr(removed)) return removed;
          const cleared = await db.updateMany<StatusRow>(STATUS, { id: current.id, state: "deleted" }, { path: null, writtenKeys: [] });
          if (isErr(cleared)) return err(dbFailure(cleared.error));
        }
        if (tombstoned && current.depSet !== null) logged("could not remove the dependency set of an unpublished output, the sweep removes it", output)(await retireSet(current.depSet, false));
      }
      return ok(count);
    },
    async status(type, id) {
      typeConfig(type);
      const page = await db.findMany<StatusRow>(STATUS, { type, docId: id, state: { ne: "deleted" } }, { sort: { locale: "asc" } });
      if (isErr(page)) return err(dbFailure(page.error));
      return ok(page.value.items.map(toPublic));
    },
    async publishAll(type) {
      typeConfig(type);
      uploadedAssets.clear();
      let documents = 0;
      let live = 0;
      let errors = 0;
      for (let offset = 0; ; offset += PAGE) {
        const page = await content.list(type, {}, { limit: PAGE, offset });
        if (isErr(page)) return err(transientOnly(page.error, "content@1"));
        for (const doc of page.value.items) {
          documents += 1;
          const statuses = await publish(type, doc.id);
          if (isErr(statuses)) return statuses;
          for (const s of statuses.value) {
            if (s.state === "live") live += 1;
            if (s.state === "error") errors += 1;
          }
        }
        if (page.value.items.length < PAGE) break;
      }
      return ok({ documents, live, errors });
    },
    exportLlms: exportLlmsNow,
    markDependents,
    markAll,
    async checkBuild(build) {
      const stored = await db.findOne<StateRow>(STATE, { id: "build" });
      if (isErr(stored)) return err(dbFailure(stored.error));
      if (stored.value?.value === build) return ok({ changed: false, marked: 0 });
      let marked = 0;
      for (const type of Object.keys(config.types)) {
        const all = await markAll(type);
        if (isErr(all)) return all;
        marked += all.value.marked;
      }
      const written = stored.value === null ? await db.createOne<StateRow>(STATE, { id: "build", value: build, seq: null, updatedAt: now() }) : await db.updateOne<StateRow>(STATE, "build", { value: build, updatedAt: now() });
      if (isErr(written) && written.error.code !== "CONFLICT") return err(dbFailure(written.error));
      return ok({ changed: true, marked });
    },
    async republishOutput(target) {
      typeConfig(target.type);
      const found = await readRow(target.type, target.docId, target.locale);
      if (isErr(found)) return found;
      if (found.value === null || found.value.state === "deleted") return ok({ rendered: false, state: null });
      const token = await claim(found.value.id);
      if (isErr(token)) return token;
      if (token.value === null) return err(transient(`delivery/static: ${target.type}/${target.docId}/${target.locale} is being rendered elsewhere – try again`));
      let rendered = false;
      try {
        const row = await db.findOne<StatusRow>(STATUS, { id: found.value.id });
        if (isErr(row)) return err(dbFailure(row.error));
        if (row.value === null || row.value.state === "deleted" || row.value.staleToken === null) return ok({ rendered: false, state: row.value === null || row.value.state === "deleted" ? null : row.value.state });
        rendered = true;
        const outcome = await renderMarked(row.value);
        if (isErr(outcome)) return outcome;
        if (outcome.value.failure !== null) return err(transient(`delivery/static: re-rendering ${target.type}/${target.docId}/${target.locale} failed: ${outcome.value.failure}`));
        return ok({ rendered: true, state: outcome.value.status?.state ?? null });
      } finally {
        await release(found.value.id, token.value);
        if (rendered) {
          const requested = await requestLlmsNow();
          if (isErr(requested)) logger.error("delivery/static: could not request an llms.txt export after a re-render", { error: requested.error.message });
        }
      }
    },
    requestLlms: requestLlmsNow,
    async resumeStale() {
      const released = await releaseExpiredClaims();
      if (isErr(released)) return released;
      const at = now();
      let swept = 0;
      const tombstones = await db.findMany<StatusRow>(STATUS, { state: "deleted", updatedAt: { lte: at - claimTtlMs } }, { limit: ROW_PAGE });
      if (isErr(tombstones)) return err(dbFailure(tombstones.error));
      for (const row of tombstones.value.items) {
        if (row.path !== null) {
          const keys = await ownedKeys(row);
          const removed = await removeStaleKeys(row.path, keys);
          if (isErr(removed)) continue;
          const cleared = await db.updateMany<StatusRow>(STATUS, { id: row.id, version: row.version }, { path: null, writtenKeys: [] });
          if (isErr(cleared) || cleared.value === 0) continue;
        }
        const deleted = await db.deleteMany(STATUS, { id: row.id, version: row.version });
        if (isErr(deleted)) return err(dbFailure(deleted.error));
        swept += deleted.value;
      }
      const pending = await sweepSets({ state: "pending", createdAt: { lte: at - claimTtlMs } });
      if (isErr(pending)) return pending;
      const retired = await sweepSets({ state: "retired" });
      if (isErr(retired)) return retired;
      swept += pending.value + retired.value;
      const newest = await readSequence();
      if (isErr(newest)) return newest;
      const pruned = await pruneChanges(newest.value);
      if (isErr(pruned)) return pruned;
      let aged = 0;
      if (dependencies.maxAgeSeconds !== null) {
        const old: string[] = [];
        const walked = await pagedRows({ state: "live", publishedAt: { lte: at - dependencies.maxAgeSeconds * 1000 } }, (rows) => {
          for (const row of rows) old.push(row.id);
          return ok();
        });
        if (isErr(walked)) return walked;
        const marked = await markRows(old, ["live"]);
        if (isErr(marked)) return marked;
        aged = marked.value;
      }
      let dispatched = 0;
      const due = await pagedRows({ staleAt: { lte: at - RESUME_MIN_AGE_MS }, claimedBy: null, staleRetryAt: { lte: at }, staleAttempts: { lt: dependencies.maxAttempts }, type: { in: deliveredTypes } }, async (rows) => {
        dispatched += rows.length;
        return dispatch(rows);
      });
      if (isErr(due)) return due;
      return ok({ released: released.value, swept, dispatched, aged });
    },
    async retryStale() {
      const failed: string[] = [];
      const walked = await pagedRows({ staleToken: { ne: null }, staleAttempts: { gte: dependencies.maxAttempts } }, (rows) => {
        for (const row of rows) failed.push(row.id);
        return ok();
      });
      if (isErr(walked)) return walked;
      const marked = await markRows(failed, ALL_OUTPUTS);
      if (isErr(marked)) return marked;
      return ok({ retried: marked.value });
    },
    async readStaleStatus() {
      const counts = await Promise.all([
        db.count(STATUS, { staleToken: { ne: null }, staleAttempts: { lt: dependencies.maxAttempts } }),
        db.count(STATUS, { staleToken: { ne: null }, staleAttempts: { gte: dependencies.maxAttempts } }),
        db.count(STATUS, { claimedBy: { ne: null } }),
        db.count(STATUS, { depSet: null, state: { in: MARKABLE } }),
      ]);
      const values: number[] = [];
      for (const c of counts) {
        if (isErr(c)) return err(dbFailure(c.error));
        values.push(c.value);
      }
      const oldest = await db.findMany<StatusRow>(STATUS, { staleToken: { ne: null } }, { sort: { staleAt: "asc" }, limit: 1 });
      if (isErr(oldest)) return err(dbFailure(oldest.error));
      const [stale = 0, failedCount = 0, rendering = 0, unknown = 0] = values;
      return ok({ stale, failed: failedCount, rendering, unknown, oldestStaleAt: oldest.value.items[0]?.staleAt ?? null, abandoned });
    },
    async close() {
      stopping = true;
      await loop?.stop();
    },
  };
}
