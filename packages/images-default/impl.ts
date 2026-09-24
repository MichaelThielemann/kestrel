import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve as resolvePath, sep } from "node:path";
import type { Introspection } from "@michaelthielemann/kestrel";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import { withEventIdentity } from "@michaelthielemann/kestrel-contracts/events.envelope";
import type { Document, Filter, NewDocument, Persistence, Schema } from "@michaelthielemann/kestrel-contracts/persistence";
import { failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import type { z } from "zod";
import { contentTypeOf, eligible, render } from "./generate.ts";
import type { Rendered, Renderer } from "./generate.ts";
import { orientedOriginalDimensions, plannedDimensions, plannedExt, plannedFormat } from "./plan.ts";
import { DEFAULT_SIZES, mergeSizes, sizeSchema, spec } from "./sizes.ts";
import type { Size, SizeRow } from "./sizes.ts";
import type { configSchema } from "./module.ts";

export const SIZES = "images_sizes";
export const VARIANTS = "images_variants";
export const JOBS = "images_jobs";
export const RETIRED = "images_retired";

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RENDER_TIMEOUT_MS = 30000;

const FAILURE_SAMPLE = 20;
const PLACEMENT_CONCURRENCY = 4;
const REPAIR_SAMPLE = 200;
const NEW_ITEM_WINDOW_MS = 24 * 60 * 60 * 1000;

export type Config = z.output<typeof configSchema>;

export type VariantState = "planned" | "pending" | "done" | "error" | "failed";

export interface Variant extends Document {
  mediaId: string;
  size: string;
  spec: string;
  width: number;
  height: number;
  format: string;
  key: string;
  bytes: number;
  state: VariantState;
  error: string | null;
  attempts: number;
  updatedAt: number;
}

export interface Retired extends Document {
  mediaId: string;
  file: string;
  retiredAt: number;
}

export interface Job extends Document {
  state: "running" | "paused" | "done" | "error";
  total: number;
  done: number;
  failed: number;
  cursor: string;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface FailedVariant {
  mediaId: string;
  size: string;
  attempts: number;
  error: string | null;
  updatedAt: number;
}

/** Effective sizes tallied by state for one media item; a `planned` row counts as pending. All zero for a non-eligible item. */
export interface VariantCounts {
  done: number;
  pending: number;
  error: number;
  failed: number;
}

export interface ImagesStatus {
  sizes: Array<SizeRow & { used: boolean; variants: { done: number; pending: number; error: number; failed: number } }>;
  job: Job | null;
  orphaned: { sizes: string[]; variants: number };
  registrySeen: boolean;
  failed: { variants: number; recent: FailedVariant[] };
}

export interface VariantBlob {
  data: Uint8Array;
  contentType: string;
  fallback: boolean;
  variant: "done" | "original";
}

export interface RetiredFailures {
  variants: number;
  media: number;
  job: Job | null;
}

export interface PublicSync {
  written: number;
  removed: number;
  planned: number;
  missing: number;
}

export interface Images {
  register(sizes: unknown): Promise<Result<SizeRow[], KestrelError>>;
  sizes(): Promise<SizeRow[]>;
  exists(mediaId: string): Promise<Result<boolean, KestrelError>>;
  plan(mediaIds: string[]): Promise<Result<void, KestrelError>>;
  generate(mediaId: string): Promise<Result<Variant[], KestrelError>>;
  sync(): Promise<Result<Job, KestrelError>>;
  resume(): Promise<Result<Job | null, KestrelError>>;
  retryFailed(mediaId?: string): Promise<Result<RetiredFailures, KestrelError>>;
  prune(names: string[]): Promise<Result<{ sizes: number; variants: number }, KestrelError>>;
  status(): Promise<Result<ImagesStatus, KestrelError>>;
  remove(mediaId: string): Promise<Result<number, KestrelError>>;
  variantsOf(mediaIds: string[]): Promise<Result<Map<string, Variant[]>, KestrelError>>;
  variantCounts(mediaIds: string[]): Promise<Result<Map<string, VariantCounts>, KestrelError>>;
  read(mediaId: string, file: string): Promise<Result<VariantBlob | null, KestrelError>>;
  exportTo(dir: string): Promise<Result<{ written: number; skipped: number }, KestrelError>>;
  publicPath(mediaId: string, variant: Variant): string;
  publicCopyEnabled(): boolean;
  syncPublic(): Promise<Result<PublicSync, KestrelError>>;
  attach(kestrel: Introspection): void;
  close(): Promise<void>;
}

interface MediaRow extends Document {
  key: string;
  contentType: string;
  folder: string;
  filename: string;
  status?: string;
  width?: number | null;
  height?: number | null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseSize(raw: unknown): Result<Size, KestrelError> {
  const parsed = sizeSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const issue = parsed.error.issues[0];
  return err(failure("VALIDATION", `images: ${issue?.path.join(".") ?? "size"}: ${issue?.message ?? "invalid size"}`));
}

function fileOf(variant: Pick<Variant, "key">): string {
  const slash = variant.key.lastIndexOf("/");
  return slash === -1 ? variant.key : variant.key.slice(slash + 1);
}

function isMediaReady(media: MediaRow): boolean {
  return media.status === undefined || media.status === "ready";
}

async function pool<T>(tasks: Array<() => Promise<Result<T, KestrelError>>>, limit: number): Promise<Result<T[], KestrelError>> {
  const results: T[] = [];
  let index = 0;
  let failureError: KestrelError | undefined;
  async function worker(): Promise<void> {
    for (;;) {
      const i = index++;
      if (i >= tasks.length || failureError !== undefined) return;
      const outcome = await tasks[i]!();
      if (isErr(outcome)) {
        failureError = outcome.error;
        return;
      }
      results.push(outcome.value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return failureError !== undefined ? err(failureError) : ok(results);
}

export async function createImages(config: Config, deps: { blobs: Blobstore; db: Persistence; logger: Logger; render?: Renderer; events?: Events }, now: () => number = Date.now): Promise<Images> {
  const { blobs, db, logger } = deps;
  const renderImage: Renderer = deps.render ?? render;
  const bus = deps.events;

  const collections: Array<[string, Schema]> = [
    [SIZES, { name: "string", width: "number", height: "number", fit: "string", format: "string", quality: "number", source: "string", updatedAt: "number" }],
    [VARIANTS, { mediaId: "string", size: "string", spec: "string", width: "number", height: "number", format: "string", key: "string", bytes: "number", state: "string", error: "json", attempts: "number", updatedAt: "number" }],
    [JOBS, { state: "string", total: "number", done: "number", failed: "number", cursor: "string", startedAt: "number", updatedAt: "number", finishedAt: "json", error: "json" }],
    [RETIRED, { mediaId: "string", file: "string", retiredAt: "number" }],
  ];
  for (const [collection, schema] of collections) {
    const prepared = await db.ensureCollection(collection, schema);
    if (isErr(prepared)) throw new Error(`images/default: cannot prepare collection "${collection}": ${prepared.error.message}`);
  }

  const baseSizes: Size[] = config.sizes ?? DEFAULT_SIZES;
  const baseSource: "default" | "config" = config.sizes ? "config" : "default";
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const staleSizeRows = await db.deleteMany(SIZES, {});
  if (isErr(staleSizeRows)) throw new Error(`images/default: cannot drop persisted size rows: ${staleSizeRows.error.message}`);
  if (staleSizeRows.value > 0) logger.info(`images/default: dropped ${staleSizeRows.value} persisted size rows, sizes are rebuilt from config and images.register`);

  if (config.publicCopy !== undefined) {
    const tree = publicTree();
    if (tree.startsWith(config.prefix) || config.prefix.startsWith(tree)) {
      throw new Error(`images/default: publicCopy tree "${tree}" and prefix "${config.prefix}" overlap – the public copies must not share a prefix with the stored files`);
    }
  }

  const initialSizes = mergeSizes(baseSizes, baseSource, []);
  if (isErr(initialSizes)) throw new Error(`images/default: ${initialSizes.error.message}`);
  let effective: SizeRow[] = initialSizes.value;
  let registrySeen = false;
  let closed = false;

  function publicTree(): string {
    return `${config.publicCopy?.prefix ?? ""}${config.publicPath.slice(1)}/`;
  }
  function copyKey(mediaId: string, file: string): string {
    return `${publicTree()}${mediaId}/variants/${file}`;
  }
  function variantKey(mediaId: string, size: string, ext: string): string {
    return `${config.prefix}${mediaId}/${size}.${ext}`;
  }

  const latestJob = await db.findMany<Job>(JOBS, {}, { sort: { startedAt: "desc" }, limit: 1 });
  if (isErr(latestJob)) throw new Error(`images/default: cannot read the sync job: ${latestJob.error.message}`);
  let currentJobId: string | null = latestJob.value.items[0]?.id ?? null;

  let loopActive = false;
  let stopRequested = false;
  let idleWaiters: Array<() => void> = [];
  const placingQueue = new Set<Promise<void>>();

  const notifyIdle = (): void => {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const idle = (): Promise<void> => (loopActive ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve());

  async function idlePlacing(): Promise<void> {
    while (placingQueue.size > 0) await Promise.allSettled([...placingQueue]);
  }

  function raiseMediaUpdated(ids: string[]): void {
    if (bus === undefined || ids.length === 0) return;
    void bus.emit("media.updated", withEventIdentity("media.updated", { id: null, ids, identity: null, params: {} })).catch((cause: unknown) => {
      logger.error("images: media.updated was rejected by a subscriber", { ids, error: errorMessage(cause) });
    });
  }

  function schedulePlacement(mediaId: string): void {
    const promise = new Promise<void>((resolve) => {
      setImmediate(() => {
        void planIds([mediaId])
          .catch((cause: unknown) => {
            logger.error(`images: background placement for ${mediaId} failed`, { mediaId, error: errorMessage(cause) });
          })
          .then(() => resolve());
      });
    });
    placingQueue.add(promise);
    void promise.finally(() => placingQueue.delete(promise));
  }

  async function orphanedVariants(accounted: number): Promise<Result<{ sizes: string[]; variants: number }, KestrelError>> {
    const total = await db.count(VARIANTS, {});
    if (isErr(total)) return total;
    if (total.value === accounted) return ok({ sizes: [], variants: 0 });
    const declared = new Set(effective.map((size) => size.name));
    const counts = new Map<string, number>();
    for (let offset = 0; ; offset += 500) {
      const page = await db.findMany<Variant>(VARIANTS, {}, { sort: { id: "asc" }, limit: 500, offset });
      if (isErr(page)) return page;
      for (const row of page.value.items) {
        if (!declared.has(row.size)) counts.set(row.size, (counts.get(row.size) ?? 0) + 1);
      }
      if (page.value.items.length < 500) break;
    }
    return ok({ sizes: [...counts.keys()].sort(), variants: [...counts.values()].reduce((sum, n) => sum + n, 0) });
  }

  const inFlight = new Map<string, Promise<Result<Variant[], KestrelError>>>();

  function generate(mediaId: string): Promise<Result<Variant[], KestrelError>> {
    const running = inFlight.get(mediaId);
    if (running) return running;
    const promise = generateOnce(mediaId);
    inFlight.set(mediaId, promise);
    void promise.finally(() => inFlight.delete(mediaId));
    return promise;
  }

  async function renderWithin(original: Uint8Array, size: Size, planned: { width: number; height: number; format: string }): Promise<Result<Rendered, KestrelError>> {
    const settled = renderImage(original, size, planned).then(
      (rendered) => ({ rendered }),
      (cause: unknown) => ({ cause }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), config.renderTimeoutMs);
    });
    try {
      const outcome = await Promise.race([settled, expiry]);
      if (outcome === "timeout") return err(failure("TRANSIENT", `render timed out after ${config.renderTimeoutMs}ms`));
      if ("cause" in outcome) return err(failure("VALIDATION", errorMessage(outcome.cause), { cause: outcome.cause }));
      return ok(outcome.rendered);
    } finally {
      clearTimeout(timer);
    }
  }

  async function originalDimensions(media: MediaRow): Promise<Result<{ decodable: boolean; ow: number; oh: number; bytes: Uint8Array | null }, KestrelError>> {
    const blob = await blobs.get(media.key);
    if (isErr(blob)) return blob;
    if (blob.value === null) return ok({ decodable: false, ow: 0, oh: 0, bytes: null });
    const oriented = await orientedOriginalDimensions(blob.value);
    return ok(oriented ? { decodable: true, ow: oriented.width, oh: oriented.height, bytes: blob.value } : { decodable: false, ow: 0, oh: 0, bytes: blob.value });
  }

  async function planItem(mediaId: string): Promise<Result<{ changed: boolean }, KestrelError>> {
    const media = await db.findOne<MediaRow>(config.media.collection, { id: mediaId });
    if (isErr(media)) return media;
    if (media.value === null || !isMediaReady(media.value) || !eligible(media.value.contentType)) return ok({ changed: false });
    const mediaRow = media.value;

    const stored = await db.findMany<Variant>(VARIANTS, { mediaId }, { limit: effective.length + 50 });
    if (isErr(stored)) return stored;
    const byName = new Map(stored.value.items.map((row) => [row.size, row]));

    interface Task {
      size: Size;
      row?: Variant;
      kind: "new" | "respec" | "reformat";
    }
    const tasks: Task[] = [];
    for (const size of effective) {
      const row = byName.get(size.name);
      const wantFormat = plannedFormat(size, mediaRow.contentType);
      if (row === undefined) {
        tasks.push({ size, kind: "new" });
        continue;
      }
      if (row.spec === spec(size) && row.state !== "planned") continue;
      if (row.spec === spec(size) && row.state === "planned") {
        tasks.push({ size, row, kind: "new" });
        continue;
      }
      tasks.push({ size, row, kind: row.format === wantFormat ? "respec" : "reformat" });
    }
    if (tasks.length === 0) return ok({ changed: false });

    const dims = await originalDimensions(mediaRow);
    if (isErr(dims)) return dims;
    if (dims.value.bytes === null) return err(failure("TRANSIENT", `images: original blob ${mediaRow.key} for ${mediaId} is missing`));
    const { decodable, ow, oh, bytes: original } = dims.value;

    for (const task of tasks) {
      if (task.kind !== "reformat") continue;
      const row = task.row!;
      const retired = await db.createOne<Retired>(RETIRED, { mediaId, file: fileOf(row), retiredAt: now() });
      if (isErr(retired)) return retired;
      if (config.publicCopy !== undefined) {
        const overwritten = await blobs.put(copyKey(mediaId, fileOf(row)), original, { contentType: mediaRow.contentType });
        if (isErr(overwritten)) return overwritten;
      }
      const dropped = await blobs.remove(row.key);
      if (isErr(dropped)) return dropped;
    }

    const toPlace: Variant[] = [];
    for (const task of tasks) {
      const planned = decodable ? plannedDimensions(task.size, ow, oh) : { width: mediaRow.width ?? 0, height: mediaRow.height ?? 0 };
      const format = plannedFormat(task.size, mediaRow.contentType);
      if (task.kind === "respec") {
        const updated = await db.updateOne<Variant>(VARIANTS, task.row!.id, { width: planned.width, height: planned.height, spec: spec(task.size), state: "pending", updatedAt: now() });
        if (isErr(updated)) return updated;
        continue;
      }
      if (task.kind === "new" && task.row !== undefined) {
        if (task.row.state === "planned") toPlace.push(task.row);
        continue;
      }
      const ext = plannedExt(task.size, mediaRow.contentType);
      const key = variantKey(mediaId, task.size.name, ext);
      if (!decodable) {
        const created = await db.createOne<Variant>(VARIANTS, { mediaId, size: task.size.name, spec: spec(task.size), width: planned.width, height: planned.height, format, key, bytes: 0, state: "failed", error: "cannot decode", attempts: 0, updatedAt: now() });
        if (isErr(created)) return created;
        toPlace.push(created.value);
        continue;
      }
      const created = await db.createOne<Variant>(VARIANTS, { mediaId, size: task.size.name, spec: spec(task.size), width: planned.width, height: planned.height, format, key, bytes: 0, state: "planned", error: null, attempts: 0, updatedAt: now() });
      if (isErr(created)) return created;
      toPlace.push(created.value);
    }

    if (config.publicCopy !== undefined && toPlace.length > 0) {
      const placed = await pool(
        toPlace.map((row) => async (): Promise<Result<void, KestrelError>> => {
          const put = await blobs.put(copyKey(mediaId, fileOf(row)), original, { contentType: mediaRow.contentType });
          if (isErr(put)) return put;
          const advanced = await db.updateMany<Variant>(VARIANTS, { id: row.id, state: "planned" }, { state: "pending", updatedAt: now() });
          if (isErr(advanced)) return advanced;
          return ok(undefined);
        }),
        PLACEMENT_CONCURRENCY,
      );
      if (isErr(placed)) return placed;
    } else if (toPlace.length > 0) {
      for (const row of toPlace) {
        if (row.state !== "planned") continue;
        const advanced = await db.updateOne<Variant>(VARIANTS, row.id, { state: "pending", updatedAt: now() });
        if (isErr(advanced)) return advanced;
      }
    }
    return ok({ changed: true });
  }

  async function planIds(mediaIds: string[]): Promise<Result<void, KestrelError>> {
    const changedIds: string[] = [];
    for (const mediaId of mediaIds) {
      const planned = await planItem(mediaId);
      if (isErr(planned)) return planned;
      if (planned.value.changed) changedIds.push(mediaId);
    }
    raiseMediaUpdated(changedIds);
    return ok(undefined);
  }

  async function renderVariant(mediaId: string, size: Size, row: Variant, original: Uint8Array): Promise<Result<{ patch: Partial<Variant>; ok: boolean }, KestrelError>> {
    const attempt = await renderWithin(original, size, { width: row.width, height: row.height, format: row.format });
    const attempts = row.attempts + 1;
    if (isErr(attempt)) {
      if (row.state === "planned") return ok({ patch: { attempts: row.attempts, error: attempt.error.message }, ok: false });
      const failedState = attempts >= maxAttempts ? "failed" : "error";
      return ok({ patch: { state: failedState, attempts, error: attempt.error.message, updatedAt: now() }, ok: false });
    }
    const rendered = attempt.value;
    const stored = await blobs.put(row.key, rendered.data, { contentType: rendered.contentType });
    if (isErr(stored)) return stored;
    if (config.publicCopy !== undefined) {
      const copied = await blobs.put(copyKey(mediaId, fileOf(row)), rendered.data, { contentType: rendered.contentType });
      if (isErr(copied)) return copied;
    }
    return ok({ patch: { state: "done", bytes: rendered.data.byteLength, attempts, error: null, updatedAt: now() }, ok: true });
  }

  async function generateOnce(mediaId: string): Promise<Result<Variant[], KestrelError>> {
    const media = await db.findOne<MediaRow>(config.media.collection, { id: mediaId });
    if (isErr(media)) return media;
    if (media.value === null || !isMediaReady(media.value) || !eligible(media.value.contentType)) return ok([]);
    const mediaRow = media.value;

    const stored = await db.findMany<Variant>(VARIANTS, { mediaId }, { limit: effective.length + 50 });
    if (isErr(stored)) return stored;
    const byName = new Map(stored.value.items.map((row) => [row.size, row]));

    const missing = effective.filter((size) => !byName.has(size.name));
    if (missing.length > 0) {
      const dims = await originalDimensions(mediaRow);
      if (isErr(dims)) return dims;
      const { decodable, ow, oh } = dims.value;
      const rows: NewDocument<Variant>[] = missing.map((size) => {
        const planned = decodable ? plannedDimensions(size, ow, oh) : { width: mediaRow.width ?? 0, height: mediaRow.height ?? 0 };
        const format = plannedFormat(size, mediaRow.contentType);
        const ext = plannedExt(size, mediaRow.contentType);
        return { mediaId, size: size.name, spec: spec(size), width: planned.width, height: planned.height, format, key: variantKey(mediaId, size.name, ext), bytes: 0, state: decodable ? "planned" : "failed", error: decodable ? null : "cannot decode", attempts: 0, updatedAt: now() };
      });
      const created = await db.createMany<Variant>(VARIANTS, rows);
      if (isErr(created)) return created;
      for (const row of created.value) byName.set(row.size, row);
    }

    let original: Uint8Array | null = null;
    const needsOriginal = effective.some((size) => {
      const row = byName.get(size.name)!;
      return row.spec === spec(size) ? row.state === "planned" || row.state === "pending" || row.state === "error" : false;
    });
    if (needsOriginal) {
      const blob = await blobs.get(mediaRow.key);
      if (isErr(blob)) return blob;
      original = blob.value;
    }

    const results: Variant[] = [];
    let anyDone = false;
    for (const size of effective) {
      const row = byName.get(size.name)!;
      if (row.spec !== spec(size) || row.state === "done" || row.state === "failed") {
        results.push(row);
        continue;
      }
      if (original === null) {
        results.push(row);
        continue;
      }
      const attempted = await renderVariant(mediaId, size, row, original);
      if (isErr(attempted)) return attempted;
      const updated = await db.updateOne<Variant>(VARIANTS, row.id, attempted.value.patch);
      if (isErr(updated)) return updated;
      results.push(updated.value);
      if (attempted.value.ok) anyDone = true;
      if (!attempted.value.ok && updated.value.state === "error") logger.error(`images: variant ${size.name} for media/${mediaId} failed, attempt ${updated.value.attempts}`, { mediaId, size: size.name, error: updated.value.error });
      if (!attempted.value.ok && updated.value.state === "failed") logger.error(`images: variant ${size.name} for media/${mediaId} gave up after ${updated.value.attempts} attempts`, { mediaId, size: size.name, error: updated.value.error });
    }

    if (anyDone) {
      const reread = await db.findOne<MediaRow>(config.media.collection, { id: mediaId });
      if (isErr(reread)) return reread;
      if (reread.value === null || !isMediaReady(reread.value)) {
        const removed = await removeVariants(mediaId);
        if (isErr(removed)) return removed;
        return ok([]);
      }
    }

    if (results.some((row) => row.state === "planned")) schedulePlacement(mediaId);
    return ok(results);
  }

  async function loopOnce(): Promise<Result<"more" | "done", KestrelError>> {
    const found = await db.findOne<Job>(JOBS, { id: currentJobId! });
    if (isErr(found)) return found;
    const job = found.value;
    if (!job) return ok("done");
    const filter = job.cursor === "" ? {} : { id: { gt: job.cursor } };
    const page = await db.findMany<MediaRow>(config.media.collection, filter, { sort: { id: "asc" }, limit: config.chunk });
    if (isErr(page)) return page;
    if (page.value.items.length === 0) {
      const closedJob = await db.updateOne<Job>(JOBS, job.id, { state: "done", finishedAt: now(), updatedAt: now() });
      if (isErr(closedJob)) return closedJob;
      return ok("done");
    }
    let done = job.done;
    let failed = job.failed;
    const changedIds: string[] = [];
    for (const media of page.value.items) {
      const placed = await planItem(media.id);
      if (isErr(placed)) return placed;
      if (placed.value.changed) changedIds.push(media.id);
      const variants = await generate(media.id);
      if (isErr(variants)) return variants;
      if (variants.value.some((v) => v.state === "error" || v.state === "failed")) failed += 1;
      else done += 1;
      const progressed = await db.updateOne<Job>(JOBS, job.id, { done, failed, updatedAt: now() });
      if (isErr(progressed)) return progressed;
    }
    raiseMediaUpdated(changedIds);
    const cursor = page.value.items[page.value.items.length - 1]!.id;
    const finished = page.value.items.length < config.chunk;
    const advanced = await db.updateOne<Job>(JOBS, job.id, finished ? { done, failed, cursor, state: "done", finishedAt: now(), updatedAt: now() } : { done, failed, cursor, updatedAt: now() });
    if (isErr(advanced)) return advanced;
    return ok(finished ? "done" : "more");
  }

  async function recordJobFailure(message: string): Promise<void> {
    if (currentJobId) {
      try {
        const marked = await db.updateOne<Job>(JOBS, currentJobId, { state: "error", error: message, updatedAt: now() });
        if (isErr(marked)) logger.error("images: could not record the sync job failure", { job: currentJobId, error: marked.error.message });
      } catch (cause) {
        logger.error("images: could not record the sync job failure", { job: currentJobId, error: errorMessage(cause) });
      }
    }
    logger.error("images: sync job failed", { error: message });
  }

  function runLoop(): void {
    setImmediate(() => {
      void (async () => {
        if (stopRequested) {
          loopActive = false;
          notifyIdle();
          return;
        }
        try {
          const outcome = await loopOnce();
          if (isErr(outcome)) await recordJobFailure(outcome.error.message);
          else if (outcome.value === "more" && !stopRequested) {
            runLoop();
            return;
          }
        } catch (cause) {
          await recordJobFailure(errorMessage(cause));
        }
        loopActive = false;
        notifyIdle();
      })();
    });
  }

  function startLoop(): void {
    if (loopActive) return;
    loopActive = true;
    stopRequested = false;
    runLoop();
  }

  let starting: Promise<Result<Job, KestrelError>> | null = null;

  async function currentJob(): Promise<Result<Job | null, KestrelError>> {
    if (!currentJobId) return ok(null);
    return db.findOne<Job>(JOBS, { id: currentJobId });
  }

  async function startSync(fromStart: boolean): Promise<Result<Job, KestrelError>> {
    const found = await currentJob();
    if (isErr(found)) return found;
    const job = found.value;
    if (job && job.state === "running" && now() - job.updatedAt < config.staleAfterMs) {
      return err(failure("CONFLICT", `images: sync job ${job.id} is running`));
    }
    let target: Job;
    if (job && job.state !== "done" && !fromStart) {
      const resumed = await db.updateOne<Job>(JOBS, job.id, { state: "running", updatedAt: now() });
      if (isErr(resumed)) return resumed;
      target = resumed.value;
    } else {
      const total = await db.count(config.media.collection, {});
      if (isErr(total)) return total;
      const created = await db.createOne<Job>(JOBS, { state: "running", total: total.value, done: 0, failed: 0, cursor: "", startedAt: now(), updatedAt: now(), finishedAt: null, error: null });
      if (isErr(created)) return created;
      target = created.value;
      currentJobId = target.id;
    }
    startLoop();
    return ok(target);
  }

  function beginSync(fromStart: boolean): Promise<Result<Job, KestrelError>> {
    if (closed) return Promise.resolve(err(failure("CONFLICT", "images: images are shutting down")));
    if (starting) return starting;
    const promise = startSync(fromStart).finally(() => {
      starting = null;
    });
    starting = promise;
    return promise;
  }

  async function variantsOf(mediaIds: string[]): Promise<Result<Map<string, Variant[]>, KestrelError>> {
    const map = new Map<string, Variant[]>();
    for (const id of mediaIds) map.set(id, []);
    for (let i = 0; i < mediaIds.length; i += 200) {
      const chunk = mediaIds.slice(i, i + 200);
      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<Variant>(VARIANTS, { mediaId: { in: chunk } }, { limit: 500, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) map.get(row.mediaId)?.push(row);
        if (page.value.items.length < 500) break;
      }
    }
    return ok(map);
  }

  async function variantCounts(mediaIds: string[]): Promise<Result<Map<string, VariantCounts>, KestrelError>> {
    const counts = new Map<string, VariantCounts>();
    for (const id of mediaIds) counts.set(id, { done: 0, pending: 0, error: 0, failed: 0 });
    if (mediaIds.length === 0) return ok(counts);

    const eligibleIds: string[] = [];
    for (let i = 0; i < mediaIds.length; i += 200) {
      const chunk = mediaIds.slice(i, i + 200);
      const rows = await db.findMany<MediaRow>(config.media.collection, { id: { in: chunk } }, { limit: chunk.length });
      if (isErr(rows)) return rows;
      for (const row of rows.value.items) if (eligible(row.contentType)) eligibleIds.push(row.id);
    }
    if (eligibleIds.length === 0) return ok(counts);

    const byMedia = await variantsOf(eligibleIds);
    if (isErr(byMedia)) return byMedia;

    for (const id of eligibleIds) {
      const byName = new Map((byMedia.value.get(id) ?? []).map((row) => [row.size, row]));
      const tally: VariantCounts = { done: 0, pending: 0, error: 0, failed: 0 };
      for (const size of effective) {
        const row = byName.get(size.name);
        if (row !== undefined && row.state === "done" && row.spec === spec(size)) tally.done += 1;
        else if (row !== undefined && row.state === "error") tally.error += 1;
        else if (row !== undefined && row.state === "failed") tally.failed += 1;
        else tally.pending += 1;
      }
      counts.set(id, tally);
    }
    return ok(counts);
  }

  async function removeVariants(mediaId: string): Promise<Result<number, KestrelError>> {
    let removed = 0;
    for (;;) {
      const page = await db.findMany<Variant>(VARIANTS, { mediaId }, { limit: 500 });
      if (isErr(page)) return page;
      if (page.value.items.length === 0) break;
      for (const variant of page.value.items) {
        if (config.publicCopy !== undefined) {
          const droppedCopy = await blobs.remove(copyKey(mediaId, fileOf(variant)));
          if (isErr(droppedCopy)) return droppedCopy;
        }
        const dropped = await blobs.remove(variant.key);
        if (isErr(dropped)) return dropped;
        const deleted = await db.deleteOne(VARIANTS, variant.id);
        if (isErr(deleted)) return deleted;
        removed += 1;
      }
      if (page.value.items.length < 500) break;
    }
    for (;;) {
      const page = await db.findMany<Retired>(RETIRED, { mediaId }, { limit: 500 });
      if (isErr(page)) return page;
      if (page.value.items.length === 0) break;
      for (const row of page.value.items) {
        if (config.publicCopy !== undefined) {
          const droppedCopy = await blobs.remove(copyKey(mediaId, row.file));
          if (isErr(droppedCopy)) return droppedCopy;
        }
        const deleted = await db.deleteOne(RETIRED, row.id);
        if (isErr(deleted)) return deleted;
      }
      if (page.value.items.length < 500) break;
    }
    if (config.publicCopy !== undefined) {
      const treePrefix = `${publicTree()}${mediaId}/variants/`;
      const listed = await blobs.list(treePrefix);
      if (isErr(listed)) return listed;
      for (const info of listed.value) {
        const removedCopy = await blobs.remove(info.key);
        if (isErr(removedCopy)) return removedCopy;
      }
    }
    const privatePrefix = `${config.prefix}${mediaId}/`;
    const listedBlobs = await blobs.list(privatePrefix);
    if (isErr(listedBlobs)) return listedBlobs;
    for (const info of listedBlobs.value) {
      const removedBlob = await blobs.remove(info.key);
      if (isErr(removedBlob)) return removedBlob;
    }
    return ok(removed);
  }

  async function readyEligibleCount(): Promise<Result<number, KestrelError>> {
    let n = 0;
    for (let offset = 0; ; offset += 500) {
      const page = await db.findMany<MediaRow>(config.media.collection, { status: "ready" }, { limit: 500, offset });
      if (isErr(page)) return page;
      for (const row of page.value.items) if (eligible(row.contentType)) n += 1;
      if (page.value.items.length < 500) break;
    }
    return ok(n);
  }

  async function detectAndStartSync(): Promise<void> {
    if (closed) return;
    const total = await readyEligibleCount();
    if (isErr(total)) {
      logger.error("images: could not check for a size-set shortfall", { error: total.error.message });
      return;
    }
    if (total.value === 0) return;
    for (const size of effective) {
      const matching = await db.count(VARIANTS, { size: size.name, spec: spec(size) });
      if (isErr(matching)) {
        logger.error("images: could not check for a size-set shortfall", { error: matching.error.message });
        return;
      }
      if (matching.value < total.value) {
        await beginSync(false).catch(() => undefined);
        return;
      }
    }
  }

  const api: Images = {
    async register(input) {
      if (!Array.isArray(input) || input.length === 0) return err(failure("VALIDATION", "images: registry must not be empty"));
      const parsed: Size[] = [];
      for (const raw of input) {
        const size = parseSize(raw);
        if (isErr(size)) return size;
        parsed.push(size.value);
      }
      const merged = mergeSizes(baseSizes, baseSource, parsed);
      if (isErr(merged)) return merged;
      const changed = merged.value.some((row) => {
        const previous = effective.find((r) => r.name === row.name);
        return previous === undefined || spec(previous) !== spec(row);
      });
      effective = merged.value;
      registrySeen = true;
      if (changed) await detectAndStartSync();
      return ok(merged.value);
    },

    async sizes() {
      return effective;
    },

    async exists(mediaId) {
      const media = await db.findOne<MediaRow>(config.media.collection, { id: mediaId });
      if (isErr(media)) return media;
      return ok(media.value !== null);
    },

    plan: planIds,
    generate,

    sync() {
      return beginSync(false);
    },

    async resume() {
      if (closed) return err(failure("CONFLICT", "images: images are shutting down"));
      const stalePlanned = await db.findMany<Variant>(VARIANTS, { state: "planned" }, { limit: REPAIR_SAMPLE, sort: { updatedAt: "asc" } });
      if (isErr(stalePlanned)) return stalePlanned;
      const ids = new Set(stalePlanned.value.items.map((row) => row.mediaId));
      const orphanCutoff = now() - NEW_ITEM_WINDOW_MS;
      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<MediaRow & { createdAt?: number }>(config.media.collection, { status: "ready" }, { limit: 500, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) {
          if (!eligible(row.contentType)) continue;
          if (typeof row.createdAt === "number" && row.createdAt < orphanCutoff) continue;
          const has = await db.count(VARIANTS, { mediaId: row.id });
          if (isErr(has)) return has;
          if (has.value === 0) ids.add(row.id);
        }
        if (page.value.items.length < 500) break;
        if (ids.size >= REPAIR_SAMPLE) break;
      }
      if (ids.size > 0) {
        const list = [...ids].slice(0, REPAIR_SAMPLE);
        const placed = await planIds(list);
        if (isErr(placed)) return placed;
        for (const id of list) {
          const generated = await generate(id);
          if (isErr(generated)) return generated;
        }
      }

      const found = await currentJob();
      if (isErr(found)) return found;
      const job = found.value;
      if (!job || job.state === "done") return ok(null);
      if (job.state === "running" && now() - job.updatedAt < config.staleAfterMs) return ok(null);
      const target = await db.updateOne<Job>(JOBS, job.id, { state: "running", updatedAt: now() });
      if (isErr(target)) return target;
      startLoop();
      return ok(target.value);
    },

    async retryFailed(mediaId) {
      if (closed) return err(failure("CONFLICT", "images: images are shutting down"));
      const filter: Filter = mediaId === undefined ? { state: "failed" } : { mediaId, state: "failed" };
      const affected = new Set<string>();
      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<Variant>(VARIANTS, filter, { sort: { id: "asc" }, limit: 500, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) affected.add(row.mediaId);
        if (page.value.items.length < 500) break;
      }
      if (affected.size === 0) return ok({ variants: 0, media: 0, job: null });
      const reset = await db.updateMany<Variant>(VARIANTS, filter, { state: "pending", error: null, attempts: 0, updatedAt: now() });
      if (isErr(reset)) return reset;
      if (mediaId !== undefined) {
        const regenerated = await generate(mediaId);
        if (isErr(regenerated)) return regenerated;
        return ok({ variants: reset.value, media: affected.size, job: null });
      }
      const started = await beginSync(true);
      if (!isErr(started)) return ok({ variants: reset.value, media: affected.size, job: started.value });
      if (started.error.code !== "CONFLICT") return started;
      const running = await currentJob();
      if (isErr(running)) return running;
      return ok({ variants: reset.value, media: affected.size, job: running.value });
    },

    async prune(names) {
      const uniqueNames = [...new Set(names)];
      const declared = new Set(effective.map((size) => size.name));
      for (const name of uniqueNames) {
        if (declared.has(name)) return err(failure("VALIDATION", `images: size "${name}" is a declared size, not an orphan`));
        const used = await db.count(VARIANTS, { size: name });
        if (isErr(used)) return used;
        if (used.value === 0) return err(failure("VALIDATION", `images: size "${name}" has no variants`));
      }
      let sizesDeleted = 0;
      let variantsDeleted = 0;
      const affectedIds = new Set<string>();
      for (const name of uniqueNames) {
        for (;;) {
          const page = await db.findMany<Variant>(VARIANTS, { size: name }, { limit: 500 });
          if (isErr(page)) return page;
          if (page.value.items.length === 0) break;
          for (const variant of page.value.items) {
            const retired = await db.createOne<Retired>(RETIRED, { mediaId: variant.mediaId, file: fileOf(variant), retiredAt: now() });
            if (isErr(retired)) return retired;
            if (config.publicCopy !== undefined) {
              const media = await db.findOne<MediaRow>(config.media.collection, { id: variant.mediaId });
              if (isErr(media)) return media;
              if (media.value !== null) {
                const original = await blobs.get(media.value.key);
                if (isErr(original)) return original;
                if (original.value !== null) {
                  const overwritten = await blobs.put(copyKey(variant.mediaId, fileOf(variant)), original.value, { contentType: media.value.contentType });
                  if (isErr(overwritten)) return overwritten;
                }
              }
            }
            const droppedBlob = await blobs.remove(variant.key);
            if (isErr(droppedBlob)) return droppedBlob;
            const dropped = await db.deleteOne(VARIANTS, variant.id);
            if (isErr(dropped)) return dropped;
            variantsDeleted += 1;
            affectedIds.add(variant.mediaId);
          }
          if (page.value.items.length < 500) break;
        }
        sizesDeleted += 1;
      }
      for (let i = 0; i < affectedIds.size; i += 200) {
        raiseMediaUpdated([...affectedIds].slice(i, i + 200));
      }
      return ok({ sizes: sizesDeleted, variants: variantsDeleted });
    },

    async status() {
      const sizesOut: ImagesStatus["sizes"] = [];
      let declaredVariants = 0;
      for (const row of effective) {
        const [done, pending, planned, error, failed] = await Promise.all([
          db.count(VARIANTS, { size: row.name, state: "done" }),
          db.count(VARIANTS, { size: row.name, state: "pending" }),
          db.count(VARIANTS, { size: row.name, state: "planned" }),
          db.count(VARIANTS, { size: row.name, state: "error" }),
          db.count(VARIANTS, { size: row.name, state: "failed" }),
        ]);
        if (isErr(done)) return done;
        if (isErr(pending)) return pending;
        if (isErr(planned)) return planned;
        if (isErr(error)) return error;
        if (isErr(failed)) return failed;
        declaredVariants += done.value + pending.value + planned.value + error.value + failed.value;
        sizesOut.push({ ...row, used: row.source === "registered", variants: { done: done.value, pending: pending.value + planned.value, error: error.value, failed: failed.value } });
      }
      const job = await currentJob();
      if (isErr(job)) return job;
      const failedTotal = await db.count(VARIANTS, { state: "failed" });
      if (isErr(failedTotal)) return failedTotal;
      const recent = await db.findMany<Variant>(VARIANTS, { state: "failed" }, { sort: { updatedAt: "desc" }, limit: FAILURE_SAMPLE });
      if (isErr(recent)) return recent;
      const failed = {
        variants: failedTotal.value,
        recent: recent.value.items.map((row) => ({ mediaId: row.mediaId, size: row.size, attempts: row.attempts, error: row.error, updatedAt: row.updatedAt })),
      };
      if (!registrySeen) return ok({ sizes: sizesOut, job: job.value, orphaned: { sizes: [], variants: 0 }, registrySeen, failed });
      const orphaned = await orphanedVariants(declaredVariants);
      if (isErr(orphaned)) return orphaned;
      return ok({ sizes: sizesOut, job: job.value, orphaned: orphaned.value, registrySeen, failed });
    },

    remove: removeVariants,

    variantsOf,
    variantCounts,

    async read(mediaId, file) {
      const media = await db.findOne<MediaRow>(config.media.collection, { id: mediaId });
      if (isErr(media)) return media;
      if (media.value === null || !isMediaReady(media.value)) return ok(null);
      const dot = file.lastIndexOf(".");
      const sizeName = dot === -1 ? file : file.slice(0, dot);
      const row = await db.findOne<Variant>(VARIANTS, { mediaId, size: sizeName });
      if (isErr(row)) return row;
      const isCurrent = row.value !== null && fileOf(row.value) === file;
      if (!isCurrent) {
        const retired = await db.findOne<Retired>(RETIRED, { mediaId, file });
        if (isErr(retired)) return retired;
        if (retired.value === null) return ok(null);
        return originalFallback(media.value);
      }
      const variant = row.value;
      if (variant.state !== "planned") {
        const blob = await blobs.get(variant.key);
        if (isErr(blob)) return blob;
        if (blob.value !== null) return ok({ data: blob.value, contentType: contentTypeOf(variant.format), fallback: false, variant: "done" });
      }
      return originalFallback(media.value);
    },

    async exportTo(dir) {
      const base = resolvePath(dir);
      let written = 0;
      let skipped = 0;
      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<Variant>(VARIANTS, { state: "done" }, { sort: { id: "asc" }, limit: 500, offset });
        if (isErr(page)) return page;
        for (const variant of page.value.items) {
          const media = await db.findOne<MediaRow>(config.media.collection, { id: variant.mediaId });
          if (isErr(media)) return media;
          if (media.value === null) {
            skipped += 1;
            continue;
          }
          const target = resolvePath(base, media.value.folder, `${media.value.filename}.${variant.size}${extname(variant.key)}`);
          const rel = relative(base, target);
          if (rel.startsWith(`..${sep}`) || rel === ".." || rel === "") throw new Error(`images/default: export target ${target} escapes ${base}`);
          const existing = await stat(target).catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return null;
            throw cause;
          });
          if (existing && existing.size === variant.bytes && existing.mtimeMs >= variant.updatedAt) {
            skipped += 1;
            continue;
          }
          const blob = await blobs.get(variant.key);
          if (isErr(blob)) return blob;
          if (blob.value === null) {
            skipped += 1;
            continue;
          }
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, blob.value);
          const updated = new Date(variant.updatedAt);
          await utimes(target, updated, updated);
          written += 1;
        }
        if (page.value.items.length < 500) break;
      }
      return ok({ written, skipped });
    },

    publicPath(mediaId, variant) {
      return `${config.publicPath}/${mediaId}/variants/${fileOf(variant)}`;
    },

    publicCopyEnabled() {
      return config.publicCopy !== undefined;
    },

    async syncPublic() {
      if (config.publicCopy === undefined) return ok({ written: 0, removed: 0, planned: 0, missing: 0 });
      const tree = publicTree();
      const listed = await blobs.list(tree);
      if (isErr(listed)) return listed;
      const files = new Map<string, { mediaId: string; file: string; size: number }>();
      for (const info of listed.value) {
        const rest = info.key.slice(tree.length);
        const slash = rest.indexOf("/variants/");
        if (slash === -1) continue;
        const mediaId = rest.slice(0, slash);
        const file = rest.slice(slash + "/variants/".length);
        if (file.includes("/")) continue;
        files.set(info.key, { mediaId, file, size: info.size });
      }

      let written = 0;
      let removed = 0;
      let planned = 0;
      let missing = 0;
      const expected = new Set<string>();
      let syncNeeded = false;

      const mediaIds = new Set<string>();
      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<MediaRow>(config.media.collection, { status: "ready" }, { limit: 500, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) if (eligible(row.contentType)) mediaIds.add(row.id);
        if (page.value.items.length < 500) break;
      }

      for (const mediaId of mediaIds) {
        const count = await db.count(VARIANTS, { mediaId });
        if (isErr(count)) return count;
        if (count.value >= effective.length) continue;
        const placed = await planItem(mediaId);
        if (isErr(placed)) return placed;
        if (placed.value.changed) planned += 1;
      }

      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<Variant>(VARIANTS, {}, { limit: 500, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) {
          if (!mediaIds.has(row.mediaId)) {
            const droppedCopy = await blobs.remove(copyKey(row.mediaId, fileOf(row)));
            if (isErr(droppedCopy)) return droppedCopy;
            const droppedBlob = await blobs.remove(row.key);
            if (isErr(droppedBlob)) return droppedBlob;
            const deleted = await db.deleteOne(VARIANTS, row.id);
            if (isErr(deleted)) return deleted;
            continue;
          }
          if (row.state === "planned") {
            planned += 1;
            syncNeeded = true;
            continue;
          }
          const key = copyKey(row.mediaId, fileOf(row));
          expected.add(key);
          const entry = files.get(key);
          const expectedSize = row.state === "done" ? row.bytes : null;
          if (entry !== undefined && (expectedSize === null || entry.size === expectedSize)) continue;
          const source = row.state === "done" ? await doneBytesOf(row) : await originalBytesOf(row.mediaId);
          if (isErr(source)) return source;
          if (source.value === null) {
            missing += 1;
            continue;
          }
          const put = await blobs.put(key, source.value.data, { contentType: source.value.contentType });
          if (isErr(put)) return put;
          const reread = await db.findOne<Variant>(VARIANTS, { id: row.id });
          if (isErr(reread)) return reread;
          if (reread.value === null) {
            const undone = await blobs.remove(key);
            if (isErr(undone)) return undone;
            expected.delete(key);
            continue;
          }
          written += 1;
          if (row.state !== "done") syncNeeded = true;
        }
        if (page.value.items.length < 500) break;
      }

      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<Retired>(RETIRED, {}, { limit: 500, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) {
          if (!mediaIds.has(row.mediaId)) {
            const dropped = await blobs.remove(copyKey(row.mediaId, row.file));
            if (isErr(dropped)) return dropped;
            const deleted = await db.deleteOne(RETIRED, row.id);
            if (isErr(deleted)) return deleted;
            continue;
          }
          const key = copyKey(row.mediaId, row.file);
          expected.add(key);
          if (files.has(key)) continue;
          const source = await originalBytesOf(row.mediaId);
          if (isErr(source)) return source;
          if (source.value === null) {
            missing += 1;
            continue;
          }
          const put = await blobs.put(key, source.value.data, { contentType: source.value.contentType });
          if (isErr(put)) return put;
          written += 1;
        }
        if (page.value.items.length < 500) break;
      }

      for (const [key] of files) {
        if (expected.has(key)) continue;
        const dropped = await blobs.remove(key);
        if (isErr(dropped)) return dropped;
        removed += 1;
      }

      if (syncNeeded && !loopActive) startLoop();
      return ok({ written, removed, planned, missing });
    },

    attach(kestrel) {
      void detectAndStartSync();
      const pipelines = kestrel.describe().pipelines;
      const runs = (name: string): boolean => pipelines.some((p) => p.steps.some((s) => s.module === "images/default" && s.name === name));
      if (config.publicCopy === undefined) {
        const offender = pipelines.find((p) => p.steps.some((s) => s.module === "images/default" && s.name === "images.syncPublic"));
        if (offender) throw new Error(`images/default: pipeline "${offender.name}" runs images.syncPublic, but publicCopy is not set`);
        return;
      }
      if (!runs("images.serve")) {
        throw new Error(`images/default: publicCopy is set, but no pipeline runs images.serve – the public URL ${config.publicPath}/<id>/variants/<size>.<ext> must also resolve on this origin`);
      }
    },

    async close() {
      closed = true;
      stopRequested = true;
      await idle();
      await idlePlacing();
      const found = await currentJob();
      if (isErr(found)) {
        logger.error("images: could not read the sync job while shutting down", { job: currentJobId, error: found.error.message });
        return;
      }
      if (found.value && found.value.state === "running") {
        const paused = await db.updateOne<Job>(JOBS, found.value.id, { state: "paused", updatedAt: now() });
        if (isErr(paused)) logger.error("images: could not pause the sync job while shutting down", { job: found.value.id, error: paused.error.message });
      }
    },
  };

  async function originalFallback(media: MediaRow): Promise<Result<VariantBlob | null, KestrelError>> {
    const blob = await blobs.get(media.key);
    if (isErr(blob)) return blob;
    if (blob.value === null) return ok(null);
    return ok({ data: blob.value, contentType: media.contentType, fallback: true, variant: "original" });
  }

  async function doneBytesOf(row: Variant): Promise<Result<{ data: Uint8Array; contentType: string } | null, KestrelError>> {
    const blob = await blobs.get(row.key);
    if (isErr(blob)) return blob;
    if (blob.value === null) return ok(null);
    return ok({ data: blob.value, contentType: contentTypeOf(row.format) });
  }

  async function originalBytesOf(mediaId: string): Promise<Result<{ data: Uint8Array; contentType: string } | null, KestrelError>> {
    const media = await db.findOne<MediaRow>(config.media.collection, { id: mediaId });
    if (isErr(media)) return media;
    if (media.value === null) return ok(null);
    const blob = await blobs.get(media.value.key);
    if (isErr(blob)) return blob;
    if (blob.value === null) return ok(null);
    return ok({ data: blob.value, contentType: media.value.contentType });
  }

  Object.defineProperty(api, IDLE_HOOK, { value: () => Promise.all([idle(), idlePlacing()]), enumerable: false });
  return api;
}

const IDLE_HOOK: unique symbol = Symbol("images.idleHook");

interface WithIdleHook {
  [IDLE_HOOK]?: () => Promise<void>;
}

export function whenIdle(images: Images): Promise<void> {
  const hook = (images as Images & WithIdleHook)[IDLE_HOOK];
  return hook ? hook() : Promise.resolve();
}
