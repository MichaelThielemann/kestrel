import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve as resolvePath, sep } from "node:path";
import type { Blob, Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Document, Persistence, Schema } from "@michaelthielemann/kestrel-contracts/persistence";
import { failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import type { z } from "zod";
import { eligible, render } from "./generate.ts";
import { DEFAULT_SIZES, mergeSizes, sizeSchema, spec } from "./sizes.ts";
import type { Size, SizeRow } from "./sizes.ts";
import type { configSchema } from "./module.ts";

export const SIZES = "images_sizes";
export const VARIANTS = "images_variants";
export const JOBS = "images_jobs";

export const DEFAULT_MAX_ATTEMPTS = 5;

export type Config = z.output<typeof configSchema>;

export interface Variant extends Document {
  mediaId: string;
  size: string;
  spec: string;
  width: number;
  height: number;
  format: string;
  key: string;
  bytes: number;
  state: "pending" | "done" | "error" | "failed";
  error: string | null;
  attempts: number;
  updatedAt: number;
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

export interface ImagesStatus {
  sizes: Array<SizeRow & { used: boolean; variants: { done: number; pending: number; error: number; failed: number } }>;
  job: Job | null;
  orphaned: { sizes: string[]; variants: number };
  registrySeen: boolean;
}

export interface VariantBlob {
  data: Uint8Array;
  contentType: string;
  fallback: boolean;
  variant: "done" | "pending";
}

export interface VariantFailure {
  size: string;
  attempts: number;
  error: string | null;
}

export interface Images {
  register(sizes: unknown): Promise<Result<SizeRow[], KestrelError>>;
  sizes(): Promise<SizeRow[]>;
  exists(mediaId: string): Promise<Result<boolean, KestrelError>>;
  generate(mediaId: string): Promise<Result<Variant[], KestrelError>>;
  sync(): Promise<Result<Job, KestrelError>>;
  resume(): Promise<Result<Job | null, KestrelError>>;
  prune(names: string[]): Promise<Result<{ sizes: number; variants: number }, KestrelError>>;
  status(): Promise<Result<ImagesStatus, KestrelError>>;
  remove(mediaId: string): Promise<Result<number, KestrelError>>;
  variantsOf(mediaIds: string[]): Promise<Result<Map<string, Variant[]>, KestrelError>>;
  read(mediaId: string, file: string): Promise<Result<VariantBlob | null, KestrelError>>;
  failure(mediaId: string, file: string): Promise<Result<VariantFailure | null, KestrelError>>;
  exportTo(dir: string): Promise<Result<{ written: number; skipped: number }, KestrelError>>;
  publicPath(mediaId: string, variant: Variant): string;
  close(): Promise<void>;
}

interface MediaRow extends Document {
  key: string;
  contentType: string;
  folder: string;
  filename: string;
}

type RenderedVariant = Omit<Variant, "id" | "mediaId" | "size" | "attempts" | "updatedAt">;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseSize(raw: unknown): Result<Size, KestrelError> {
  const parsed = sizeSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const issue = parsed.error.issues[0];
  return err(failure("VALIDATION", `images: ${issue?.path.join(".") ?? "size"}: ${issue?.message ?? "invalid size"}`));
}

export async function createImages(config: Config, deps: { blobs: Blobstore; db: Persistence; logger: Logger }, now: () => number = Date.now): Promise<Images> {
  const { blobs, db, logger } = deps;

  const collections: Array<[string, Schema]> = [
    [SIZES, { name: "string", width: "number", height: "number", fit: "string", format: "string", quality: "number", source: "string", updatedAt: "number" }],
    [VARIANTS, { mediaId: "string", size: "string", spec: "string", width: "number", height: "number", format: "string", key: "string", bytes: "number", state: "string", error: "json", attempts: "number", updatedAt: "number" }],
    [JOBS, { state: "string", total: "number", done: "number", failed: "number", cursor: "string", startedAt: "number", updatedAt: "number", finishedAt: "json", error: "json" }],
  ];
  for (const [collection, schema] of collections) {
    const prepared = await db.ensureCollection(collection, schema);
    if (isErr(prepared)) throw new Error(`images/default: cannot prepare collection "${collection}": ${prepared.error.message}`);
  }

  const baseSizes: Size[] = config.sizes ?? DEFAULT_SIZES;
  const baseSource: "default" | "config" = config.sizes ? "config" : "default";
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // sizes are declared in code (config or images.register), so a stored copy would outlive the code
  // that defined it; earlier versions persisted them, and those rows are dropped once here.
  const staleSizeRows = await db.deleteMany(SIZES, {});
  if (isErr(staleSizeRows)) throw new Error(`images/default: cannot drop persisted size rows: ${staleSizeRows.error.message}`);
  if (staleSizeRows.value > 0) logger.info(`images/default: dropped ${staleSizeRows.value} persisted size rows, sizes are rebuilt from config and images.register`);

  const initialSizes = mergeSizes(baseSizes, baseSource, []);
  if (isErr(initialSizes)) throw new Error(`images/default: ${initialSizes.error.message}`);
  let effective: SizeRow[] = initialSizes.value;
  // until this process has seen a register() call it cannot tell a variant of a size the code no
  // longer declares from a variant of a size that simply has not been registered yet.
  let registrySeen = false;
  let closed = false;

  const latestJob = await db.findMany<Job>(JOBS, {}, { sort: { startedAt: "desc" }, limit: 1 });
  if (isErr(latestJob)) throw new Error(`images/default: cannot read the sync job: ${latestJob.error.message}`);
  let currentJobId: string | null = latestJob.value.items[0]?.id ?? null;

  let loopActive = false;
  let stopRequested = false;
  let idleWaiters: Array<() => void> = [];

  const notifyIdle = (): void => {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const idle = (): Promise<void> => (loopActive ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve());

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

  // concurrent callers for the same mediaId (an upload event and the sync loop both reaching it, say)
  // must not read-then-write the variant rows independently, or they duplicate them; the second
  // caller instead awaits the first caller's in-flight render.
  const inFlight = new Map<string, Promise<Result<Variant[], KestrelError>>>();

  function generate(mediaId: string): Promise<Result<Variant[], KestrelError>> {
    const running = inFlight.get(mediaId);
    if (running) return running;
    const promise = generateOnce(mediaId);
    inFlight.set(mediaId, promise);
    void promise.finally(() => inFlight.delete(mediaId));
    return promise;
  }

  async function renderVariant(mediaId: string, size: Size, original: Blob, previousKey: string): Promise<Result<RenderedVariant, KestrelError>> {
    let rendered;
    try {
      rendered = await render(original.data, size);
    } catch (cause) {
      return err(failure("VALIDATION", errorMessage(cause), { cause }));
    }
    const key = `${config.prefix}${mediaId}/${size.name}.${rendered.ext}`;
    // a format change moves the variant to a new key; the old blob would otherwise be orphaned
    // with nothing referencing it.
    if (previousKey !== "" && previousKey !== key) {
      const dropped = await blobs.remove(previousKey);
      if (isErr(dropped)) return dropped;
    }
    const stored = await blobs.put(key, { data: rendered.data, contentType: rendered.contentType });
    if (isErr(stored)) return stored;
    return ok({ spec: spec(size), width: rendered.width, height: rendered.height, format: rendered.format, key, bytes: rendered.data.byteLength, state: "done", error: null });
  }

  async function generateOnce(mediaId: string): Promise<Result<Variant[], KestrelError>> {
    const media = await db.findOne<MediaRow>(config.media.collection, { id: mediaId });
    if (isErr(media)) return media;
    if (media.value === null || !eligible(media.value.contentType)) return ok([]);

    const stored = await db.findMany<Variant>(VARIANTS, { mediaId }, { limit: effective.length + 50 });
    if (isErr(stored)) return stored;
    const byName = new Map(stored.value.items.map((row) => [row.size, row]));
    const upToDate = (size: Size): boolean => {
      const row = byName.get(size.name);
      return row !== undefined && row.state === "done" && row.spec === spec(size);
    };
    // a size whose definition changed is new work, so the exhausted attempt count of the old spec
    // must not keep the variant quarantined.
    const exhausted = (size: Size): boolean => {
      const row = byName.get(size.name);
      return row !== undefined && row.state === "failed" && row.spec === spec(size);
    };

    let original: Blob | null = null;
    if (effective.some((size) => !upToDate(size) && !exhausted(size))) {
      const found = await blobs.get(media.value.key);
      if (isErr(found)) return found;
      original = found.value;
    }

    const results: Variant[] = [];
    for (const size of effective) {
      const row = byName.get(size.name);
      if (upToDate(size) || exhausted(size)) {
        results.push(row!);
        continue;
      }
      // a redefined size is new work, so lifting the quarantine also restores the full attempt budget
      const attempts = (row !== undefined && row.state === "failed" ? 0 : (row?.attempts ?? 0)) + 1;
      const previousKey = row?.key ?? "";
      // the row is written as "pending" before the render so a crash mid-render leaves a retryable
      // state rather than a stale "done", and read() falls back to the original meanwhile.
      const pending: Omit<Variant, "id" | "mediaId" | "size"> = { spec: spec(size), width: row?.width ?? 0, height: row?.height ?? 0, format: row?.format ?? "", key: previousKey, bytes: row?.bytes ?? 0, state: "pending", error: null, attempts, updatedAt: now() };
      const current = row ? await db.updateOne<Variant>(VARIANTS, row.id, pending) : await db.createOne<Variant>(VARIANTS, { mediaId, size: size.name, ...pending });
      if (isErr(current)) return current;
      const failedState = attempts >= maxAttempts ? "failed" : "error";
      let patch: Omit<Variant, "id" | "mediaId" | "size">;
      if (original === null) {
        patch = { ...pending, state: failedState, error: "original blob missing", updatedAt: now() };
      } else {
        const written = await renderVariant(mediaId, size, original, previousKey);
        patch = isErr(written) ? { ...pending, state: failedState, error: written.error.message, updatedAt: now() } : { ...written.value, attempts, updatedAt: now() };
      }
      if (patch.state === "failed") logger.error(`images: variant ${size.name} for media/${mediaId} gave up after ${attempts} attempts`, { mediaId, size: size.name, error: patch.error });
      const updated = await db.updateOne<Variant>(VARIANTS, current.value.id, patch);
      if (isErr(updated)) return updated;
      results.push(updated.value);
    }
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
    for (const media of page.value.items) {
      const variants = await generate(media.id);
      if (isErr(variants)) return variants;
      if (variants.value.some((v) => v.state === "error" || v.state === "failed")) failed += 1;
      else done += 1;
      // per image, not per chunk: a long chunk would otherwise look stalled to /admin/images/status
      // and trip the staleAfterMs takeover.
      const progressed = await db.updateOne<Job>(JOBS, job.id, { done, failed, updatedAt: now() });
      if (isErr(progressed)) return progressed;
    }
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

  async function startSync(): Promise<Result<Job, KestrelError>> {
    const found = await currentJob();
    if (isErr(found)) return found;
    const job = found.value;
    if (job && job.state === "running" && now() - job.updatedAt < config.staleAfterMs) {
      return err(failure("CONFLICT", `images: sync job ${job.id} is running`));
    }
    let target: Job;
    if (job && job.state !== "done") {
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
      effective = merged.value;
      registrySeen = true;
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

    generate,

    sync() {
      if (closed) return Promise.resolve(err(failure("CONFLICT", "images: images are shutting down")));
      // two callers arriving in the same tick must not both create a job row; the second awaits the
      // first caller's in-flight start instead.
      if (starting) return starting;
      const promise = startSync().finally(() => {
        starting = null;
      });
      starting = promise;
      return promise;
    },

    async resume() {
      if (closed) return err(failure("CONFLICT", "images: images are shutting down"));
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
      for (const name of uniqueNames) {
        for (;;) {
          const page = await db.findMany<Variant>(VARIANTS, { size: name }, { limit: 500 });
          if (isErr(page)) return page;
          if (page.value.items.length === 0) break;
          for (const variant of page.value.items) {
            const removed = await blobs.remove(variant.key);
            if (isErr(removed)) return removed;
            const dropped = await db.deleteOne(VARIANTS, variant.id);
            if (isErr(dropped)) return dropped;
            variantsDeleted += 1;
          }
          if (page.value.items.length < 500) break;
        }
        sizesDeleted += 1;
      }
      return ok({ sizes: sizesDeleted, variants: variantsDeleted });
    },

    async status() {
      const sizesOut: ImagesStatus["sizes"] = [];
      let declaredVariants = 0;
      for (const row of effective) {
        const [done, pending, error, failed] = await Promise.all([
          db.count(VARIANTS, { size: row.name, state: "done" }),
          db.count(VARIANTS, { size: row.name, state: "pending" }),
          db.count(VARIANTS, { size: row.name, state: "error" }),
          db.count(VARIANTS, { size: row.name, state: "failed" }),
        ]);
        if (isErr(done)) return done;
        if (isErr(pending)) return pending;
        if (isErr(error)) return error;
        if (isErr(failed)) return failed;
        declaredVariants += done.value + pending.value + error.value + failed.value;
        sizesOut.push({ ...row, used: row.source === "registered", variants: { done: done.value, pending: pending.value, error: error.value, failed: failed.value } });
      }
      const job = await currentJob();
      if (isErr(job)) return job;
      if (!registrySeen) return ok({ sizes: sizesOut, job: job.value, orphaned: { sizes: [], variants: 0 }, registrySeen });
      const orphaned = await orphanedVariants(declaredVariants);
      if (isErr(orphaned)) return orphaned;
      return ok({ sizes: sizesOut, job: job.value, orphaned: orphaned.value, registrySeen });
    },

    async remove(mediaId) {
      let removed = 0;
      for (;;) {
        const page = await db.findMany<Variant>(VARIANTS, { mediaId }, { limit: 500 });
        if (isErr(page)) return page;
        if (page.value.items.length === 0) break;
        for (const variant of page.value.items) {
          const dropped = await blobs.remove(variant.key);
          if (isErr(dropped)) return dropped;
          const deleted = await db.deleteOne(VARIANTS, variant.id);
          if (isErr(deleted)) return deleted;
          removed += 1;
        }
        if (page.value.items.length < 500) break;
      }
      return ok(removed);
    },

    async variantsOf(mediaIds) {
      const map = new Map<string, Variant[]>();
      for (const id of mediaIds) map.set(id, []);
      // SQLite caps bound parameters, so a large `in` filter is chunked rather than sent in one query.
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
    },

    async read(mediaId, file) {
      const dot = file.lastIndexOf(".");
      const sizeName = dot === -1 ? file : file.slice(0, dot);
      if (!effective.some((size) => size.name === sizeName)) return ok(null);
      const media = await db.findOne<MediaRow>(config.media.collection, { id: mediaId });
      if (isErr(media)) return media;
      if (media.value === null) return ok(null);
      const found = await db.findOne<Variant>(VARIANTS, { mediaId, size: sizeName });
      if (isErr(found)) return found;
      const variant = found.value;
      if (variant && variant.state === "done") {
        const blob = await blobs.get(variant.key);
        if (isErr(blob)) return blob;
        if (blob.value) return ok({ data: blob.value.data, contentType: blob.value.contentType, fallback: false, variant: "done" });
      }
      // a variant that gave up will never become available; serving the full-size original in its
      // place would hide the defect behind a working-looking page forever.
      if (variant && variant.state === "failed") return ok(null);
      const original = await blobs.get(media.value.key);
      if (isErr(original)) return original;
      if (original.value === null) return ok(null);
      return ok({ data: original.value.data, contentType: media.value.contentType, fallback: true, variant: "pending" });
    },

    async failure(mediaId, file) {
      const dot = file.lastIndexOf(".");
      const sizeName = dot === -1 ? file : file.slice(0, dot);
      const found = await db.findOne<Variant>(VARIANTS, { mediaId, size: sizeName });
      if (isErr(found)) return found;
      const variant = found.value;
      return ok(variant && variant.state === "failed" ? { size: variant.size, attempts: variant.attempts, error: variant.error } : null);
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
          await writeFile(target, blob.value.data);
          const updated = new Date(variant.updatedAt);
          await utimes(target, updated, updated);
          written += 1;
        }
        if (page.value.items.length < 500) break;
      }
      return ok({ written, skipped });
    },

    publicPath(mediaId, variant) {
      return `${config.publicPath}/${mediaId}/variants/${variant.size}${extname(variant.key)}`;
    },

    async close() {
      // set before the first await: sync()/resume() called anywhere in this same tick (or later)
      // answer CONFLICT rather than racing a job into "running" that the stopped loop will never pick up.
      closed = true;
      stopRequested = true;
      await idle();
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

  idleHooks.set(api, idle);
  return api;
}

// test-only hook to await the sync loop's in-process setImmediate chain; not part of the Images
// interface since production callers never need to observe it.
const idleHooks = new WeakMap<Images, () => Promise<void>>();
export function whenIdle(images: Images): Promise<void> {
  return (idleHooks.get(images) ?? (() => Promise.resolve()))();
}
