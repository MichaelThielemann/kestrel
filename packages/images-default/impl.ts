import { randomUUID } from "node:crypto";
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
import { EMPTY_FRAMING, effectiveCrop, formatCrop, parseCrop, parseFraming, type Framing, type PixelCrop, type Rect } from "./framing.ts";
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
export const ITEMS = "images_items";

/** Every collection this module stores; the persistence handle it is given reaches these and no other. */
export const COLLECTIONS: readonly string[] = [SIZES, VARIANTS, JOBS, RETIRED, HIDDEN, FRAMING, ITEMS];

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
  /** The byte size of the render at `key`; `0` while the row has none, and its path then answers the original's bytes even if `key` holds a render. */
  bytes: number;
  state: VariantState;
  error: string | null;
  attempts: number;
  updatedAt: number;
  /** The crop the row renders with, as `"left,top,width,height"` on the oriented original; `""` or `null` cuts from the centre. */
  crop: string | null;
  /** The crop of the bytes the last finished render left at the path, in the form of `crop`; `""` or `null` for the centre or no render yet. */
  renderedCrop: string | null;
  /** How many renders of the row left their bytes at its path (marked `done`, or a failed attempt whose bytes could not be taken back), counting one more when the row was placed at a path that held bytes before, and raised to at least `2` when its public copy is written over other bytes; `0` or `null` for none. From `2` on, the variant's public URL carries `?v=`. */
  renders: number | null;
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

