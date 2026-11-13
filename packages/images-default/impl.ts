import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve as resolvePath, sep } from "node:path";
import type { Introspection } from "@michaelthielemann/kestrel";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import { withEventIdentity } from "@michaelthielemann/kestrel-contracts/helpers/events.envelope";
import type { MediaFile, MediaFiles, MediaFilter, MediaScan } from "@michaelthielemann/kestrel-contracts/media";
import { contentMatchesMediaType, publicFormOf } from "@michaelthielemann/kestrel-contracts/helpers/mediaType";
import type { Document, Filter, Persistence, Schema } from "@michaelthielemann/kestrel-contracts/persistence";
import { failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import type { z } from "zod";
import { framingView, type FramingView } from "./framed.ts";
import { EMPTY_FRAMING, cropToken, effectiveCrop, formatCrop, parseCrop, parseFraming, type Framing, type PixelCrop, type Rect } from "./framing.ts";
import { contentTypeOf, eligible, ELIGIBLE, render } from "./generate.ts";
import type { Planned, Rendered, Renderer } from "./generate.ts";
import { orientedOriginalDimensions, plannedDimensions, plannedExt, plannedFormat } from "./plan.ts";
import { DEFAULT_SIZES, mergeSizes, sizeSchema, spec } from "./sizes.ts";
import type { Size, SizeRow } from "./sizes.ts";
import type { configSchema } from "./module.ts";

export const SIZES = "images_sizes";
export const VARIANTS = "images_variants";
export const JOBS = "images_jobs";
export const RETIRED = "images_retired";
export const HIDDEN = "images_hidden";
export const FRAMING = "images_framing";

/** Every collection this module stores; the persistence handle it is given reaches these and no other. */
export const COLLECTIONS: readonly string[] = [SIZES, VARIANTS, JOBS, RETIRED, HIDDEN, FRAMING];

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RENDER_TIMEOUT_MS = 30000;

const FAILURE_SAMPLE = 20;
const PLACEMENT_CONCURRENCY = 4;
const REPAIR_SAMPLE = 200;
const NEW_ITEM_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE = 500;
const EVENT_CHUNK = 200;
const VARIANTS_CHANGED = "images.variantsChanged";
const UNDECODABLE = "cannot decode";
const TIMED_OUT = "render timed out";

export type Config = z.output<typeof configSchema>;

export type VariantState = "planned" | "pending" | "done" | "error" | "failed";

export interface Variant extends Document {
  mediaId: string;
  size: string;
  /** `<mediaId>/<size>`; unique, so the store holds at most one row per item and size. */
  slot: string;
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
  /** The crop the row renders with, as `"left,top,width,height"` on the oriented original; `""` or `null` cuts from the centre. */
  crop: string | null;
  /** The crop of the bytes the last finished render left at the path, in the form of `crop`; `""` or `null` for the centre or no render yet. */
  renderedCrop: string | null;
  /** The width of the original after its EXIF orientation, as the row was planned; `0` or `null` when it is not known. */
  originalWidth: number | null;
  /** The height of the original after its EXIF orientation, as the row was planned; `0` or `null` when it is not known. */
  originalHeight: number | null;
}

export interface Retired extends Document {
  mediaId: string;
  file: string;
  /** `<mediaId>/<file>`; unique, so a file is retired at most once. */
  slot: string;
  retiredAt: number;
}

/** Whether a media item's variants are hidden: without public copies, not served and not exported until it is shown again. */
export interface Hidden extends Document {
  mediaId: string;
  hidden: boolean;
  /** The trash version of the move that set `hidden`; a hide or show with a lower version is ignored. */
  version: number;
  updatedAt: number;
}

/** The framing of one media item, with the oriented dimensions of the original it was set on. */
export interface FramingRow extends Document {
  mediaId: string;
  focus: Rect | null;
  crops: Record<string, Rect>;
  width: number;
  height: number;
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
  /** The variant's public URL, `<publicPath>/<id>/variants/<file>`; once a render with a crop is at that path, followed by `?v=<cropToken>` of that crop. */
  publicPath(mediaId: string, variant: Variant): string;
  publicCopyEnabled(): boolean;
  syncPublic(): Promise<Result<PublicSync, KestrelError>>;
  /** Withdraws the public copies of each known item's variants and retired paths; they are not served, exported or copied again until {@link Images.show}. Rows and private variants stay. Unknown ids are ignored. With `versions` (the media item's trash version per id), an id whose last hide or show carried a higher version is left alone, so the move that happened last decides; an entry that is not a whole number of at least zero counts as missing. */
  hide(mediaIds: string[], versions?: Readonly<Record<string, number>>): Promise<Result<void, KestrelError>>;
  /** Lifts {@link Images.hide} and writes the public copies of each item again; `versions` as for {@link Images.hide}. */
  show(mediaIds: string[], versions?: Readonly<Record<string, number>>): Promise<Result<void, KestrelError>>;
  /** The ids among `mediaIds` that are hidden. */
  hidden(mediaIds: string[]): Promise<Result<Set<string>, KestrelError>>;
  /** Replaces the framing of an eligible, ready, not hidden item (`NOT_FOUND` otherwise; `VALIDATION` for an invalid one, see `parseFraming`) and re-plans the item: each `cover` size whose crop changes renders again at its path. An empty framing removes the stored one. */
  setFraming(mediaId: string, input: unknown): Promise<Result<{ id: string; framing: Framing }, KestrelError>>;
  /** The framing of each id with one entry per ratio of the effective `cover` sizes; an id without a stored framing gets the empty one. */
  framingsOf(mediaIds: string[]): Promise<Result<Map<string, FramingView>, KestrelError>>;
  attach(kestrel: Introspection): void;
  close(): Promise<void>;
}

type NewVariant = Pick<Variant, "mediaId" | "size" | "slot" | "spec" | "width" | "height" | "format" | "key" | "bytes" | "state" | "error" | "attempts" | "updatedAt" | "crop" | "renderedCrop" | "originalWidth" | "originalHeight">;

interface Content {
  data: Uint8Array;
  contentType: string;
  rendered: boolean;
}

interface Owner {
  row: Variant | null;
  retired: Retired | null;
}

interface Original {
  data: Uint8Array;
  publishedType: string;
}

function publicTypeOf(contentType: string): string {
  return publicFormOf(contentType).contentType;
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

function slotOf(mediaId: string, name: string): string {
  return `${mediaId}/${name}`;
}

function sizeNameOf(file: string): string {
  const dot = file.indexOf(".");
  return dot === -1 ? file : file.slice(0, dot);
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

function cropOf(row: Pick<Variant, "crop">): string {
  return row.crop ?? "";
}

function renderedCropOf(row: Pick<Variant, "renderedCrop">): string {
  return row.renderedCrop ?? "";
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function isEmptyFraming(framing: Framing): boolean {
  return framing.focus === null && Object.keys(framing.crops).length === 0;
}

function trashVersionOf(versions: Readonly<Record<string, number>> | undefined, mediaId: string): number | undefined {
  const version = versions?.[mediaId];
  return version !== undefined && Number.isSafeInteger(version) && version >= 0 ? version : undefined;
}

export async function createImages(config: Config, deps: { blobs: Blobstore; db: Persistence; media: MediaFiles; logger: Logger; render?: Renderer; events?: Events }, now: () => number = Date.now): Promise<Images> {
  const { blobs, db, logger } = deps;
  const library = deps.media;
  const renderImage: Renderer = deps.render ?? render;
  const bus = deps.events;

  const collections: Array<[string, Schema]> = [
    [SIZES, { name: "string", width: "number", height: "number", fit: "string", format: "string", quality: "number", source: "string", updatedAt: "number" }],
    [VARIANTS, { mediaId: "string", size: "string", slot: { type: "string", unique: true }, spec: "string", width: "number", height: "number", format: "string", key: "string", bytes: "number", state: "string", error: "json", attempts: "number", updatedAt: "number", crop: "string", renderedCrop: "string", originalWidth: "number", originalHeight: "number" }],
    [JOBS, { state: "string", total: "number", done: "number", failed: "number", cursor: "string", startedAt: "number", updatedAt: "number", finishedAt: "json", error: "json" }],
    [RETIRED, { mediaId: "string", file: "string", slot: { type: "string", unique: true }, retiredAt: "number" }],
    [HIDDEN, { mediaId: { type: "string", unique: true }, hidden: "boolean", version: "number", updatedAt: "number" }],
    [FRAMING, { mediaId: { type: "string", unique: true }, focus: "json", crops: "json", width: "number", height: "number", updatedAt: "number" }],
  ];
  for (const [collection, schema] of collections) {
    const prepared = await db.ensureCollection(collection, schema);
    if (isErr(prepared)) throw new Error(`images/default: cannot prepare collection "${collection}": ${prepared.error.message}`);
  }

  for (const collection of [VARIANTS, RETIRED]) {
    const unslotted = await db.count(collection, { slot: { eq: null } });
    if (isErr(unslotted)) throw new Error(`images/default: cannot check "${collection}": ${unslotted.error.message}`);
    if (unslotted.value > 0) {
      throw new Error(`images/default: ${unslotted.value} row(s) in "${collection}" have no slot – they were written before 6.0.0 and this version does not read them; start with empty "${VARIANTS}" and "${RETIRED}" collections`);
    }
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
  const itemTails = new Map<string, Promise<void>>();
  const detections = new Set<Promise<void>>();

  const notifyIdle = (): void => {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const idle = (): Promise<void> => (loopActive ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve());

  async function idlePlacing(): Promise<void> {
    while (placingQueue.size > 0) await Promise.allSettled([...placingQueue]);
  }

  async function idleItems(): Promise<void> {
    while (itemTails.size > 0) await Promise.all([...itemTails.values()]);
  }

  function exclusive<T>(mediaId: string, work: () => Promise<T>): Promise<T> {
    const previous = itemTails.get(mediaId) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    itemTails.set(mediaId, tail);
    void tail.then(() => {
      if (itemTails.get(mediaId) === tail) itemTails.delete(mediaId);
    });
    return run;
  }

  function raiseVariantsChanged(ids: string[]): void {
    if (bus === undefined || ids.length === 0) return;
    for (let i = 0; i < ids.length; i += EVENT_CHUNK) {
      const chunk = ids.slice(i, i + EVENT_CHUNK);
      void bus.emit(VARIANTS_CHANGED, withEventIdentity(VARIANTS_CHANGED, { id: null, ids: chunk, identity: null, params: {} })).catch((cause: unknown) => {
        logger.error(`images: ${VARIANTS_CHANGED} was rejected by a subscriber`, { ids: chunk, error: errorMessage(cause) });
      });
    }
  }

  function schedulePlacement(mediaId: string): void {
    const promise = new Promise<void>((resolve) => {
      setImmediate(() => {
        void planIds([mediaId])
          .then((placed) => {
            if (isErr(placed)) logger.error(`images: background placement for ${mediaId} failed`, { mediaId, error: placed.error.message });
          })
          .catch((cause: unknown) => {
            logger.error(`images: background placement for ${mediaId} failed`, { mediaId, error: errorMessage(cause) });
          })
          .then(() => resolve());
      });
    });
    placingQueue.add(promise);
    void promise.finally(() => placingQueue.delete(promise));
  }

  async function eachRow<T extends Document>(collection: string, filter: Filter, visit: (row: T) => Promise<Result<void, KestrelError>>): Promise<Result<void, KestrelError>> {
    let last: string | null = null;
    for (;;) {
      const pageFilter: Filter = last === null ? filter : { ...filter, id: { gt: last } };
      const page = await db.findMany<T>(collection, pageFilter, { sort: { id: "asc" }, limit: PAGE });
      if (isErr(page)) return page;
      for (const row of page.value.items) {
        const visited = await visit(row);
        if (isErr(visited)) return visited;
      }
      if (page.value.items.length < PAGE) return ok(undefined);
      last = page.value.items[page.value.items.length - 1]!.id;
    }
  }

  async function orphanedVariants(accounted: number): Promise<Result<{ sizes: string[]; variants: number }, KestrelError>> {
    const total = await db.count(VARIANTS, {});
    if (isErr(total)) return total;
    if (total.value === accounted) return ok({ sizes: [], variants: 0 });
    const declared = new Set(effective.map((size) => size.name));
    const counts = new Map<string, number>();
    const walked = await eachRow<Variant>(VARIANTS, {}, async (row) => {
      if (!declared.has(row.size)) counts.set(row.size, (counts.get(row.size) ?? 0) + 1);
      return ok(undefined);
    });
    if (isErr(walked)) return walked;
    return ok({ sizes: [...counts.keys()].sort(), variants: [...counts.values()].reduce((sum, n) => sum + n, 0) });
  }

  async function readMedia(mediaId: string): Promise<Result<MediaFile | null, KestrelError>> {
    return library.file(mediaId);
  }

  async function isHidden(mediaId: string): Promise<Result<boolean, KestrelError>> {
    const marked = await db.count(HIDDEN, { mediaId, hidden: true });
    return isErr(marked) ? marked : ok(marked.value > 0);
  }

  async function hiddenAmong(mediaIds: string[]): Promise<Result<Set<string>, KestrelError>> {
    const found = new Set<string>();
    for (let i = 0; i < mediaIds.length; i += EVENT_CHUNK) {
      const page = await db.findMany<Hidden>(HIDDEN, { mediaId: { in: mediaIds.slice(i, i + EVENT_CHUNK) }, hidden: true }, { limit: EVENT_CHUNK });
      if (isErr(page)) return page;
      for (const row of page.value.items) found.add(row.mediaId);
    }
    return ok(found);
  }

  function storedFraming(row: FramingRow): Framing {
    const parsed = parseFraming({ focus: row.focus, crops: row.crops });
    if (parsed.ok) return parsed.value;
    logger.error(`images: the stored framing of media/${row.mediaId} is invalid and is read as empty`, { mediaId: row.mediaId, error: parsed.error });
    return EMPTY_FRAMING;
  }

  async function readFraming(mediaId: string): Promise<Result<Framing | null, KestrelError>> {
    const found = await db.findOne<FramingRow>(FRAMING, { mediaId });
    if (isErr(found)) return found;
    return ok(found.value === null ? null : storedFraming(found.value));
  }

  async function writeFraming(mediaId: string, framing: Framing, width: number, height: number): Promise<Result<void, KestrelError>> {
    if (isEmptyFraming(framing)) {
      const dropped = await db.deleteMany(FRAMING, { mediaId });
      return isErr(dropped) ? dropped : ok(undefined);
    }
    const fields = { focus: framing.focus, crops: framing.crops, width, height, updatedAt: now() };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await db.findOne<FramingRow>(FRAMING, { mediaId });
      if (isErr(found)) return found;
      if (found.value !== null) {
        const updated = await db.updateOne<FramingRow>(FRAMING, found.value.id, fields);
        return isErr(updated) ? updated : ok(undefined);
      }
      const created = await db.createOne<FramingRow>(FRAMING, { mediaId, ...fields });
      if (!isErr(created)) return ok(undefined);
      if (created.error.code !== "CONFLICT") return created;
    }
    return err(failure("TRANSIENT", `images: the framing of media/${mediaId} was written by another process at the same time – set it again`));
  }

  async function framingsOf(mediaIds: string[]): Promise<Result<Map<string, FramingView>, KestrelError>> {
    const stored = new Map<string, FramingRow>();
    for (let i = 0; i < mediaIds.length; i += EVENT_CHUNK) {
      const chunk = mediaIds.slice(i, i + EVENT_CHUNK);
      const page = await db.findMany<FramingRow>(FRAMING, { mediaId: { in: chunk } }, { limit: chunk.length });
      if (isErr(page)) return page;
      for (const row of page.value.items) stored.set(row.mediaId, row);
    }
    const planned = await variantsOf(mediaIds.filter((id) => !stored.has(id)));
    if (isErr(planned)) return planned;
    const views = new Map<string, FramingView>();
    for (const id of mediaIds) {
      const row = stored.get(id);
      if (row !== undefined) {
        views.set(id, framingView(storedFraming(row), effective, row.width, row.height));
        continue;
      }
      const sized = (planned.value.get(id) ?? []).find((variant) => (variant.originalWidth ?? 0) > 0 && (variant.originalHeight ?? 0) > 0);
      views.set(id, framingView(EMPTY_FRAMING, effective, sized?.originalWidth ?? 0, sized?.originalHeight ?? 0));
    }
    return ok(views);
  }

  async function markHidden(mediaId: string, hidden: boolean, version: number | undefined): Promise<Result<boolean, KestrelError>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await db.findOne<Hidden>(HIDDEN, { mediaId });
      if (isErr(found)) return found;
      const row = found.value;
      if (row === null) {
        if (!hidden && version === undefined) return ok(true);
        const created = await db.createOne<Hidden>(HIDDEN, { mediaId, hidden, version: version ?? 0, updatedAt: now() });
        if (isErr(created)) {
          if (created.error.code === "CONFLICT") continue;
          return created;
        }
        return ok(true);
      }
      if (version !== undefined && version < row.version) return ok(false);
      const updated = await db.updateMany<Hidden>(HIDDEN, { id: row.id, hidden: row.hidden, version: row.version }, { hidden, version: version ?? row.version, updatedAt: now() });
      if (isErr(updated)) return updated;
      if (updated.value > 0) return ok(true);
    }
    return err(failure("TRANSIENT", `images: media/${mediaId} was hidden and shown at the same time – hide or show it again`));
  }

  async function putCopy(mediaId: string, file: string, data: Uint8Array, contentType: string): Promise<Result<boolean, KestrelError>> {
    const key = copyKey(mediaId, file);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const hidden = await isHidden(mediaId);
      if (isErr(hidden)) return hidden;
      if (hidden.value) return ok(false);
      const put = await blobs.put(key, data, { contentType });
      if (isErr(put)) return put;
      const hiddenMeanwhile = await isHidden(mediaId);
      if (isErr(hiddenMeanwhile)) return hiddenMeanwhile;
      if (!hiddenMeanwhile.value) return ok(true);
      const withdrawn = await blobs.remove(key);
      if (isErr(withdrawn)) return withdrawn;
    }
    return err(failure("TRANSIENT", `images: media/${mediaId} was hidden and shown while its copy ${file} was written – write it again`));
  }

  async function removeAllCopies(mediaId: string): Promise<Result<number, KestrelError>> {
    if (config.publicCopy === undefined) return ok(0);
    const listed = await blobs.list(`${publicTree()}${mediaId}/variants/`);
    if (isErr(listed)) return listed;
    for (const info of listed.value) {
      const removed = await blobs.remove(info.key);
      if (isErr(removed)) return removed;
    }
    return ok(listed.value.length);
  }

  async function loadOriginal(mediaId: string): Promise<Result<Original | null, KestrelError>> {
    const loaded = await library.load(mediaId);
    if (isErr(loaded)) return loaded;
    return ok(loaded.value === null ? null : { data: loaded.value.data, publishedType: loaded.value.file.publishedType });
  }

  async function eachMediaFile(filter: MediaFilter, visit: (file: MediaFile) => Promise<Result<void, KestrelError>>): Promise<Result<void, KestrelError>> {
    let after: string | null = null;
    for (;;) {
      const page: Result<MediaScan, KestrelError> = await library.scan(filter, { after, limit: PAGE });
      if (isErr(page)) return page;
      for (const file of page.value.items) {
        const visited = await visit(file);
        if (isErr(visited)) return visited;
      }
      if (page.value.next === null) return ok(undefined);
      after = page.value.next;
    }
  }

  async function rowsOfItem(mediaId: string): Promise<Result<Map<string, Variant>, KestrelError>> {
    const stored = await db.findMany<Variant>(VARIANTS, { mediaId }, { sort: { id: "asc" }, limit: effective.length + 50 });
    if (isErr(stored)) return stored;
    return ok(new Map(stored.value.items.map((row) => [row.size, row])));
  }

  async function ownerOf(mediaId: string, file: string): Promise<Result<Owner, KestrelError>> {
    const row = await db.findOne<Variant>(VARIANTS, { slot: slotOf(mediaId, sizeNameOf(file)) });
    if (isErr(row)) return row;
    if (row.value !== null && fileOf(row.value) === file) return ok({ row: row.value, retired: null });
    const retired = await db.findOne<Retired>(RETIRED, { slot: slotOf(mediaId, file) });
    if (isErr(retired)) return retired;
    return ok({ row: null, retired: retired.value });
  }

  async function contentFor(item: MediaFile, row: Variant | null): Promise<Result<Content | null, KestrelError>> {
    if (row !== null && row.state !== "planned") {
      const rendered = await blobs.get(row.key);
      if (isErr(rendered)) return rendered;
      if (rendered.value !== null) return ok({ data: rendered.value, contentType: publicTypeOf(contentTypeOf(row.format)), rendered: true });
    }
    const original = await loadOriginal(item.id);
    if (isErr(original)) return original;
    if (original.value === null) return ok(null);
    return ok({ data: original.value.data, contentType: original.value.publishedType, rendered: false });
  }

  function sameRow(a: Variant | null, b: Variant | null): boolean {
    if (a === null || b === null) return a === b;
    return a.id === b.id && a.key === b.key && a.spec === b.spec && a.state === b.state && a.bytes === b.bytes;
  }

  async function writeOwnedCopy(mediaId: string, file: string, content: Content, source: Variant | null): Promise<Result<boolean, KestrelError>> {
    const key = copyKey(mediaId, file);
    const put = await putCopy(mediaId, file, content.data, content.contentType);
    if (isErr(put) || !put.value) return put;
    const media = await readMedia(mediaId);
    if (isErr(media)) return media;
    const owner = await ownerOf(mediaId, file);
    if (isErr(owner)) return owner;
    if (media.value === null || (owner.value.row === null && owner.value.retired === null)) {
      const undone = await blobs.remove(key);
      if (isErr(undone)) return undone;
      return ok(false);
    }
    if (sameRow(owner.value.row, source)) return ok(true);
    const current = await contentFor(media.value, owner.value.row);
    if (isErr(current)) return current;
    if (current.value === null) return ok(true);
    return putCopy(mediaId, file, current.value.data, current.value.contentType);
  }

  async function settleWrites<T>(mediaId: string, outcome: Result<T, KestrelError>, whenGone: T): Promise<Result<T, KestrelError>> {
    const media = await readMedia(mediaId);
    if (isErr(media)) return isErr(outcome) ? outcome : media;
    if (media.value !== null) return outcome;
    const removed = await removeVariants(mediaId);
    if (isErr(removed)) return removed;
    return ok(whenGone);
  }

  const generating = new Map<string, Promise<Result<Variant[], KestrelError>>>();
  const removing = new Map<string, number>();

  function generate(mediaId: string): Promise<Result<Variant[], KestrelError>> {
    const running = generating.get(mediaId);
    if (running) return running;
    const promise = exclusive(mediaId, () => generateOnce(mediaId));
    generating.set(mediaId, promise);
    const forget = (): void => {
      if (generating.get(mediaId) === promise) generating.delete(mediaId);
    };
    promise.then(forget, forget);
    return promise;
  }

  function planOne(mediaId: string): Promise<Result<{ changed: boolean }, KestrelError>> {
    return exclusive(mediaId, () => planItem(mediaId));
  }

  async function renderWithin(original: Uint8Array, contentType: string, size: Size, planned: Planned): Promise<Result<Rendered, KestrelError>> {
    if (!contentMatchesMediaType(original, contentType)) return err(failure("VALIDATION", `the original's content does not match its media type ${contentType}`));
    const timedOut = (): Result<Rendered, KestrelError> => err(failure("TRANSIENT", `${TIMED_OUT} after ${config.renderTimeoutMs}ms`));
    const settled = renderImage(original, size, planned, { timeoutSeconds: Math.max(1, Math.ceil(config.renderTimeoutMs / 1000)) }).then(
      (rendered) => ({ rendered }),
      (cause: unknown) => ({ cause }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), config.renderTimeoutMs);
    });
    try {
      const outcome = await Promise.race([settled, expiry]);
      if (outcome === "timeout") return timedOut();
      if ("cause" in outcome && outcome.cause instanceof Error && outcome.cause.message.startsWith("timeout")) return timedOut();
      if ("cause" in outcome) return err(failure("VALIDATION", errorMessage(outcome.cause), { cause: outcome.cause }));
      return ok(outcome.rendered);
    } finally {
      clearTimeout(timer);
    }
  }

  async function originalDimensions(item: MediaFile): Promise<Result<{ decodable: boolean; ow: number; oh: number; original: Original } | null, KestrelError>> {
    const original = await loadOriginal(item.id);
    if (isErr(original)) return original;
    if (original.value === null) return ok(null);
    const oriented = contentMatchesMediaType(original.value.data, item.contentType) ? await orientedOriginalDimensions(original.value.data) : null;
    return ok(oriented ? { decodable: true, ow: oriented.width, oh: oriented.height, original: original.value } : { decodable: false, ow: 0, oh: 0, original: original.value });
  }

  async function missingOriginal(item: MediaFile): Promise<Result<void, KestrelError>> {
    const again = await readMedia(item.id);
    if (isErr(again)) return again;
    if (again.value === null) return ok(undefined);
    return err(failure("INTERNAL", `images: the stored bytes of media/${item.id} are missing`));
  }

  function plannedCrop(size: Size, decodable: boolean, ow: number, oh: number, framing: Framing | null): PixelCrop | null {
    return decodable && framing !== null ? effectiveCrop(framing, size, ow, oh) : null;
  }

  function newRow(item: MediaFile, size: Size, decodable: boolean, ow: number, oh: number, framing: Framing | null): NewVariant {
    const crop = plannedCrop(size, decodable, ow, oh, framing);
    const planned = decodable ? plannedDimensions(size, ow, oh, crop) : { width: item.width ?? 0, height: item.height ?? 0 };
    return {
      mediaId: item.id,
      size: size.name,
      slot: slotOf(item.id, size.name),
      spec: spec(size),
      width: planned.width,
      height: planned.height,
      format: plannedFormat(size, item.contentType),
      key: variantKey(item.id, size.name, plannedExt(size, item.contentType)),
      bytes: 0,
      state: "planned",
      error: decodable ? null : UNDECODABLE,
      attempts: 0,
      updatedAt: now(),
      crop: formatCrop(crop),
      renderedCrop: "",
      originalWidth: decodable ? ow : 0,
      originalHeight: decodable ? oh : 0,
    };
  }

  async function planItem(mediaId: string): Promise<Result<{ changed: boolean }, KestrelError>> {
    const media = await readMedia(mediaId);
    if (isErr(media)) return media;
    if (media.value === null || !eligible(media.value.contentType)) return ok({ changed: false });
    const item = media.value;
    let touched = false;
    const touch = (): void => {
      touched = true;
    };
    let outcome = await placeItem(item, touch);
    for (let attempt = 1; isErr(outcome) && outcome.error.code === "CONFLICT" && attempt < 3; attempt += 1) outcome = await placeItem(item, touch);
    if (!touched) return outcome;
    return settleWrites(mediaId, outcome, { changed: false });
  }

  async function placeItem(item: MediaFile, touch: () => void): Promise<Result<{ changed: boolean }, KestrelError>> {
    const mediaId = item.id;
    const stored = await rowsOfItem(mediaId);
    if (isErr(stored)) return stored;
    const byName = stored.value;
    const framed = await readFraming(mediaId);
    if (isErr(framed)) return framed;
    const framing = framed.value;
    const cropsInPlay = framing !== null || [...byName.values()].some((row) => cropOf(row) !== "");

    const missing: Size[] = [];
    const respec: Array<{ size: Size; row: Variant }> = [];
    const reformat: Array<{ size: Size; row: Variant }> = [];
    const current: Array<{ size: Size; row: Variant }> = [];
    for (const size of effective) {
      const row = byName.get(size.name);
      if (row === undefined) missing.push(size);
      else if (row.spec !== spec(size)) (row.format === plannedFormat(size, item.contentType) ? respec : reformat).push({ size, row });
      else current.push({ size, row });
    }
    const unplaced = current.some(({ row }) => row.state === "planned");
    if (missing.length === 0 && respec.length === 0 && reformat.length === 0 && !unplaced && !cropsInPlay) return ok({ changed: false });

    const dims = await originalDimensions(item);
    if (isErr(dims)) return dims;
    if (dims.value === null) {
      const absent = await missingOriginal(item);
      return isErr(absent) ? absent : ok({ changed: false });
    }
    const { decodable, ow, oh, original } = dims.value;
    const settledState: VariantState = decodable ? "pending" : "failed";

    const toPlace: Variant[] = [];
    const recrop: Array<{ size: Size; row: Variant }> = [];
    for (const entry of current) {
      if (cropOf(entry.row) !== formatCrop(plannedCrop(entry.size, decodable, ow, oh, framing))) recrop.push(entry);
      else if (entry.row.state === "planned") toPlace.push(entry.row);
    }
    if (missing.length === 0 && respec.length === 0 && reformat.length === 0 && toPlace.length === 0 && recrop.length === 0) return ok({ changed: false });
    let changed = missing.length > 0 || respec.length > 0 || reformat.length > 0 || toPlace.length > 0;

    if (missing.length > 0) {
      const created = await db.createMany<Variant>(VARIANTS, missing.map((size) => newRow(item, size, decodable, ow, oh, framing)));
      if (isErr(created)) return created;
      touch();
      toPlace.push(...created.value);
    }

    for (const { size, row } of reformat) {
      touch();
      const oldFile = fileOf(row);
      const retired = await db.createOne<Retired>(RETIRED, { mediaId, file: oldFile, slot: slotOf(mediaId, oldFile), retiredAt: now() });
      if (isErr(retired) && retired.error.code !== "CONFLICT") return retired;
      if (config.publicCopy !== undefined) {
        const overwritten = await putCopy(mediaId, oldFile, original.data, original.publishedType);
        if (isErr(overwritten)) return overwritten;
      }
      const dropped = await blobs.remove(row.key);
      if (isErr(dropped)) return dropped;
      const fresh = newRow(item, size, decodable, ow, oh, framing);
      const replanned = await db.updateOne<Variant>(VARIANTS, row.id, { key: fresh.key, format: fresh.format, spec: fresh.spec, width: fresh.width, height: fresh.height, bytes: 0, state: "planned", error: fresh.error, attempts: 0, updatedAt: now(), crop: fresh.crop, renderedCrop: "", originalWidth: fresh.originalWidth, originalHeight: fresh.originalHeight });
      if (isErr(replanned)) return replanned;
      const current = await db.deleteMany(RETIRED, { slot: slotOf(mediaId, fileOf(replanned.value)) });
      if (isErr(current)) return current;
      toPlace.push(replanned.value);
    }

    for (const { size, row } of [...respec, ...recrop]) {
      touch();
      const fresh = newRow(item, size, decodable, ow, oh, framing);
      const dimsPatch = { spec: fresh.spec, width: fresh.width, height: fresh.height, crop: fresh.crop, originalWidth: fresh.originalWidth, originalHeight: fresh.originalHeight, updatedAt: now() };
      const patch: Partial<Variant> = row.state === "planned" ? dimsPatch : decodable ? { ...dimsPatch, state: "pending", attempts: 0, error: null } : { ...dimsPatch, state: "failed", error: UNDECODABLE };
      const updated = await db.updateMany<Variant>(VARIANTS, { id: row.id, key: row.key, spec: row.spec, state: row.state, crop: row.crop }, patch);
      if (isErr(updated)) return updated;
      if (updated.value === 0) return err(failure("CONFLICT", `images: the variant ${size.name} of media/${mediaId} changed while it was planned`));
      if (row.state === "planned") {
        toPlace.push({ ...row, ...patch });
        changed = true;
      }
    }

    if (config.publicCopy === undefined) {
      for (const row of toPlace) {
        touch();
        const advanced = await db.updateMany<Variant>(VARIANTS, { id: row.id, state: "planned" }, { state: settledState, updatedAt: now() });
        if (isErr(advanced)) return advanced;
      }
      return ok({ changed });
    }

    const placed = await pool(
      toPlace.map((row) => async (): Promise<Result<void, KestrelError>> => {
        touch();
        const file = fileOf(row);
        const put = await putCopy(mediaId, file, original.data, original.publishedType);
        if (isErr(put)) return put;
        const advanced = await db.updateMany<Variant>(VARIANTS, { id: row.id, key: row.key, state: "planned" }, { state: settledState, updatedAt: now() });
        if (isErr(advanced)) return advanced;
        if (advanced.value === 1) return ok(undefined);
        return restoreAfterPlacement(item, file);
      }),
      PLACEMENT_CONCURRENCY,
    );
    if (isErr(placed)) return placed;
    return ok({ changed });
  }

  async function restoreAfterPlacement(item: MediaFile, file: string): Promise<Result<void, KestrelError>> {
    const owner = await ownerOf(item.id, file);
    if (isErr(owner)) return owner;
    if (owner.value.row === null && owner.value.retired === null) {
      const dropped = await blobs.remove(copyKey(item.id, file));
      return isErr(dropped) ? dropped : ok(undefined);
    }
    if (owner.value.row === null || owner.value.row.state === "planned") return ok(undefined);
    const content = await contentFor(item, owner.value.row);
    if (isErr(content)) return content;
    if (content.value === null || !content.value.rendered) return ok(undefined);
    const put = await putCopy(item.id, file, content.value.data, content.value.contentType);
    return isErr(put) ? put : ok(undefined);
  }

  async function planIds(mediaIds: string[]): Promise<Result<void, KestrelError>> {
    const changedIds: string[] = [];
    for (const mediaId of mediaIds) {
      const planned = await planOne(mediaId);
      if (isErr(planned)) {
        raiseVariantsChanged(changedIds);
        return planned;
      }
      if (planned.value.changed) changedIds.push(mediaId);
    }
    raiseVariantsChanged(changedIds);
    return ok(undefined);
  }

  async function generateOnce(mediaId: string): Promise<Result<Variant[], KestrelError>> {
    const media = await readMedia(mediaId);
    if (isErr(media)) return media;
    if (media.value === null || !eligible(media.value.contentType)) return ok([]);
    const item = media.value;
    let touched = false;
    let recropped = false;
    const outcome = await renderItem(
      item,
      () => {
        touched = true;
      },
      () => {
        recropped = true;
      },
    );
    const settled = touched ? await settleWrites(mediaId, outcome, []) : outcome;
    if (recropped) raiseVariantsChanged([mediaId]);
    return settled;
  }

  function renderable(row: Variant, size: Size): boolean {
    return row.spec === spec(size) && (row.state === "planned" || row.state === "pending" || row.state === "error");
  }

  async function renderItem(item: MediaFile, touch: () => void, recrop: () => void): Promise<Result<Variant[], KestrelError>> {
    const mediaId = item.id;
    const stored = await rowsOfItem(mediaId);
    if (isErr(stored)) return stored;
    let byName = stored.value;

    let original: Original | null = null;
    const missing = effective.filter((size) => !byName.has(size.name));
    if (missing.length > 0) {
      const dims = await originalDimensions(item);
      if (isErr(dims)) return dims;
      if (dims.value === null) {
        const gone = await missingOriginal(item);
        return isErr(gone) ? gone : ok([]);
      }
      const { decodable, ow, oh } = dims.value;
      original = dims.value.original;
      const framed = await readFraming(mediaId);
      if (isErr(framed)) return framed;
      const created = await db.createMany<Variant>(VARIANTS, missing.map((size) => newRow(item, size, decodable, ow, oh, framed.value)));
      if (isErr(created)) {
        if (created.error.code !== "CONFLICT") return created;
        const reread = await rowsOfItem(mediaId);
        if (isErr(reread)) return reread;
        byName = reread.value;
      } else {
        touch();
        for (const row of created.value) byName.set(row.size, row);
      }
      if (!decodable) {
        schedulePlacement(mediaId);
        return ok(effective.flatMap((size) => byName.get(size.name) ?? []));
      }
    }

    if (original === null && effective.some((size) => { const row = byName.get(size.name); return row !== undefined && renderable(row, size); })) {
      const loaded = await loadOriginal(mediaId);
      if (isErr(loaded)) return loaded;
      if (loaded.value === null) {
        const gone = await missingOriginal(item);
        return isErr(gone) ? gone : ok([]);
      }
      original = loaded.value;
    }

    const results: Variant[] = [];
    let outOfTime = false;
    for (const size of effective) {
      const row = byName.get(size.name);
      if (row === undefined) continue;
      if (original === null || outOfTime || !renderable(row, size) || removing.has(mediaId)) {
        results.push(row);
        continue;
      }
      const rendered = await renderVariant(item, size, row, original, touch, recrop);
      if (isErr(rendered)) {
        if ([...byName.values()].some((stored) => stored.state === "planned")) schedulePlacement(mediaId);
        return rendered;
      }
      if (rendered.value !== null) results.push(rendered.value);
      if (rendered.value?.error?.startsWith(TIMED_OUT) === true) outOfTime = true;
    }

    if (results.some((row) => row.state === "planned")) schedulePlacement(mediaId);
    return ok(results);
  }

  async function renderVariant(item: MediaFile, size: Size, row: Variant, original: Original, touch: () => void, recrop: () => void): Promise<Result<Variant | null, KestrelError>> {
    const mediaId = item.id;
    const attempt = await renderWithin(original.data, item.contentType, size, { width: row.width, height: row.height, format: row.format, crop: parseCrop(row.crop) });
    const attempts = row.attempts + 1;
    const recordFailure = async (message: string): Promise<Result<Variant, KestrelError>> => {
      const patch: Partial<Variant> = row.state === "planned" ? { error: message } : { state: attempts >= maxAttempts ? "failed" : "error", attempts, error: message, updatedAt: now() };
      const recorded = await db.updateMany<Variant>(VARIANTS, { id: row.id, key: row.key, spec: row.spec, state: row.state, crop: row.crop }, patch);
      if (isErr(recorded)) return recorded;
      const next: Variant = { ...row, ...patch };
      if (next.state === "error") logger.error(`images: variant ${size.name} for media/${mediaId} failed, attempt ${next.attempts}`, { mediaId, size: size.name, error: next.error });
      if (next.state === "failed") logger.error(`images: variant ${size.name} for media/${mediaId} gave up after ${next.attempts} attempts`, { mediaId, size: size.name, error: next.error });
      return ok(next);
    };
    if (isErr(attempt)) return recordFailure(attempt.error.message);

    const fresh = await db.findOne<Variant>(VARIANTS, { id: row.id });
    if (isErr(fresh)) return fresh;
    if (fresh.value === null || fresh.value.key !== row.key || fresh.value.spec !== row.spec || cropOf(fresh.value) !== cropOf(row)) return ok(fresh.value);

    touch();
    const rendered = attempt.value;
    const file = fileOf(row);
    const failWrite = async (error: KestrelError): Promise<Result<Variant | null, KestrelError>> => {
      const recorded = await recordFailure(error.message);
      return isErr(recorded) ? recorded : err(error);
    };
    const stored = await blobs.put(row.key, rendered.data, { contentType: rendered.contentType });
    if (isErr(stored)) return failWrite(stored.error);
    const writeCopy = async (): Promise<Result<void, KestrelError>> => {
      if (config.publicCopy === undefined) return ok(undefined);
      const put = await putCopy(mediaId, file, rendered.data, publicTypeOf(rendered.contentType));
      return isErr(put) ? put : ok(undefined);
    };
    const copied = await writeCopy();
    if (isErr(copied)) return failWrite(copied.error);

    const donePatch: Partial<Variant> = { state: "done", bytes: rendered.data.byteLength, attempts, error: null, updatedAt: now(), renderedCrop: cropOf(row) };
    const committed = await db.updateMany<Variant>(VARIANTS, { id: row.id, key: row.key, spec: row.spec, state: row.state, crop: row.crop }, donePatch);
    if (isErr(committed)) return committed;
    if (committed.value === 1) {
      if (cropOf(row) !== renderedCropOf(row)) recrop();
      return ok({ ...row, ...donePatch });
    }

    const current = await db.findOne<Variant>(VARIANTS, { id: row.id });
    if (isErr(current)) return current;
    if (current.value !== null && current.value.key === row.key) {
      if (current.value.spec !== row.spec || cropOf(current.value) !== cropOf(row)) return recordBytesAtPath(current.value, cropOf(row), recrop);
      const recopied = await writeCopy();
      if (isErr(recopied)) return recopied;
      const again = await db.updateMany<Variant>(VARIANTS, { id: row.id, key: row.key, spec: row.spec, crop: current.value.crop }, donePatch);
      if (isErr(again)) return again;
      if (again.value === 1) {
        if (cropOf(row) !== renderedCropOf(current.value)) recrop();
        return ok({ ...current.value, ...donePatch });
      }
    }
    const dropped = await dropStaleRender(item, row, original);
    if (isErr(dropped)) return dropped;
    const latest = await db.findOne<Variant>(VARIANTS, { id: row.id });
    if (isErr(latest)) return latest;
    return ok(latest.value);
  }

  async function recordBytesAtPath(current: Variant, written: string, recrop: () => void): Promise<Result<Variant | null, KestrelError>> {
    if (renderedCropOf(current) !== written) {
      const rerender: Partial<Variant> = current.state === "done" ? { state: "pending", attempts: 0, error: null } : {};
      const recorded = await db.updateMany<Variant>(VARIANTS, { id: current.id, key: current.key, spec: current.spec, crop: current.crop, state: current.state, renderedCrop: current.renderedCrop }, { ...rerender, renderedCrop: written, updatedAt: now() });
      if (isErr(recorded)) return recorded;
      if (recorded.value === 1) recrop();
    }
    const latest = await db.findOne<Variant>(VARIANTS, { id: current.id });
    return isErr(latest) ? latest : ok(latest.value);
  }

  async function dropStaleRender(item: MediaFile, row: Variant, original: Original): Promise<Result<void, KestrelError>> {
    const holder = await db.findOne<Variant>(VARIANTS, { slot: row.slot });
    if (isErr(holder)) return holder;
    if (holder.value?.key !== row.key) {
      const droppedBlob = await blobs.remove(row.key);
      if (isErr(droppedBlob)) return droppedBlob;
    }
    if (config.publicCopy === undefined) return ok(undefined);
    const file = fileOf(row);
    const owner = await ownerOf(item.id, file);
    if (isErr(owner)) return owner;
    if (owner.value.row !== null) return ok(undefined);
    if (owner.value.retired !== null) {
      const put = await putCopy(item.id, file, original.data, original.publishedType);
      return isErr(put) ? put : ok(undefined);
    }
    const droppedCopy = await blobs.remove(copyKey(item.id, file));
    return isErr(droppedCopy) ? droppedCopy : ok(undefined);
  }

  async function loopOnce(): Promise<Result<"more" | "done", KestrelError>> {
    const found = await db.findOne<Job>(JOBS, { id: currentJobId! });
    if (isErr(found)) return found;
    const job = found.value;
    if (!job) return ok("done");
    const page = await library.scan(ELIGIBLE, { after: job.cursor === "" ? null : job.cursor, limit: config.chunk });
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
      let itemFailed = false;
      const placed = await planOne(media.id);
      if (isErr(placed)) {
        if (placed.error.retryable) {
          raiseVariantsChanged(changedIds);
          return placed;
        }
        logger.error(`images: sync job skipped media/${media.id}, it could not be placed`, { mediaId: media.id, error: placed.error.message });
        itemFailed = true;
      } else {
        if (placed.value.changed) changedIds.push(media.id);
        const variants = await generate(media.id);
        if (isErr(variants)) {
          if (variants.error.retryable) {
            raiseVariantsChanged(changedIds);
            return variants;
          }
          logger.error(`images: sync job skipped media/${media.id}, it could not be rendered`, { mediaId: media.id, error: variants.error.message });
          itemFailed = true;
        } else if (variants.value.some((v) => v.state === "error" || v.state === "failed")) {
          itemFailed = true;
        }
      }
      if (itemFailed) failed += 1;
      else done += 1;
      const progressed = await db.updateOne<Job>(JOBS, job.id, { done, failed, updatedAt: now() });
      if (isErr(progressed)) return progressed;
    }
    raiseVariantsChanged(changedIds);
    const cursor = page.value.next ?? page.value.items[page.value.items.length - 1]!.id;
    const finished = page.value.next === null;
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
      const total = await library.count(ELIGIBLE);
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
      for (let offset = 0; ; offset += PAGE) {
        const page = await db.findMany<Variant>(VARIANTS, { mediaId: { in: chunk } }, { sort: { id: "asc" }, limit: PAGE, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) map.get(row.mediaId)?.push(row);
        if (page.value.items.length < PAGE) break;
      }
    }
    return ok(map);
  }

  async function variantCounts(mediaIds: string[]): Promise<Result<Map<string, VariantCounts>, KestrelError>> {
    const counts = new Map<string, VariantCounts>();
    for (const id of mediaIds) counts.set(id, { done: 0, pending: 0, error: 0, failed: 0 });
    if (mediaIds.length === 0) return ok(counts);

    const described = await library.files(mediaIds);
    if (isErr(described)) return described;
    const eligibleIds = described.value.filter((file) => eligible(file.contentType)).map((file) => file.id);
    if (eligibleIds.length === 0) return ok(counts);

    const byMedia = await variantsOf(eligibleIds);
    if (isErr(byMedia)) return byMedia;

    for (const id of eligibleIds) {
      const byName = new Map((byMedia.value.get(id) ?? []).map((row) => [row.size, row]));
      const tally: VariantCounts = { done: 0, pending: 0, error: 0, failed: 0 };
      for (const size of effective) {
        const row = byName.get(size.name);
        if (row !== undefined && row.state === "done" && row.spec === spec(size) && cropOf(row) === renderedCropOf(row)) tally.done += 1;
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
      const page = await db.findMany<Variant>(VARIANTS, { mediaId }, { limit: PAGE });
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
      if (page.value.items.length < PAGE) break;
    }
    for (;;) {
      const page = await db.findMany<Retired>(RETIRED, { mediaId }, { limit: PAGE });
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
      if (page.value.items.length < PAGE) break;
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
    const unmarked = await db.deleteMany(HIDDEN, { mediaId });
    if (isErr(unmarked)) return unmarked;
    const unframed = await db.deleteMany(FRAMING, { mediaId });
    if (isErr(unframed)) return unframed;
    return ok(removed);
  }

  async function retireVariant(variantId: string): Promise<Result<Variant | null, KestrelError>> {
    const found = await db.findOne<Variant>(VARIANTS, { id: variantId });
    if (isErr(found)) return found;
    const variant = found.value;
    if (variant === null) return ok(null);
    const mediaId = variant.mediaId;
    const file = fileOf(variant);
    const media = await readMedia(mediaId);
    if (isErr(media)) return media;
    if (media.value === null) {
      const removed = await removeVariants(mediaId);
      return isErr(removed) ? removed : ok(variant);
    }
    const retired = await db.createOne<Retired>(RETIRED, { mediaId, file, slot: slotOf(mediaId, file), retiredAt: now() });
    if (isErr(retired) && retired.error.code !== "CONFLICT") return retired;
    let wrote = false;
    const outcome = await (async (): Promise<Result<Variant, KestrelError>> => {
      if (config.publicCopy !== undefined) {
        const original = await loadOriginal(mediaId);
        if (isErr(original)) return original;
        if (original.value !== null) {
          const overwritten = await putCopy(mediaId, file, original.value.data, original.value.publishedType);
          if (isErr(overwritten)) return overwritten;
          wrote = overwritten.value;
        }
      }
      const droppedBlob = await blobs.remove(variant.key);
      if (isErr(droppedBlob)) return droppedBlob;
      const dropped = await db.deleteOne(VARIANTS, variant.id);
      if (isErr(dropped)) return dropped;
      return ok(variant);
    })();
    if (!wrote) return outcome;
    return settleWrites<Variant | null>(mediaId, outcome, variant);
  }

  async function detectAndStartSync(): Promise<void> {
    if (closed) return;
    const total = await library.count(ELIGIBLE);
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
        const started = await beginSync(false);
        if (isErr(started) && started.error.code !== "CONFLICT") logger.error("images: the size set changed, but the sync job that places it could not start", { error: started.error.message });
        return;
      }
    }
  }

  async function removeCopiesOfGoneItem(mediaId: string): Promise<Result<void, KestrelError>> {
    return exclusive(mediaId, async () => {
      const media = await readMedia(mediaId);
      if (isErr(media)) return media;
      if (media.value !== null) return ok(undefined);
      const removed = await removeVariants(mediaId);
      return isErr(removed) ? removed : ok(undefined);
    });
  }

  async function removeRowsOfGoneItems(): Promise<Result<void, KestrelError>> {
    const ids = new Set<string>();
    const collect = async (row: { mediaId: string }): Promise<Result<void, KestrelError>> => {
      ids.add(row.mediaId);
      return ok(undefined);
    };
    const variants = await eachRow<Variant>(VARIANTS, {}, collect);
    if (isErr(variants)) return variants;
    const retired = await eachRow<Retired>(RETIRED, {}, collect);
    if (isErr(retired)) return retired;
    const marked = await eachRow<Hidden>(HIDDEN, {}, collect);
    if (isErr(marked)) return marked;
    const framings = await eachRow<FramingRow>(FRAMING, {}, collect);
    if (isErr(framings)) return framings;
    const all = [...ids];
    for (let i = 0; i < all.length && !closed; i += EVENT_CHUNK) {
      const chunk = all.slice(i, i + EVENT_CHUNK);
      const ready = await library.files(chunk);
      if (isErr(ready)) return ready;
      const live = new Set(ready.value.map((file) => file.id));
      for (const mediaId of chunk) {
        if (closed) return ok(undefined);
        if (live.has(mediaId)) continue;
        const removed = await removeCopiesOfGoneItem(mediaId);
        if (isErr(removed)) return removed;
      }
    }
    return ok(undefined);
  }

  async function removeForeignCopy(key: string, mediaId: string, file: string): Promise<Result<boolean, KestrelError>> {
    const hidden = await isHidden(mediaId);
    if (isErr(hidden)) return hidden;
    if (hidden.value) {
      const dropped = await blobs.remove(key);
      return isErr(dropped) ? dropped : ok(true);
    }
    const media = await readMedia(mediaId);
    if (isErr(media)) return media;
    if (media.value !== null) {
      const owner = await ownerOf(mediaId, file);
      if (isErr(owner)) return owner;
      if (owner.value.row !== null || owner.value.retired !== null) return ok(false);
    }
    const dropped = await blobs.remove(key);
    if (isErr(dropped)) return dropped;
    const after = await readMedia(mediaId);
    if (isErr(after)) return after;
    if (after.value === null) return ok(true);
    const owner = await ownerOf(mediaId, file);
    if (isErr(owner)) return owner;
    if (owner.value.row === null && owner.value.retired === null) return ok(true);
    const content = await contentFor(after.value, owner.value.row);
    if (isErr(content)) return content;
    if (content.value === null) return ok(true);
    const restored = await writeOwnedCopy(mediaId, file, content.value, owner.value.row);
    if (isErr(restored)) return restored;
    return ok(!restored.value);
  }

  async function writeCopiesOf(mediaId: string): Promise<Result<void, KestrelError>> {
    const media = await readMedia(mediaId);
    if (isErr(media)) return media;
    if (media.value === null) return ok(undefined);
    const item = media.value;
    const stored = await rowsOfItem(mediaId);
    if (isErr(stored)) return stored;
    const written = new Set<string>();
    for (const row of stored.value.values()) {
      if (row.state === "planned") continue;
      const content = await contentFor(item, row);
      if (isErr(content)) return content;
      if (content.value === null) continue;
      const kept = await writeOwnedCopy(mediaId, fileOf(row), content.value, row);
      if (isErr(kept)) return kept;
      written.add(fileOf(row));
    }
    return eachRow<Retired>(RETIRED, { mediaId }, async (row) => {
      if (written.has(row.file)) return ok(undefined);
      const content = await contentFor(item, null);
      if (isErr(content)) return content;
      if (content.value === null) return ok(undefined);
      const kept = await writeOwnedCopy(mediaId, row.file, content.value, null);
      return isErr(kept) ? kept : ok(undefined);
    });
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
      const media = await readMedia(mediaId);
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
      const recent = await eachMediaFile({ ...ELIGIBLE, createdSince: now() - NEW_ITEM_WINDOW_MS }, async (file) => {
        if (ids.size >= REPAIR_SAMPLE) return ok(undefined);
        const has = await db.count(VARIANTS, { mediaId: file.id });
        if (isErr(has)) return has;
        if (has.value === 0) ids.add(file.id);
        return ok(undefined);
      });
      if (isErr(recent)) return recent;
      const list = [...ids].slice(0, REPAIR_SAMPLE);
      const placedIds: string[] = [];
      const changedIds: string[] = [];
      for (const id of list) {
        const placed = await planOne(id);
        if (isErr(placed)) {
          logger.error(`images: repair pass could not place media/${id}`, { mediaId: id, error: placed.error.message });
          continue;
        }
        placedIds.push(id);
        if (placed.value.changed) changedIds.push(id);
      }
      raiseVariantsChanged(changedIds);
      for (const id of placedIds) {
        const generated = await generate(id);
        if (isErr(generated)) logger.error(`images: repair pass could not render media/${id}`, { mediaId: id, error: generated.error.message });
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
      for (let offset = 0; ; offset += PAGE) {
        const page = await db.findMany<Variant>(VARIANTS, filter, { sort: { id: "asc" }, limit: PAGE, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) affected.add(row.mediaId);
        if (page.value.items.length < PAGE) break;
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
          const page = await db.findMany<Variant>(VARIANTS, { size: name }, { limit: PAGE });
          if (isErr(page)) return page;
          if (page.value.items.length === 0) break;
          for (const variant of page.value.items) {
            const retired = await exclusive(variant.mediaId, () => retireVariant(variant.id));
            if (isErr(retired)) return retired;
            if (retired.value === null) continue;
            variantsDeleted += 1;
            affectedIds.add(variant.mediaId);
          }
          if (page.value.items.length < PAGE) break;
        }
        sizesDeleted += 1;
      }
      raiseVariantsChanged([...affectedIds]);
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

    remove(mediaId) {
      removing.set(mediaId, (removing.get(mediaId) ?? 0) + 1);
      return exclusive(mediaId, () => removeVariants(mediaId)).finally(() => {
        const left = (removing.get(mediaId) ?? 1) - 1;
        if (left === 0) removing.delete(mediaId);
        else removing.set(mediaId, left);
      });
    },

    variantsOf,
    variantCounts,

    async read(mediaId, file) {
      const hidden = await isHidden(mediaId);
      if (isErr(hidden)) return hidden;
      if (hidden.value) return ok(null);
      const media = await readMedia(mediaId);
      if (isErr(media)) return media;
      if (media.value === null) return ok(null);
      const owner = await ownerOf(mediaId, file);
      if (isErr(owner)) return owner;
      if (owner.value.row === null && owner.value.retired === null) return ok(null);
      const content = await contentFor(media.value, owner.value.row);
      if (isErr(content)) return content;
      if (content.value === null) return ok(null);
      const { data, contentType, rendered } = content.value;
      return ok({ data, contentType, fallback: !rendered, variant: rendered ? "done" : "original" });
    },

    async exportTo(dir) {
      const base = resolvePath(dir);
      let written = 0;
      let skipped = 0;
      for (let offset = 0; ; offset += PAGE) {
        const page = await db.findMany<Variant>(VARIANTS, { state: "done" }, { sort: { id: "asc" }, limit: PAGE, offset });
        if (isErr(page)) return page;
        const hidden = await hiddenAmong([...new Set(page.value.items.map((variant) => variant.mediaId))]);
        if (isErr(hidden)) return hidden;
        for (const variant of page.value.items) {
          if (hidden.value.has(variant.mediaId)) {
            skipped += 1;
            continue;
          }
          const media = await readMedia(variant.mediaId);
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
        if (page.value.items.length < PAGE) break;
      }
      return ok({ written, skipped });
    },

    publicPath(mediaId, variant) {
      const path = `${config.publicPath}/${mediaId}/variants/${fileOf(variant)}`;
      const rendered = parseCrop(variant.renderedCrop);
      return rendered === null ? path : `${path}?v=${cropToken(rendered)}`;
    },

    publicCopyEnabled() {
      return config.publicCopy !== undefined;
    },

    async syncPublic() {
      if (config.publicCopy === undefined) return ok({ written: 0, removed: 0, planned: 0, missing: 0 });
      let written = 0;
      let removed = 0;
      let planned = 0;
      let missing = 0;

      const ready = new Map<string, MediaFile>();
      const snapshot = await eachMediaFile(ELIGIBLE, async (file) => {
        ready.set(file.id, file);
        return ok(undefined);
      });
      if (isErr(snapshot)) return snapshot;

      const hidden = new Set<string>();
      const suspects = new Set<string>();
      const surveyedHidden = await eachRow<Hidden>(HIDDEN, { hidden: true }, async (row) => {
        hidden.add(row.mediaId);
        if (!ready.has(row.mediaId)) suspects.add(row.mediaId);
        return ok(undefined);
      });
      if (isErr(surveyedHidden)) return surveyedHidden;
      const sizesOf = new Map<string, Set<string>>();
      const unplaced = new Set<string>();
      let renderOutstanding = false;
      const surveyed = await eachRow<Variant>(VARIANTS, {}, async (row) => {
        if (!ready.has(row.mediaId)) {
          suspects.add(row.mediaId);
          return ok(undefined);
        }
        const names = sizesOf.get(row.mediaId) ?? new Set<string>();
        names.add(row.size);
        sizesOf.set(row.mediaId, names);
        if (row.state === "planned") unplaced.add(row.mediaId);
        if (row.state === "pending" || row.state === "error") renderOutstanding = true;
        return ok(undefined);
      });
      if (isErr(surveyed)) return surveyed;
      const surveyedRetired = await eachRow<Retired>(RETIRED, {}, async (row) => {
        if (!ready.has(row.mediaId)) suspects.add(row.mediaId);
        return ok(undefined);
      });
      if (isErr(surveyedRetired)) return surveyedRetired;

      for (const mediaId of suspects) {
        const dropped = await removeCopiesOfGoneItem(mediaId);
        if (isErr(dropped)) return dropped;
      }

      const names = effective.map((size) => size.name);
      const changedIds: string[] = [];
      for (const mediaId of ready.keys()) {
        const have = sizesOf.get(mediaId);
        if (!unplaced.has(mediaId) && names.every((name) => have?.has(name) === true)) continue;
        const placed = await planOne(mediaId);
        if (isErr(placed)) {
          if (placed.error.retryable) {
            raiseVariantsChanged(changedIds);
            return placed;
          }
          logger.error(`images: public-copy sync could not place media/${mediaId}`, { mediaId, error: placed.error.message });
          missing += 1;
          continue;
        }
        if (placed.value.changed) {
          planned += 1;
          renderOutstanding = true;
          changedIds.push(mediaId);
        }
      }
      raiseVariantsChanged(changedIds);

      const tree = publicTree();
      const listed = await blobs.list(tree);
      if (isErr(listed)) return listed;
      const files = new Map<string, { mediaId: string; file: string; size: number }>();
      for (const info of listed.value) {
        const parts = info.key.slice(tree.length).split("/");
        if (parts.length !== 3 || parts[1] !== "variants" || parts[0] === "" || parts[2] === "") continue;
        files.set(info.key, { mediaId: parts[0]!, file: parts[2]!, size: info.size });
      }
      const privateListed = await blobs.list(config.prefix);
      if (isErr(privateListed)) return privateListed;
      const privateSizes = new Map(privateListed.value.map((info) => [info.key, info.size]));

      const owned = new Set<string>();
      const ensureCopy = async (media: MediaFile, row: Variant | null, file: string, expectedSize: number | null | undefined): Promise<Result<void, KestrelError>> => {
        const key = copyKey(media.id, file);
        owned.add(key);
        const entry = files.get(key);
        if (entry !== undefined && (expectedSize === null || expectedSize === undefined || entry.size === expectedSize)) return ok(undefined);
        return exclusive(media.id, async () => {
          const content = await contentFor(media, row);
          if (isErr(content)) return content;
          if (content.value === null) {
            missing += 1;
            return ok(undefined);
          }
          const kept = await writeOwnedCopy(media.id, file, content.value, row);
          if (isErr(kept)) return kept;
          if (kept.value) written += 1;
          return ok(undefined);
        });
      };
      const copiedRows = await eachRow<Variant>(VARIANTS, {}, async (row) => {
        const media = ready.get(row.mediaId);
        if (media === undefined || row.state === "planned" || hidden.has(row.mediaId)) return ok(undefined);
        return ensureCopy(media, row, fileOf(row), privateSizes.get(row.key) ?? media.size);
      });
      if (isErr(copiedRows)) return copiedRows;
      const copiedRetired = await eachRow<Retired>(RETIRED, {}, async (row) => {
        const media = ready.get(row.mediaId);
        if (media === undefined || hidden.has(row.mediaId) || owned.has(copyKey(row.mediaId, row.file))) return ok(undefined);
        return ensureCopy(media, null, row.file, media.size);
      });
      if (isErr(copiedRetired)) return copiedRetired;

      for (const [key, entry] of files) {
        if (owned.has(key)) continue;
        const dropped = await exclusive(entry.mediaId, () => removeForeignCopy(key, entry.mediaId, entry.file));
        if (isErr(dropped)) return dropped;
        if (dropped.value) removed += 1;
      }

      if (renderOutstanding) {
        const started = await beginSync(false);
        if (isErr(started) && started.error.code !== "CONFLICT") logger.error("images: public-copy sync could not start a sync job", { error: started.error.message });
      }
      return ok({ written, removed, planned, missing });
    },

    async hide(mediaIds, versions) {
      const versionOf = (mediaId: string): number | undefined => trashVersionOf(versions, mediaId);
      for (const mediaId of new Set(mediaIds)) {
        const media = await readMedia(mediaId);
        if (isErr(media)) return media;
        if (media.value === null) continue;
        const marked = await markHidden(mediaId, true, versionOf(mediaId));
        if (isErr(marked)) return marked;
        if (!marked.value) continue;
        const withdrawn = await exclusive(mediaId, async (): Promise<Result<number, KestrelError>> => {
          const still = await isHidden(mediaId);
          if (isErr(still)) return still;
          return still.value ? removeAllCopies(mediaId) : ok(0);
        });
        if (isErr(withdrawn)) return withdrawn;
      }
      return ok(undefined);
    },

    async show(mediaIds, versions) {
      const versionOf = (mediaId: string): number | undefined => trashVersionOf(versions, mediaId);
      for (const mediaId of new Set(mediaIds)) {
        const unmarked = await markHidden(mediaId, false, versionOf(mediaId));
        if (isErr(unmarked)) return unmarked;
        if (!unmarked.value || config.publicCopy === undefined) continue;
        const rewritten = await exclusive(mediaId, async (): Promise<Result<void, KestrelError>> => {
          const hidden = await isHidden(mediaId);
          if (isErr(hidden)) return hidden;
          return hidden.value ? ok(undefined) : writeCopiesOf(mediaId);
        });
        if (isErr(rewritten)) return rewritten;
      }
      return ok(undefined);
    },

    hidden: hiddenAmong,

    async setFraming(mediaId, input) {
      const media = await readMedia(mediaId);
      if (isErr(media)) return media;
      const notFound = (): Result<never, KestrelError> => err(failure("NOT_FOUND", `images: media/${mediaId} not found`));
      if (media.value === null || !eligible(media.value.contentType)) return notFound();
      const hidden = await isHidden(mediaId);
      if (isErr(hidden)) return hidden;
      if (hidden.value) return notFound();
      const dims = await originalDimensions(media.value);
      if (isErr(dims)) return dims;
      if (dims.value === null) {
        const absent = await missingOriginal(media.value);
        return isErr(absent) ? absent : notFound();
      }
      const { decodable, ow, oh } = dims.value;
      const parsed = parseFraming(input, decodable ? { width: ow, height: oh } : undefined);
      if (!parsed.ok) return err(failure("VALIDATION", `images: ${parsed.error}`));
      const framing = parsed.value;
      return exclusive(mediaId, async (): Promise<Result<{ id: string; framing: Framing }, KestrelError>> => {
        const hiddenMeanwhile = await isHidden(mediaId);
        if (isErr(hiddenMeanwhile)) return hiddenMeanwhile;
        if (hiddenMeanwhile.value) return notFound();
        const previous = await readFraming(mediaId);
        if (isErr(previous)) return previous;
        const focusChanged = !sameRect(previous.value?.focus ?? null, framing.focus);
        const written = await writeFraming(mediaId, framing, ow, oh);
        if (isErr(written)) return written;
        const planned = await settleWrites(mediaId, await planItem(mediaId), { changed: false });
        if (isErr(planned)) {
          if (focusChanged) raiseVariantsChanged([mediaId]);
          schedulePlacement(mediaId);
          return planned;
        }
        if (planned.value.changed || focusChanged) raiseVariantsChanged([mediaId]);
        return ok({ id: mediaId, framing });
      });
    },

    framingsOf,

    attach(kestrel) {
      const detecting = removeRowsOfGoneItems()
        .then(
          (swept) => {
            if (isErr(swept)) logger.error("images: could not remove the variants of items that are no longer ready", { error: swept.error.message });
          },
          (cause: unknown) => {
            logger.error("images: could not remove the variants of items that are no longer ready", { error: errorMessage(cause) });
          },
        )
        .then(() => detectAndStartSync())
        .catch((cause: unknown) => {
          logger.error("images: could not check for a size-set shortfall", { error: errorMessage(cause) });
        });
      detections.add(detecting);
      void detecting.then(() => detections.delete(detecting));
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
      await Promise.all([...detections]);
      await idle();
      await idlePlacing();
      await idleItems();
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

  async function settleBackground(): Promise<void> {
    for (;;) {
      await Promise.all([...detections]);
      await idle();
      await idlePlacing();
      await idleItems();
      if (detections.size === 0 && !loopActive && placingQueue.size === 0 && itemTails.size === 0) return;
    }
  }

  Object.defineProperty(api, IDLE_HOOK, { value: settleBackground, enumerable: false });
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