/** The lease on one media item: only its holder places, renders or writes the paths of the item's variants. */
export interface ItemLease extends Document {
  mediaId: string;
  /** The holder, or `""` while nobody holds the item. */
  writer: string;
  /** Until when the holder's lease runs; a lease past this time can be taken over. */
  writerUntil: number;
  /** `""`, or the mark of a request the holder has to serve by placing and rendering the item again before it lets go. */
  request: string;
  /** Whether a holder lost the lease while it wrote, so every rendered size of the item renders again. */
  redo: boolean;
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
  /** The variant's public URL, `<publicPath>/<id>/variants/<file>`; from the row's second finished render on (`renders` from `2` on, a count a format change keeps, or raises by one when the new path held bytes before, and that a public copy written over other bytes raises), followed by `?v=<token>`, which no other render of that path is given. */
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

type NewVariant = Pick<Variant, "mediaId" | "size" | "slot" | "spec" | "width" | "height" | "format" | "key" | "bytes" | "state" | "error" | "attempts" | "updatedAt" | "crop" | "renderedCrop" | "renders" | "originalWidth" | "originalHeight">;

interface Lease {
  mediaId: string;
  token: string;
  request: string;
  redo: boolean;
}

type CopyOutcome = "written" | "skipped" | "missing";

const RENDERABLE: ReadonlySet<VariantState> = new Set<VariantState>(["planned", "pending", "error"]);

interface Content {
  data: Uint8Array;
  contentType: string;
  rendered: boolean;
}

interface Owner {
  row: Variant | null;
  retired: Retired | null;
}

interface RenderSignals {
  touch: () => void;
  recrop: () => void;
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

function takeTurns(lists: string[][], limit: number): string[] {
  const ids = new Set<string>();
  for (let i = 0; ids.size < limit && lists.some((list) => i < list.length); i += 1) {
    for (const list of lists) {
      const id = list[i];
      if (id !== undefined && ids.size < limit) ids.add(id);
    }
  }
  return [...ids];
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function renderedCropOf(row: Pick<Variant, "renderedCrop">): string {
  return row.renderedCrop ?? "";
}

function versionToken(id: string, renders: number): string {
  let hash = 0x811c9dc5;
  for (const char of `${id}:${renders}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
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
    [VARIANTS, { mediaId: "string", size: "string", slot: { type: "string", unique: true }, spec: "string", width: "number", height: "number", format: "string", key: "string", bytes: "number", state: "string", error: "json", attempts: "number", updatedAt: "number", crop: "string", renderedCrop: "string", renders: "number", originalWidth: "number", originalHeight: "number" }],
    [JOBS, { state: "string", total: "number", done: "number", failed: "number", cursor: "string", startedAt: "number", updatedAt: "number", finishedAt: "json", error: "json" }],
    [RETIRED, { mediaId: "string", file: "string", slot: { type: "string", unique: true }, retiredAt: "number" }],
    [HIDDEN, { mediaId: { type: "string", unique: true }, hidden: "boolean", version: "number", updatedAt: "number" }],
    [FRAMING, { mediaId: { type: "string", unique: true }, focus: "json", crops: "json", width: "number", height: "number", updatedAt: "number" }],
    [ITEMS, { mediaId: { type: "string", unique: true }, writer: "string", writerUntil: "number", request: "string", redo: "boolean", updatedAt: "number" }],
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
  const calls = new Set<Promise<unknown>>();
  const writerId = randomUUID();
  let claims = 0;
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

  function tracked<T>(work: Promise<T>): Promise<T> {
    calls.add(work);
    const forget = (): void => {
      calls.delete(work);
    };
    work.then(forget, forget);
    return work;
  }

  function shuttingDown(): Result<never, KestrelError> {
    return err(failure("CONFLICT", "images: images are shutting down"));
  }

  async function acquire(mediaId: string): Promise<Result<Lease | null, KestrelError>> {
    claims += 1;
    const token = `${writerId}/${claims}`;
    const at = now();
    const found = await db.findOne<ItemLease>(ITEMS, { mediaId });
    if (isErr(found)) return found;
    const row = found.value;
    if (row === null) {
      const created = await db.createOne<ItemLease>(ITEMS, { mediaId, writer: token, writerUntil: at + config.staleAfterMs, request: "", redo: false, updatedAt: at });
      if (!isErr(created)) return ok({ mediaId, token, request: "", redo: false });
      return created.error.code === "CONFLICT" ? ok(null) : created;
    }
    if (row.writer !== "" && row.writerUntil >= at) return ok(null);
    const taken = await db.updateMany<ItemLease>(ITEMS, { id: row.id, writer: row.writer, writerUntil: row.writerUntil, request: row.request }, { writer: token, writerUntil: at + config.staleAfterMs, updatedAt: at });
    if (isErr(taken)) return taken;
    return ok(taken.value === 1 ? { mediaId, token, request: row.request, redo: row.redo } : null);
  }

  async function ask(mediaId: string, redo = false): Promise<Result<string, KestrelError>> {
    const mark = { request: randomUUID(), updatedAt: now() };
    const asked = await db.updateMany<ItemLease>(ITEMS, { mediaId }, redo ? { ...mark, redo: true } : mark);
    return isErr(asked) ? asked : ok(mark.request);
  }

  async function askUnlessAsked(mediaId: string): Promise<Result<string | undefined, KestrelError>> {
    const mark = { request: randomUUID(), updatedAt: now() };
    const asked = await db.updateMany<ItemLease>(ITEMS, { mediaId, request: "" }, mark);
    if (isErr(asked)) return asked;
    return ok(asked.value === 1 ? mark.request : undefined);
  }

  async function leaveRequest(mediaId: string): Promise<Result<void, KestrelError>> {
    const asked = await askUnlessAsked(mediaId);
    if (isErr(asked)) return asked;
    if (asked.value !== undefined) return ok(undefined);
    const found = await db.findOne<ItemLease>(ITEMS, { mediaId });
    if (isErr(found)) return found;
    if (found.value !== null) return ok(undefined);
    const created = await db.createOne<ItemLease>(ITEMS, { mediaId, writer: "", writerUntil: 0, request: randomUUID(), redo: false, updatedAt: now() });
    return isErr(created) && created.error.code !== "CONFLICT" ? created : ok(undefined);
  }

  async function renew(lease: Lease): Promise<Result<"held" | "requested" | "lost", KestrelError>> {
    const until = now() + config.staleAfterMs;
    const renewed = await db.updateMany<ItemLease>(ITEMS, { mediaId: lease.mediaId, writer: lease.token, request: lease.request }, { writerUntil: until });
    if (isErr(renewed)) return renewed;
    if (renewed.value === 1) return ok("held");
    const extended = await db.updateMany<ItemLease>(ITEMS, { mediaId: lease.mediaId, writer: lease.token }, { writerUntil: until });
    if (isErr(extended)) return extended;
    return ok(extended.value === 1 ? "requested" : "lost");
  }

  async function handBack(mediaId: string, redo: boolean): Promise<Result<void, KestrelError>> {
    const asked = await ask(mediaId, redo);
    if (isErr(asked)) return asked;
    scheduleConverge(mediaId);
    return ok(undefined);
  }

  async function mayWrite(lease: Lease, yieldToRequest: boolean): Promise<Result<boolean, KestrelError>> {
    const hold = await renew(lease);
    if (isErr(hold)) return hold;
    if (hold.value === "held" || (hold.value === "requested" && !yieldToRequest)) return ok(true);
    if (hold.value === "lost") {
      const handed = await handBack(lease.mediaId, false);
      if (isErr(handed)) return handed;
    }
    return ok(false);
  }

  async function wroteHeld(lease: Lease): Promise<Result<boolean, KestrelError>> {
    const hold = await renew(lease);
    if (isErr(hold)) return hold;
    if (hold.value !== "lost") return ok(true);
    const handed = await handBack(lease.mediaId, true);
    return isErr(handed) ? handed : ok(false);
  }

  async function putCopyHeld(lease: Lease, file: string, data: Uint8Array, contentType: string): Promise<Result<boolean | "lost", KestrelError>> {
    const may = await mayWrite(lease, false);
    if (isErr(may) || !may.value) return isErr(may) ? may : ok("lost");
    const put = await putCopy(lease.mediaId, file, data, contentType);
    if (isErr(put)) return put;
    const kept = await wroteHeld(lease);
    return isErr(kept) ? kept : put;
  }

  function asRead(row: Variant): Filter {
    return { id: row.id, key: row.key, spec: row.spec, state: row.state, crop: row.crop ?? null, attempts: row.attempts, renders: row.renders ?? null };
  }

  async function updateAsRead(row: Variant, patch: Partial<Variant>): Promise<Result<Variant | null, KestrelError>> {
    const updated = await db.updateMany<Variant>(VARIANTS, asRead(row), patch);
    if (isErr(updated)) return updated;
    return ok(updated.value === 1 ? { ...row, ...patch } : null);
  }

  function withItem<T>(mediaId: string, work: (lease: Lease) => Promise<Result<T, KestrelError>>, handOver: () => Promise<Result<T, KestrelError>>, options: { serveLater?: boolean; asked?: string | undefined; takeIfLetGo?: boolean } = {}): Promise<Result<T, KestrelError>> {
    return exclusive(mediaId, async (): Promise<Result<T, KestrelError>> => {
      const lease = await acquire(mediaId);
      if (isErr(lease)) return lease;
      if (lease.value === null) {
        const handed = await handOver();
        if (isErr(handed)) return handed;
        const asked = await ask(mediaId);
        if (isErr(asked) || options.takeIfLetGo !== true) return isErr(asked) ? asked : handed;
        const again = await acquire(mediaId);
        if (isErr(again) || again.value === null) return isErr(again) ? again : handed;
        return settleLease(again.value, handed, options.serveLater === true, true);
      }
      const held = lease.value;
      const owed = held.request !== "" && held.request !== options.asked;
      return settleLease(held, await work(held), options.serveLater === true, owed);
    });
  }

  async function letGo<T>(lease: Lease, outcome: Result<T, KestrelError>, keepAsking: boolean): Promise<Result<T, KestrelError>> {
    const released = { writer: "", writerUntil: 0, updatedAt: now() };
    const left = await db.updateMany<ItemLease>(ITEMS, { mediaId: lease.mediaId, writer: lease.token }, keepAsking && lease.request === "" ? { ...released, request: randomUUID() } : released);
    if (isErr(left)) logger.error(`images: could not release media/${lease.mediaId}`, { mediaId: lease.mediaId, error: left.error.message });
    return outcome;
  }

  async function settleLease<T>(lease: Lease, done: Result<T, KestrelError>, serveLater: boolean, owedAtStart: boolean): Promise<Result<T, KestrelError>> {
    if (isErr(done)) {
      const found = await db.findOne<ItemLease>(ITEMS, { mediaId: lease.mediaId });
      const asked = !isErr(found) && found.value !== null && found.value.writer === lease.token && found.value.request !== lease.request;
      const left = await letGo<T>(lease, done, done.error.code !== "NOT_FOUND" && done.error.code !== "VALIDATION");
      if (asked) scheduleConverge(lease.mediaId);
      return left;
    }
    let owed = owedAtStart;
    for (;;) {
      if (!owed) {
        const released = await db.updateMany<ItemLease>(ITEMS, { mediaId: lease.mediaId, writer: lease.token, request: lease.request }, { writer: "", writerUntil: 0, request: "", redo: false, updatedAt: now() });
        if (isErr(released)) return letGo(lease, done, true);
        if (released.value === 1) return done;
      }
      const found = await db.findOne<ItemLease>(ITEMS, { mediaId: lease.mediaId });
      if (isErr(found)) return letGo(lease, done, true);
      if (found.value === null || found.value.writer !== lease.token) return done;
      lease.request = found.value.request;
      lease.redo = found.value.redo;
      owed = false;
      if (closed || serveLater) {
        const left = await letGo(lease, done, true);
        scheduleConverge(lease.mediaId);
        return left;
      }
      const converged = await converge(lease);
      if (isErr(converged)) {
        logger.error(`images: media/${lease.mediaId} could not be placed and rendered again`, { mediaId: lease.mediaId, error: converged.error.message });
        return letGo(lease, done, true);
      }
    }
  }

  async function converge(lease: Lease): Promise<Result<void, KestrelError>> {
    const mediaId = lease.mediaId;
    const media = await readMedia(mediaId);
    if (isErr(media)) return media;
    if (media.value === null) {
      const removed = await removeVariants(mediaId);
      return isErr(removed) ? removed : ok(undefined);
    }
    if (!eligible(media.value.contentType)) return ok(undefined);
    if (lease.redo) {
      const stored = await rowsOfItem(mediaId);
      if (isErr(stored)) return stored;
      const written = [...stored.value.values()].filter((row) => row.error !== UNDECODABLE).map((row) => row.id);
      const requeued = written.length === 0 ? ok(0) : await db.updateMany<Variant>(VARIANTS, { id: { in: written }, state: { in: ["done", "error", "failed"] }, size: { in: effective.map((size) => size.name) } }, { state: "pending", attempts: 0, error: null, updatedAt: now() });
      if (isErr(requeued)) return requeued;
    }
    const placed = await planItem(mediaId, lease);
    if (isErr(placed)) return placed;
    if (placed.value.changed) raiseVariantsChanged([mediaId]);
    const rendered = await generateOnce(mediaId, lease);
    if (isErr(rendered)) return rendered;
    if (config.publicCopy === undefined) return ok(undefined);
    const hidden = await isHidden(mediaId);
    if (isErr(hidden)) return hidden;
    if (!hidden.value) return writeCopiesOf(mediaId, lease);
    const withdrawn = await removeAllCopies(mediaId);
    return isErr(withdrawn) ? withdrawn : ok(undefined);
  }

  async function currentVariants(mediaId: string): Promise<Result<Variant[], KestrelError>> {
    const stored = await rowsOfItem(mediaId);
    if (isErr(stored)) return stored;
    return ok(effective.flatMap((size) => stored.value.get(size.name) ?? []));
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

  function inBackground(mediaId: string, what: string, work: () => Promise<Result<unknown, KestrelError>>): void {
    if (closed) return;
    const promise = new Promise<void>((resolve) => {
      setImmediate(() => {
        void work()
          .then((done) => {
            if (isErr(done)) logger.error(`images: background ${what} for ${mediaId} failed`, { mediaId, error: done.error.message });
          })
          .catch((cause: unknown) => {
            logger.error(`images: background ${what} for ${mediaId} failed`, { mediaId, error: errorMessage(cause) });
          })
          .then(() => resolve());
      });
    });
    placingQueue.add(promise);
    void promise.finally(() => placingQueue.delete(promise));
  }

  function schedulePlacement(mediaId: string): void {
    inBackground(mediaId, "placement", async () => {
      const placed = await planIds([mediaId]);
      return isErr(placed) ? placed : generate(mediaId);
    });
  }

  function scheduleConverge(mediaId: string): void {
    inBackground(mediaId, "placement", () => withItem(mediaId, async () => ok(undefined), async () => ok(undefined)));
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
      const removed = await db.deleteMany(FRAMING, { mediaId });
      return isErr(removed) ? removed : ok(undefined);
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

  async function framingRowsOf(mediaIds: string[]): Promise<Result<Map<string, FramingRow>, KestrelError>> {
    const stored = new Map<string, FramingRow>();
    for (let i = 0; i < mediaIds.length; i += EVENT_CHUNK) {
      const chunk = mediaIds.slice(i, i + EVENT_CHUNK);
      const page = await db.findMany<FramingRow>(FRAMING, { mediaId: { in: chunk } }, { limit: chunk.length });
      if (isErr(page)) return page;
      for (const row of page.value.items) stored.set(row.mediaId, row);
    }
    return ok(stored);
  }

  async function framingsOf(mediaIds: string[]): Promise<Result<Map<string, FramingView>, KestrelError>> {
    const read = await framingRowsOf(mediaIds);
    if (isErr(read)) return read;
    const stored = read.value;
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
    if (row !== null && row.state !== "planned" && row.bytes > 0) {
      const rendered = await blobs.get(row.key);
      if (isErr(rendered)) return rendered;
      if (rendered.value !== null) return ok({ data: rendered.value, contentType: publicTypeOf(contentTypeOf(row.format)), rendered: true });
    }
    const original = await loadOriginal(item.id);
    if (isErr(original)) return original;
    if (original.value === null) return ok(null);
    return ok({ data: original.value.data, contentType: original.value.publishedType, rendered: false });
  }

  async function keepCopyOwned(lease: Lease, file: string, wroteRow: boolean): Promise<Result<boolean, KestrelError>> {
    const mediaId = lease.mediaId;
    const media = await readMedia(mediaId);
    if (isErr(media)) return media;
    const owner = await ownerOf(mediaId, file);
    if (isErr(owner)) return owner;
    if (media.value !== null && owner.value.row !== null) return ok(true);
    if (media.value !== null && owner.value.retired !== null) {
      if (!wroteRow) return ok(true);
      const original = await contentFor(media.value, null);
      if (isErr(original) || original.value === null) return isErr(original) ? original : ok(true);
      const put = await putCopyHeld(lease, file, original.value.data, original.value.contentType);
      return isErr(put) ? put : ok(put.value === true);
    }
    const undone = await blobs.remove(copyKey(mediaId, file));
    return isErr(undone) ? undone : ok(false);
  }

  async function writeRowCopy(lease: Lease, item: MediaFile, row: Variant): Promise<Result<CopyOutcome, KestrelError>> {
    const content = await contentFor(item, row);
    if (isErr(content) || content.value === null) return isErr(content) ? content : ok("missing");
    const held = await blobs.get(copyKey(item.id, fileOf(row)));
    if (isErr(held)) return held;
    const put = await putCopyHeld(lease, fileOf(row), content.value.data, content.value.contentType);
    if (isErr(put) || put.value !== true) return isErr(put) ? put : ok("skipped");
    const kept = await keepCopyOwned(lease, fileOf(row), true);
    if (isErr(kept) || !kept.value) return isErr(kept) ? kept : ok("skipped");
    if (held.value === null || sameBytes(held.value, content.value.data)) return ok("written");
    const renewed = await updateAsRead(row, { renders: Math.max((row.renders ?? 0) + 1, 2) });
    if (isErr(renewed)) return renewed;
    if (renewed.value !== null) raiseVariantsChanged([item.id]);
    return ok("written");
  }

  async function writeOwnedCopy(lease: Lease, media: MediaFile, file: string): Promise<Result<CopyOutcome, KestrelError>> {
    const owner = await ownerOf(media.id, file);
    if (isErr(owner)) return owner;
    if (owner.value.row !== null) return writeRowCopy(lease, media, owner.value.row);
    if (owner.value.retired === null) return ok("skipped");
    const original = await contentFor(media, null);
    if (isErr(original) || original.value === null) return isErr(original) ? original : ok("missing");
    const put = await putCopyHeld(lease, file, original.value.data, original.value.contentType);
    if (isErr(put) || put.value !== true) return isErr(put) ? put : ok("skipped");
    const kept = await keepCopyOwned(lease, file, false);
    return isErr(kept) ? kept : ok(kept.value ? "written" : "skipped");
  }

  async function settleWrites<T>(mediaId: string, outcome: Result<T, KestrelError>, whenGone: T): Promise<Result<T, KestrelError>> {
    const media = await readMedia(mediaId);
    if (isErr(media)) return isErr(outcome) ? outcome : media;
    if (media.value !== null) return outcome;
    const removed = await removeVariants(mediaId);
    if (isErr(removed)) return removed;
    return ok(whenGone);
  }

  const waitingRenders = new Map<string, Promise<Result<Variant[], KestrelError>>>();
  const removing = new Map<string, number>();

  function generate(mediaId: string): Promise<Result<Variant[], KestrelError>> {
    const waiting = waitingRenders.get(mediaId);
    if (waiting) return waiting;
    const promise = withItem(
      mediaId,
      (lease) => {
        waitingRenders.delete(mediaId);
        return generateOnce(mediaId, lease);
      },
      () => {
        waitingRenders.delete(mediaId);
        return currentVariants(mediaId);
      },
    );
    waitingRenders.set(mediaId, promise);
    const forget = (): void => {
      if (waitingRenders.get(mediaId) === promise) waitingRenders.delete(mediaId);
    };
    promise.then(forget, forget);
    return promise;
  }

  function planOne(mediaId: string): Promise<Result<{ changed: boolean }, KestrelError>> {
    return withItem(mediaId, (lease) => planItem(mediaId, lease), async () => ok({ changed: false }), { serveLater: true });
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

  function newRow(item: MediaFile, size: Size, decodable: boolean, ow: number, oh: number, framing: Framing | null, renders = 0): NewVariant {
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
      renders,
      originalWidth: decodable ? ow : 0,
      originalHeight: decodable ? oh : 0,
    };
  }

  async function newRows(item: MediaFile, sizes: Size[], decodable: boolean, ow: number, oh: number, framing: Framing | null): Promise<Result<NewVariant[], KestrelError>> {
    const rows: NewVariant[] = [];
    for (const size of sizes) {
      const row = newRow(item, size, decodable, ow, oh, framing);
      const retired = await db.findOne<Retired>(RETIRED, { slot: slotOf(item.id, fileOf(row)) });
      if (isErr(retired)) return retired;
      rows.push(retired.value === null ? row : { ...row, renders: 1 });
    }
    return ok(rows);
  }

  async function planItem(mediaId: string, lease: Lease): Promise<Result<{ changed: boolean }, KestrelError>> {
    const media = await readMedia(mediaId);
    if (isErr(media)) return media;
    if (media.value === null || !eligible(media.value.contentType)) return ok({ changed: false });
    const item = media.value;
    let touched = false;
    const touch = (): void => {
      touched = true;
    };
    const outcome = await placeItem(lease, item, touch);
    if (!touched) return outcome;
    return settleWrites(mediaId, outcome, { changed: false });
  }

  async function placeItem(lease: Lease, item: MediaFile, touch: () => void): Promise<Result<{ changed: boolean }, KestrelError>> {
    const stored = await rowsOfItem(item.id);
    if (isErr(stored)) return stored;
    const framed = await readFraming(item.id);
    if (isErr(framed)) return framed;
    return placeRows(lease, item, touch, stored.value, framed.value);
  }

  async function placeRows(lease: Lease, item: MediaFile, touch: () => void, byName: Map<string, Variant>, framing: Framing | null): Promise<Result<{ changed: boolean }, KestrelError>> {
    const mediaId = item.id;
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
      const fresh = await newRows(item, missing, decodable, ow, oh, framing);
      if (isErr(fresh)) return fresh;
      const created = await db.createMany<Variant>(VARIANTS, fresh.value);
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
        const overwritten = await putCopyHeld(lease, oldFile, original.data, original.publishedType);
        if (isErr(overwritten)) return overwritten;
        if (overwritten.value === "lost") return ok({ changed });
      }
      const fresh = newRow(item, size, decodable, ow, oh, framing);
      const heldBefore = await db.findOne<Retired>(RETIRED, { slot: slotOf(mediaId, fileOf(fresh)) });
      if (isErr(heldBefore)) return heldBefore;
      const renders = (row.renders ?? 0) + (heldBefore.value === null ? 0 : 1);
      const replanned = await updateAsRead(row, { key: fresh.key, format: fresh.format, spec: fresh.spec, width: fresh.width, height: fresh.height, bytes: 0, state: "planned", error: fresh.error, attempts: 0, updatedAt: now(), crop: fresh.crop, renderedCrop: "", renders, originalWidth: fresh.originalWidth, originalHeight: fresh.originalHeight });
      if (isErr(replanned)) return replanned;
      if (replanned.value === null) {
        const handed = await handBack(mediaId, false);
        return isErr(handed) ? handed : ok({ changed });
      }
      if (row.key !== fresh.key) {
        const dropped = await blobs.remove(row.key);
        if (isErr(dropped)) return dropped;
      }
      const current = await db.deleteMany(RETIRED, { slot: slotOf(mediaId, fileOf(replanned.value)) });
      if (isErr(current)) return current;
      toPlace.push(replanned.value);
    }

    for (const { size, row } of [...respec, ...recrop]) {
      touch();
      const fresh = newRow(item, size, decodable, ow, oh, framing);
      const dimsPatch = { spec: fresh.spec, width: fresh.width, height: fresh.height, crop: fresh.crop, originalWidth: fresh.originalWidth, originalHeight: fresh.originalHeight, updatedAt: now() };
      const patch: Partial<Variant> = row.state === "planned" ? dimsPatch : decodable ? { ...dimsPatch, state: "pending", attempts: 0, error: null } : { ...dimsPatch, state: "failed", error: UNDECODABLE };
      const updated = await updateAsRead(row, patch);
      if (isErr(updated)) return updated;
      if (updated.value === null) {
        const handed = await handBack(mediaId, false);
        return isErr(handed) ? handed : ok({ changed });
      }
      if (row.state === "planned") {
        toPlace.push(updated.value);
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
        const put = await putCopyHeld(lease, fileOf(row), original.data, original.publishedType);
        if (isErr(put) || put.value === "lost") return isErr(put) ? put : ok(undefined);
        const advanced = await db.updateMany<Variant>(VARIANTS, { id: row.id, state: "planned" }, { state: settledState, updatedAt: now() });
        return isErr(advanced) ? advanced : ok(undefined);
      }),
      PLACEMENT_CONCURRENCY,
    );
    if (isErr(placed)) return placed;
    return ok({ changed });
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

  async function generateOnce(mediaId: string, lease: Lease): Promise<Result<Variant[], KestrelError>> {
    const media = await readMedia(mediaId);
    if (isErr(media)) return media;
    if (media.value === null || !eligible(media.value.contentType)) return ok([]);
    const item = media.value;
    let touched = false;
    let recropped = false;
    const outcome = await renderItem(lease, item, {
      touch: () => {
        touched = true;
      },
      recrop: () => {
        recropped = true;
      },
    });
    const settled = touched ? await settleWrites(mediaId, outcome, []) : outcome;
    if (recropped) raiseVariantsChanged([mediaId]);
    return settled;
  }

  function renderable(row: Variant, size: Size): boolean {
    return row.spec === spec(size) && RENDERABLE.has(row.state);
  }

  async function renderItem(lease: Lease, item: MediaFile, signals: RenderSignals): Promise<Result<Variant[], KestrelError>> {
    const mediaId = item.id;
    const { touch } = signals;
    const stored = await rowsOfItem(mediaId);
    if (isErr(stored)) return stored;
    const byName = stored.value;

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
      const fresh = await newRows(item, missing, decodable, ow, oh, framed.value);
      if (isErr(fresh)) return fresh;
      const created = await db.createMany<Variant>(VARIANTS, fresh.value);
      if (isErr(created)) return created;
      touch();
      for (const row of created.value) byName.set(row.size, row);
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
    let stopped = false;
    for (const size of effective) {
      const row = byName.get(size.name);
      if (row === undefined) continue;
      if (original === null || stopped || !renderable(row, size) || removing.has(mediaId)) {
        results.push(row);
        continue;
      }
      const rendered = await renderVariant(lease, item, size, row, original, signals);
      if (isErr(rendered)) {
        if ([...byName.values()].some((stored) => stored.state === "planned")) schedulePlacement(mediaId);
        return rendered;
      }
      if (rendered.value === "gone") continue;
      if (rendered.value === null) {
        results.push(row);
        stopped = true;
        continue;
      }
      results.push(rendered.value);
      if (rendered.value.state !== "failed" && rendered.value.error?.startsWith(TIMED_OUT) === true) stopped = true;
    }

    if (results.some((row) => row.state === "planned")) schedulePlacement(mediaId);
    return ok(results);
  }

  function failurePatch(row: Variant, attempts: number, message: string, landed: Partial<Variant>): Partial<Variant> {
    return row.state === "planned" ? { error: message } : { state: attempts >= maxAttempts ? "failed" : "error", attempts, error: message, updatedAt: now(), ...landed };
  }

  function logFailure(row: Variant, size: Size): void {
    if (row.state === "error") logger.error(`images: variant ${size.name} for media/${row.mediaId} failed, attempt ${row.attempts}`, { mediaId: row.mediaId, size: size.name, error: row.error });
    if (row.state === "failed") logger.error(`images: variant ${size.name} for media/${row.mediaId} gave up after ${row.attempts} attempts`, { mediaId: row.mediaId, size: size.name, error: row.error });
  }

  async function recordFailure(row: Variant, size: Size, attempts: number, message: string, landed: Partial<Variant> = {}): Promise<Result<Variant | null, KestrelError>> {
    const recorded = await updateAsRead(row, failurePatch(row, attempts, message, landed));
    if (isErr(recorded) || recorded.value === null) return recorded;
    logFailure(recorded.value, size);
    return recorded;
  }

  async function writeRender(lease: Lease, row: Variant, rendered: Rendered, original: Original): Promise<Result<"written" | "lost" | { landed: KestrelError }, KestrelError>> {
    const previous = config.publicCopy !== undefined && row.bytes > 0 ? await blobs.get(row.key) : ok(null);
    if (isErr(previous)) return previous;
    const stored = await blobs.put(row.key, rendered.data, { contentType: rendered.contentType });
    if (isErr(stored)) return stored;
    if (config.publicCopy === undefined) return ok("written");
    const copied = await putCopy(lease.mediaId, fileOf(row), rendered.data, publicTypeOf(rendered.contentType));
    if (!isErr(copied)) return ok("written");
    const restored = previous.value === null ? await blobs.remove(row.key) : await blobs.put(row.key, previous.value, { contentType: contentTypeOf(row.format) });
    const recopied = isErr(restored)
      ? await putCopy(lease.mediaId, fileOf(row), rendered.data, publicTypeOf(rendered.contentType))
      : previous.value === null
        ? await putCopy(lease.mediaId, fileOf(row), original.data, original.publishedType)
        : await putCopy(lease.mediaId, fileOf(row), previous.value, publicTypeOf(contentTypeOf(row.format)));
    if (isErr(restored)) logger.error(`images: the earlier bytes of ${fileOf(row)} could not be put back after its public copy failed`, { mediaId: row.mediaId, error: restored.error.message });
    if (isErr(recopied)) logger.error(`images: the public copy of ${fileOf(row)} could not be written after its first write failed`, { mediaId: row.mediaId, error: recopied.error.message });
    const kept = await wroteHeld(lease);
    if (!isErr(kept) && !kept.value) return ok("lost");
    return isErr(restored) ? ok({ landed: copied.error }) : err(copied.error);
  }

  async function dropStaleRender(item: MediaFile, row: Variant, original: Original): Promise<Result<null | "gone", KestrelError>> {
    const file = fileOf(row);
    const owner = await ownerOf(item.id, file);
    if (isErr(owner)) return owner;
    if (owner.value.row !== null) {
      const handed = await handBack(item.id, true);
      return isErr(handed) ? handed : ok(null);
    }
    const droppedBlob = await blobs.remove(row.key);
    if (isErr(droppedBlob)) return droppedBlob;
    if (config.publicCopy === undefined) return ok("gone");
    if (owner.value.retired !== null) {
      const put = await putCopy(item.id, file, original.data, original.publishedType);
      return isErr(put) ? put : ok("gone");
    }
    const droppedCopy = await blobs.remove(copyKey(item.id, file));
    return isErr(droppedCopy) ? droppedCopy : ok("gone");
  }

  async function recordWriteFailure(item: MediaFile, size: Size, row: Variant, original: Original, attempts: number, failed: KestrelError, landed: Rendered | null, signals: RenderSignals): Promise<Result<Variant | null | "gone", KestrelError>> {
    const renders = (row.renders ?? 0) + 1;
    const recorded = await recordFailure(row, size, attempts, failed.message, landed === null ? {} : { bytes: landed.data.byteLength, renderedCrop: cropOf(row), renders });
    if (isErr(recorded)) return recorded;
    if (recorded.value === null) {
      const dropped = await dropStaleRender(item, row, original);
      if (isErr(dropped) || dropped.value === "gone") return dropped;
    } else if (landed !== null && row.state !== "planned" && (renders >= 2 || cropOf(row) !== renderedCropOf(row))) signals.recrop();
    return err(failed);
  }

  async function renderVariant(lease: Lease, item: MediaFile, size: Size, row: Variant, original: Original, signals: RenderSignals): Promise<Result<Variant | null | "gone", KestrelError>> {
    const attempt = await renderWithin(original.data, item.contentType, size, { width: row.width, height: row.height, format: row.format, crop: parseCrop(row.crop) });
    const attempts = row.attempts + 1;
    if (isErr(attempt)) return recordFailure(row, size, attempts, attempt.error.message);

    const may = await mayWrite(lease, true);
    if (isErr(may) || !may.value) return isErr(may) ? may : ok(null);
    signals.touch();
    const rendered = attempt.value;
    const written = await writeRender(lease, row, rendered, original);
    if (isErr(written)) return recordWriteFailure(item, size, row, original, attempts, written.error, null, signals);
    if (written.value === "lost") return ok(null);
    if (written.value !== "written") return recordWriteFailure(item, size, row, original, attempts, written.value.landed, rendered, signals);
    const kept = await wroteHeld(lease);
    if (isErr(kept) || !kept.value) return isErr(kept) ? kept : ok(null);

    const renders = (row.renders ?? 0) + 1;
    const committed = await updateAsRead(row, { state: "done", bytes: rendered.data.byteLength, attempts, error: null, updatedAt: now(), renderedCrop: cropOf(row), renders });
    if (isErr(committed)) return committed;
    if (committed.value === null) return dropStaleRender(item, row, original);
    if (renders >= 2 || cropOf(row) !== renderedCropOf(row)) signals.recrop();
    return committed;
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
        if (stopRequested || closed) {
          loopActive = false;
          notifyIdle();
          return;
        }
        try {
          const outcome = await loopOnce();
          if (isErr(outcome)) await recordJobFailure(outcome.error.message);
          else if (outcome.value === "more" && !stopRequested && !closed) {
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
    if (loopActive || closed) return;
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
    if (closed) return Promise.resolve(shuttingDown());
    if (starting) return starting;
    const promise = tracked(
      startSync(fromStart).finally(() => {
        starting = null;
      }),
    );
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
    const framings = await framingRowsOf(eligibleIds);
    if (isErr(framings)) return framings;

    for (const id of eligibleIds) {
      const byName = new Map((byMedia.value.get(id) ?? []).map((row) => [row.size, row]));
      const stored = framings.value.get(id);
      const framing = stored === undefined ? null : storedFraming(stored);
      const sized = stored !== undefined && stored.width > 0 && stored.height > 0;
      const tally: VariantCounts = { done: 0, pending: 0, error: 0, failed: 0 };
      for (const size of effective) {
        const row = byName.get(size.name);
        const cut = formatCrop(plannedCrop(size, sized, stored?.width ?? 0, stored?.height ?? 0, framing));
        if (row !== undefined && row.state === "done" && row.spec === spec(size) && cropOf(row) === renderedCropOf(row) && renderedCropOf(row) === cut) tally.done += 1;
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
    const unleased = await db.deleteMany(ITEMS, { mediaId });
    if (isErr(unleased)) return unleased;
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
    const leases = await eachRow<ItemLease>(ITEMS, {}, collect);
    if (isErr(leases)) return leases;
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

  async function removeForeignCopy(lease: Lease, key: string, file: string): Promise<Result<boolean, KestrelError>> {
    const mediaId = lease.mediaId;
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
    const restored = await writeOwnedCopy(lease, after.value, file);
    if (isErr(restored)) return restored;
    return ok(restored.value !== "written");
  }

  async function writeCopiesOf(mediaId: string, lease: Lease): Promise<Result<void, KestrelError>> {
    const media = await readMedia(mediaId);
    if (isErr(media)) return media;
    if (media.value === null) return ok(undefined);
    const item = media.value;
    const stored = await rowsOfItem(mediaId);
    if (isErr(stored)) return stored;
    const written = new Set<string>();
    for (const row of stored.value.values()) {
      if (row.state === "planned") continue;
      const kept = await writeRowCopy(lease, item, row);
      if (isErr(kept)) return kept;
      written.add(fileOf(row));
    }
    return eachRow<Retired>(RETIRED, { mediaId }, async (row) => {
      if (written.has(row.file)) return ok(undefined);
      const kept = await writeOwnedCopy(lease, item, row.file);
      return isErr(kept) ? kept : ok(undefined);
    });
  }

  async function repair(): Promise<Result<Job | null, KestrelError>> {
    const at = now();
    const stale = at - config.staleAfterMs;
    const declared = { in: effective.map((size) => size.name) };
    const oldestFirst = { limit: REPAIR_SAMPLE, sort: { updatedAt: "asc" as const } };
    const cutOff = await db.findMany<ItemLease>(ITEMS, { writer: { ne: "" }, writerUntil: { lt: at } }, oldestFirst);
    if (isErr(cutOff)) return cutOff;
    const requested = await db.findMany<ItemLease>(ITEMS, { writer: "", request: { ne: "" }, updatedAt: { lt: stale } }, oldestFirst);
    if (isErr(requested)) return requested;
    const stalePending = await db.findMany<Variant>(VARIANTS, { state: "pending", size: declared, bytes: { gt: 0 }, updatedAt: { lt: stale } }, oldestFirst);
    if (isErr(stalePending)) return stalePending;
    const stalePlanned = await db.findMany<Variant>(VARIANTS, { state: "planned", size: declared, updatedAt: { lt: stale } }, oldestFirst);
    if (isErr(stalePlanned)) return stalePlanned;
    const failedOnce = await db.findMany<Variant>(VARIANTS, { state: "error", size: declared, updatedAt: { lt: stale } }, oldestFirst);
    if (isErr(failedOnce)) return failedOnce;
    const respecced: Variant[] = [];
    const syncing = await db.count(JOBS, { state: "running", updatedAt: { gte: stale } });
    if (isErr(syncing)) return syncing;
    for (const size of syncing.value === 0 ? effective : []) {
      if (respecced.length >= REPAIR_SAMPLE) break;
      const behind = await db.findMany<Variant>(VARIANTS, { size: size.name, spec: { ne: spec(size) }, updatedAt: { lt: stale } }, { ...oldestFirst, limit: REPAIR_SAMPLE - respecced.length });
      if (isErr(behind)) return behind;
      respecced.push(...behind.value.items);
    }
    const unstarted: string[] = [];
    const recent = await eachMediaFile({ ...ELIGIBLE, createdSince: at - NEW_ITEM_WINDOW_MS }, async (file) => {
      if (unstarted.length >= REPAIR_SAMPLE) return ok(undefined);
      const has = await db.count(VARIANTS, { mediaId: file.id });
      if (isErr(has)) return has;
      if (has.value === 0) unstarted.push(file.id);
      return ok(undefined);
    });
    if (isErr(recent)) return recent;
    const mediaIdsOf = (rows: Array<{ mediaId: string }>): string[] => rows.map((row) => row.mediaId);
    const list = takeTurns([mediaIdsOf(cutOff.value.items), mediaIdsOf(requested.value.items), mediaIdsOf(stalePending.value.items), mediaIdsOf(stalePlanned.value.items), mediaIdsOf(failedOnce.value.items), mediaIdsOf(respecced), unstarted], REPAIR_SAMPLE);
    for (const id of list) {
      if (closed) return shuttingDown();
      const repaired = await withItem(id, (lease) => (lease.request === "" ? converge(lease) : Promise.resolve(ok(undefined))), async () => ok(undefined));
      if (isErr(repaired)) logger.error(`images: repair pass could not place and render media/${id}`, { mediaId: id, error: repaired.error.message });
    }
    if (closed) return shuttingDown();
    const tried = new Set(list);
    for (const row of [...stalePending.value.items, ...stalePlanned.value.items, ...failedOnce.value.items, ...respecced]) {
      if (!tried.has(row.mediaId)) continue;
      const passed = await db.updateMany<Variant>(VARIANTS, { id: row.id, state: row.state, updatedAt: row.updatedAt }, { updatedAt: now() });
      if (isErr(passed)) logger.error(`images: repair pass could not move media/${row.mediaId} behind the rows still waiting`, { mediaId: row.mediaId, size: row.size, error: passed.error.message });
    }

    const found = await currentJob();
    if (isErr(found)) return found;
    const job = found.value;
    if (!job || job.state === "done") return ok(null);
    if (job.state === "running" && now() - job.updatedAt < config.staleAfterMs) return ok(null);
    if (closed) return shuttingDown();
    const target = await db.updateOne<Job>(JOBS, job.id, { state: "running", updatedAt: now() });
    if (isErr(target)) return target;
    startLoop();
    return ok(target.value);
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

    resume() {
      if (closed) return Promise.resolve(shuttingDown());
      return tracked(repair());
    },

    async retryFailed(mediaId) {
      if (closed) return shuttingDown();
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
      return exclusive(mediaId, async () => {
        const asked = await leaveRequest(mediaId);
        const removed = await removeVariants(mediaId);
        return isErr(asked) && isErr(removed) ? asked : removed;
      }).finally(() => {
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
      const renders = variant.renders ?? 0;
      return renders < 2 ? path : `${path}?v=${versionToken(variant.id, renders)}`;
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
      const ensureCopy = async (media: MediaFile, file: string, expectedSize: number | null | undefined): Promise<Result<void, KestrelError>> => {
        const key = copyKey(media.id, file);
        owned.add(key);
        const entry = files.get(key);
        if (entry !== undefined && (expectedSize === null || expectedSize === undefined || entry.size === expectedSize)) return ok(undefined);
        const kept = await withItem(media.id, (lease) => writeOwnedCopy(lease, media, file), async (): Promise<Result<CopyOutcome, KestrelError>> => ok("skipped"));
        if (isErr(kept)) return kept;
        if (kept.value === "written") written += 1;
        if (kept.value === "missing") missing += 1;
        return ok(undefined);
      };
      const copiedRows = await eachRow<Variant>(VARIANTS, {}, async (row) => {
        const media = ready.get(row.mediaId);
        if (media === undefined || row.state === "planned" || hidden.has(row.mediaId)) return ok(undefined);
        return ensureCopy(media, fileOf(row), row.bytes > 0 ? (privateSizes.get(row.key) ?? media.size) : media.size);
      });
      if (isErr(copiedRows)) return copiedRows;
      const copiedRetired = await eachRow<Retired>(RETIRED, {}, async (row) => {
        const media = ready.get(row.mediaId);
        if (media === undefined || hidden.has(row.mediaId) || owned.has(copyKey(row.mediaId, row.file))) return ok(undefined);
        return ensureCopy(media, row.file, media.size);
      });
      if (isErr(copiedRetired)) return copiedRetired;

      for (const [key, entry] of files) {
        if (owned.has(key)) continue;
        const dropped = await withItem(entry.mediaId, (lease) => removeForeignCopy(lease, key, entry.file), async () => ok(false));
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
        if (config.publicCopy === undefined) {
          const marked = await markHidden(mediaId, true, versionOf(mediaId));
          if (isErr(marked)) return marked;
          continue;
        }
        const asked = await askUnlessAsked(mediaId);
        if (isErr(asked)) return asked;
        const marked = await markHidden(mediaId, true, versionOf(mediaId));
        if (isErr(marked)) return marked;
        const withdraw = async (): Promise<Result<number, KestrelError>> => {
          const still = await isHidden(mediaId);
          if (isErr(still)) return still;
          return still.value ? removeAllCopies(mediaId) : ok(0);
        };
        const withdrawn = await withItem(mediaId, withdraw, withdraw, { asked: asked.value });
        if (isErr(withdrawn)) return withdrawn;
      }
      return ok(undefined);
    },

    async show(mediaIds, versions) {
      const versionOf = (mediaId: string): number | undefined => trashVersionOf(versions, mediaId);
      for (const mediaId of new Set(mediaIds)) {
        if (config.publicCopy === undefined) {
          const unmarked = await markHidden(mediaId, false, versionOf(mediaId));
          if (isErr(unmarked)) return unmarked;
          continue;
        }
        const asked = await askUnlessAsked(mediaId);
        if (isErr(asked)) return asked;
        const unmarked = await markHidden(mediaId, false, versionOf(mediaId));
        if (isErr(unmarked)) return unmarked;
        const rewritten = await withItem(
          mediaId,
          async (lease): Promise<Result<void, KestrelError>> => {
            const hidden = await isHidden(mediaId);
            if (isErr(hidden)) return hidden;
            return hidden.value ? ok(undefined) : writeCopiesOf(mediaId, lease);
          },
          async () => ok(undefined),
          { asked: asked.value, takeIfLetGo: true },
        );
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
      let stored = false;
      const store = async (): Promise<Result<boolean, KestrelError>> => {
        const still = await readMedia(mediaId);
        if (isErr(still)) return still;
        if (still.value === null) return notFound();
        const hiddenMeanwhile = await isHidden(mediaId);
        if (isErr(hiddenMeanwhile)) return hiddenMeanwhile;
        if (hiddenMeanwhile.value) return notFound();
        const previous = await readFraming(mediaId);
        if (isErr(previous)) return previous;
        const written = await writeFraming(mediaId, framing, ow, oh);
        if (isErr(written)) return written;
        stored = true;
        return ok(!sameRect(previous.value?.focus ?? null, framing.focus));
      };
      const answer = { id: mediaId, framing };
      const saved = await withItem(
        mediaId,
        async (lease): Promise<Result<{ id: string; framing: Framing }, KestrelError>> => {
          const focusChanged = await store();
          if (isErr(focusChanged)) return focusChanged;
          const planned = await planItem(mediaId, lease);
          if (planned.ok && planned.value.changed) raiseVariantsChanged([mediaId]);
          else if (focusChanged.value) raiseVariantsChanged([mediaId]);
          return isErr(planned) ? planned : ok(answer);
        },
        async () => {
          const focusChanged = await store();
          if (isErr(focusChanged)) return focusChanged;
          if (focusChanged.value) raiseVariantsChanged([mediaId]);
          return ok(answer);
        },
        { serveLater: true },
      );
      if (isErr(saved) && stored) schedulePlacement(mediaId);
      return saved;
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
      await Promise.allSettled([...calls]);
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
