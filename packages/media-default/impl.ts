import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve as resolvePath, sep } from "node:path";
import type { Introspection, PipelineManifest, PipelineStepManifest } from "@michaelthielemann/kestrel";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { LoadedMediaFile, MediaFile, MediaFiles, MediaFilesError, MediaFilter } from "@michaelthielemann/kestrel-contracts/media";
import { canonicalMediaType, mediaTypeAllowed, mediaTypeEssence, mediaTypeMatches, NEUTRAL_EXTENSION, NEUTRAL_TYPE, publicFormOf, verifiedMediaType } from "@michaelthielemann/kestrel-contracts/helpers/mediaType";
import type { Document, Filter, FindOptions, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { err, failure, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { logWarn, type Logger } from "@michaelthielemann/kestrel/logger";
import { noteRead } from "@michaelthielemann/kestrel/reads";
import { imageSize } from "./imageSize.ts";

export const COLLECTION = "media_items";
export const FOLDERS = "media_folders";

export type MediaCode = "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "UNSUPPORTED" | "PAYLOAD_TOO_LARGE" | "TRANSIENT";
export type MediaError = KestrelError<MediaCode>;

export type Origin = "human" | "ai" | "mixed" | "unknown";

export interface Provenance {
  origin: Origin;
  tool?: string;
  model?: string;
  at?: number;
}

export type Texts = Record<string, string>;

/**
 * `removing` is set by the first step of a delete, before any byte is removed; such an item is never ready again.
 * `trashed` hides an item from the library while media@1 still reads it as ready; only a purge ends that.
 */
export type MediaStatus = "uploading" | "ready" | "failed" | "removing" | "trashed";

export interface MediaItem extends Document {
  filename: string;
  folder: string;
  /** `<folder>/<filename>`, unique; `null` while the item is trashed, so its name is free for a new upload. */
  location: string | null;
  contentType: string;
  size: number;
  key: string;
  checksum: string | null;
  status: MediaStatus;
  createdAt: number;
  updatedAt: number;
  provenance: Provenance;
  width: number | null;
  height: number | null;
  alt: string | null;
  title: string | null;
  description: string | null;
  /** Whether the stored bytes of this SVG passed `sanitize.svg` before `media.upload` stored them; only then is it published as `image/svg+xml`. `false` for every other type, and for a row that does not carry the field. */
  svgSanitized: boolean;
  /** The time of the move to the trash; `null` unless the item is trashed. */
  trashedAt: number | null;
  /** Rises by one with every move of the item into or out of the trash; `null` for an item that was never moved. */
  trashVersion: number | null;
}

/** The item's public shape: no storage key, checksum, status or location. */
export interface PublicMediaItem {
  id: string;
  path: string;
  filename: string;
  folder: string;
  contentType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  provenance: Provenance;
  width: number | null;
  height: number | null;
  alt: string | null;
  title: string | null;
  description: string | null;
}

export const TEXT_FIELDS = ["alt", "title", "description"] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export interface TextPatch {
  alt?: string | null;
  title?: string | null;
  description?: string | null;
}

export interface PublicCopyConfig {
  prefix: string;
}

export interface Config {
  allowedTypes: string[];
  deniedTypes: string[];
  maxBytes: number;
  locales: string[];
  defaultLocale?: string | undefined;
  prefix: string;
  publicPath: string;
  publicCopy?: PublicCopyConfig | undefined;
  /** The largest `limit` a list accepts, and the most ids one list by ids reads. */
  maxLimit?: number | undefined;
  /** The page size of a list without `limit`; `maxLimit` when absent. */
  defaultLimit?: number | undefined;
  uploadStaleAfterMs: number;
  anonymousList: "ids" | "all";
  /** How many days a trashed item is kept before `trashIds({ expired: true })` selects it; 30 when absent. */
  trashRetentionDays?: number | undefined;
}

/** Why a trash, restore, selection or purge left an id alone. */
export type TrashSkipReason = "not_found" | "not_trashed";

/** The ids a selection or purge acted on, and the ids it left alone with the reason. */
export interface TrashOutcome {
  ids: string[];
  skipped: Array<{ id: string; reason: TrashSkipReason }>;
}

/** The outcome of a trash or restore: `ids` holds every id that is in the target state afterwards, so a repeated call hands on the ids an earlier, failed call already moved; `unchanged` names those among them that were in that state before. */
export interface MoveOutcome extends TrashOutcome {
  unchanged: string[];
  /** The `trashVersion` of each id in `ids` after the step (`0` for an item never moved), so `images.hide`/`images.show` can ignore a move a later one overtook. */
  versions: Record<string, number>;
}

/** A restore also names every item that came back under another display name because its own was taken. */
export interface RestoreOutcome extends MoveOutcome {
  renamed: Array<{ id: string; from: string; to: string }>;
}

/** A trashed item with the time it was trashed and the time its retention runs out. */
export interface TrashedItem extends MediaItem {
  trashedAt: number;
  expiresAt: number;
}

export interface TrashListOptions {
  limit?: number;
  offset?: number;
  q?: string;
  locale?: string;
}

export const SORTABLE = ["createdAt", "filename", "size"] as const;
export type SortField = (typeof SORTABLE)[number];

export const MEDIA_KINDS = ["image", "video", "other"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface ListOptions extends FindOptions {
  folder?: string;
  recursive?: boolean;
  q?: string;
  sortBy?: SortField;
  direction?: "asc" | "desc";
  /** Keeps only items of this canonical kind: `image` and `video` match their content type's top-level type, `other` matches neither. */
  mediaKind?: MediaKind;
}

/** Whether an item's content type belongs to `kind`, `image`/`video` matching that top-level type, `other` matching neither. */
export function matchesMediaKind(contentType: string, kind: MediaKind): boolean {
  if (kind === "other") return !mediaTypeMatches("image/*", contentType) && !mediaTypeMatches("video/*", contentType);
  return mediaTypeMatches(`${kind}/*`, contentType);
}

export interface Reconciliation {
  blobsWithoutRow: string[];
  rowsWithoutBlob: string[];
}

export interface PublicSync {
  written: number;
  removed: number;
  missing: number;
}

/** `created` is false when the upload was idempotent: same folder, same filename, same checksum, so `item` is the row that was already there. */
export interface Upload {
  item: MediaItem;
  created: boolean;
}

const MEDIA_READ_TYPE = "media";
const READY = { status: "ready" } as const;
const REMOVING = "removing";
const TRASHED = "trashed";
const LIVE = { status: { in: ["uploading", "ready", "failed"] } } as const;
const AVAILABLE = { status: { in: ["ready", TRASHED] } } as const;
const DAY_MS = 86_400_000;
const DEFAULT_TRASH_RETENTION_DAYS = 30;
const MAX_SUFFIX = 1000;
const SCAN_PAGE = 500;
const MAX_SCAN_LIMIT = 500;
const IDS_CHUNK = 200;

function isReady(row: Readonly<Record<string, unknown>>): boolean {
  return row.status === READY.status;
}

function isAvailable(row: Readonly<Record<string, unknown>>): boolean {
  return row.status === READY.status || row.status === TRASHED;
}

function isLive(row: Readonly<Record<string, unknown>>): boolean {
  return row.status !== REMOVING && row.status !== TRASHED;
}


function transientOnly(error: KestrelError): MediaFilesError {
  if (error.code !== "TRANSIENT") throw new Error(`media/default: unexpected store error ${error.code}: ${error.message}`);
  return failure("TRANSIENT", error.message, { cause: error });
}

function mediaFileOf(item: MediaItem): MediaFile {
  return {
    id: item.id,
    contentType: item.contentType,
    publishedType: publishedFileOf(item).contentType,
    size: item.size,
    width: item.width ?? null,
    height: item.height ?? null,
    folder: item.folder,
    filename: item.filename,
    createdAt: item.createdAt,
  };
}

function countableByStore(filter: MediaFilter): Filter | null {
  if ((filter.excludeTypes ?? []).length > 0) return null;
  const types = filter.types ?? ["*"];
  if (types.length !== 1) return null;
  const where: Filter = { ...AVAILABLE };
  if (filter.createdSince !== undefined) where.createdAt = { gte: filter.createdSince };
  const pattern = types[0]!;
  if (pattern.trim() === "*") return where;
  const essence = mediaTypeEssence(pattern);
  if (essence === null || /[%_]/.test(essence)) return null;
  const [type = "", subtype = ""] = essence.split("/");
  if (type === "*") return subtype === "*" ? where : null;
  if (subtype === "*") return { ...where, contentType: { like: `${type}/%` } };
  if (subtype.includes("*") || type === "text") return null;
  return { ...where, contentType: essence };
}

export interface Media extends MediaFiles {
  /** Stores a file under the `canonicalMediaType` form of its declared type, refusing a type that is not exactly one media type. `svgSanitized` says an SVG's bytes passed `sanitize.svg`; `media.upload` sets it from {@link Media.sanitizesSvg}, never from the request. */
  upload(file: { filename: string; contentType: string; data: Uint8Array }, folder?: string, provenance?: unknown, svgSanitized?: boolean): Promise<Result<Upload, MediaError>>;
  get(id: string, locale?: string): Promise<Result<MediaItem | null, MediaError>>;
  /** A text query (`q`) or a `mediaKind: "other"` filter scans every ready item in scope, in batches, since neither can be expressed as a store filter; `image`/`video` and an unfiltered list filter and count at the store directly. */
  list(options?: ListOptions & { locale?: string }): Promise<Result<{ items: MediaItem[]; total: number }, MediaError>>;
  byIds(ids: string[], locale?: string): Promise<Result<MediaItem[], MediaError>>;
  folders(): Promise<Result<Array<{ folder: string; count: number }>, MediaError>>;
  update(id: string, patch: { filename?: string; folder?: string; provenance?: unknown } & TextPatch, locale?: string): Promise<Result<MediaItem | null, MediaError>>;
  read(id: string): Promise<Result<{ item: MediaItem; data: Uint8Array } | null, MediaError>>;
  serveFile(id: string, name: string): Promise<Result<{ item: MediaItem; data: Uint8Array } | null, MediaError>>;
  remove(id: string): Promise<Result<void, MediaError>>;
  exportTo(dir: string): Promise<Result<{ written: number; skipped: number; missing: number; conflicts: number }, MediaError>>;
  createFolder(path: string): Promise<Result<{ folder: string; count: number }, MediaError>>;
  renameFolder(from: string, to: string): Promise<Result<{ folder: string; moved: number } | null, MediaError>>;
  folderItems(path: string, recursive: boolean): Promise<Result<{ path: string; ids: string[] } | null, MediaError>>;
  removeFolder(path: string): Promise<Result<{ ok: true; removed: number; ids: string[] } | null, MediaError>>;
  /** Moves ready items to the trash: the library no longer shows them, their name is free and their public copy is removed, while media@1 still reads them as ready. */
  trash(ids: string[]): Promise<Result<MoveOutcome, MediaError>>;
  /** Trashes every ready item in a folder's subtree, deletes its failed and abandoned uploads, and drops the folder rows of that subtree; an upload still under way stays. Items of the subtree already in the trash are handed on in `ids` and named in `unchanged`, so a repeated call reaches them again even when the folder is gone. `null` for a path with neither a folder nor a trashed item. */
  trashFolder(path: string): Promise<Result<{ path: string; ids: string[]; unchanged: string[]; versions: Record<string, number> } | null, MediaError>>;
  /** Brings trashed items back as they were, recreating their folder and public copy; a taken name becomes `<stem>-<n>.<ext>`, the key and public path never change. */
  restore(ids: string[]): Promise<Result<RestoreOutcome, MediaError>>;
  /** The trashed items, most recently trashed first. */
  listTrash(options?: TrashListOptions): Promise<Result<{ items: TrashedItem[]; total: number }, MediaError>>;
  /** The ids of every trashed item, or with `expired` only of those whose retention has run out. */
  trashIds(options?: { expired?: boolean }): Promise<Result<string[], MediaError>>;
  /** Keeps the trashed ids among `ids`, and those whose purge stopped halfway, reporting every other id as not found or not trashed. */
  selectTrash(ids: string[]): Promise<Result<TrashOutcome, MediaError>>;
  /** Deletes trashed items for good, each as `remove` does, and finishes the delete of an item whose purge stopped halfway; any other id is left alone. */
  purge(ids: string[]): Promise<Result<TrashOutcome, MediaError>>;
  reconcile(options?: { delete?: boolean }): Promise<Result<Reconciliation, MediaError>>;
  syncPublic(): Promise<Result<PublicSync, MediaError>>;
  toPublicItem(item: MediaItem): PublicMediaItem;
  publicCopyEnabled(): boolean;
  anonymousListAllowed(): boolean;
  /** The configured page limits of a list: `max` for `limit` and ids, `fallback` without `limit`. */
  listLimits(): { max: number; fallback: number };
  /**
   * Whether the run is at a `media.upload` step of a pipeline that runs `sanitize.svg` before it, with no
   * step in between that declares a write to `files`. Known from `attach()` and the run's step events, so
   * only for a run of the booted instance this was attached to: an unknown run id — a run outside a booted
   * kestrel, such as one through the `testing/runPipeline` helper, or any run before `attach()` — answers
   * `false`, and an SVG it uploads is stored and published as `.bin` with `application/octet-stream`.
   */
  sanitizesSvg(runId: string): boolean;
  attach(kestrel: Introspection): () => void;
}

export function sortItems(items: MediaItem[], sortBy: SortField | undefined, direction: "asc" | "desc" | undefined): MediaItem[] {
  const field = sortBy ?? "createdAt";
  const sign = (direction ?? (sortBy === undefined ? "desc" : "asc")) === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    if (av < bv) return -sign;
    if (av > bv) return sign;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function keyFor(folder: string, filename: string): string {
  return folder === "" ? filename : `${folder}/${filename}`;
}

function parentsOf(folder: string): string[] {
  const parts = folder.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

const SVG = "image/svg+xml";
const UPLOAD_STEP = "media.upload";
const SANITIZE_STEP = "sanitize.svg";

function isUploadStep(step: PipelineStepManifest): boolean {
  return step.module === "media/default" && step.name === UPLOAD_STEP;
}

function writeRootOf(path: string): string {
  const dot = path.indexOf(".");
  const root = dot === -1 ? path : path.slice(0, dot);
  return root.endsWith("?") ? root.slice(0, -1) : root;
}

function writesFiles(step: PipelineStepManifest): boolean {
  return step.description.writes.some((path) => writeRootOf(path) === "files");
}

function unsanitisedUpload(pipeline: PipelineManifest): string | null {
  const steps = pipeline.steps;
  for (const [at, step] of steps.entries()) {
    if (!isUploadStep(step)) continue;
    let sanitizer = -1;
    for (const [index, earlier] of steps.slice(0, at).entries()) if (earlier.name === SANITIZE_STEP) sanitizer = index;
    if (sanitizer === -1) return `runs ${UPLOAD_STEP} without ${SANITIZE_STEP} before it`;
    const writer = steps.slice(sanitizer + 1, at).find(writesFiles);
    if (writer !== undefined) return `runs ${writer.name} between ${SANITIZE_STEP} and ${UPLOAD_STEP}, which writes the uploaded files again`;
  }
  return null;
}

const ORIGINS = new Set<string>(["human", "ai", "mixed", "unknown"]);

function isOrigin(value: string): value is Origin {
  return ORIGINS.has(value);
}

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseProvenance(value: unknown): Result<Provenance, MediaError> {
  if (value === undefined || value === null || value === "") return ok({ origin: "unknown" });
  const raw: unknown = typeof value === "string" ? (value.startsWith("{") ? JSON.parse(value) : { origin: value }) : value;
  if (!isNonNullObject(raw)) return err(failure("VALIDATION", "media/default: provenance must be an object or origin string"));
  const p = raw;
  if (typeof p.origin !== "string" || !isOrigin(p.origin)) return err(failure("VALIDATION", "media/default: provenance.origin must be human, ai, mixed or unknown"));
  const out: Provenance = { origin: p.origin };
  if (typeof p.tool === "string" && p.tool !== "") out.tool = p.tool;
  if (typeof p.model === "string" && p.model !== "") out.model = p.model;
  if (typeof p.at === "number" && Number.isFinite(p.at)) out.at = p.at;
  return ok(out);
}

const MAX_TEXT_CHARS = 2000;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/;

export function checkPlainText(field: string, value: string): Result<void, MediaError> {
  if (value.length > MAX_TEXT_CHARS || CONTROL_CHARS.test(value)) return err(failure("VALIDATION", `media/default: ${field} must be plain text (max ${MAX_TEXT_CHARS} chars)`));
  return ok();
}

export function safeFolder(folder: string): Result<string, MediaError> {
  const parts = folder.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === "." || p === ".." || !/^[A-Za-z0-9._-]+$/.test(p))) return err(failure("VALIDATION", `media/default: invalid folder ${JSON.stringify(folder)}`));
  return ok(parts.join("/"));
}

function exportTargetPath(base: string, folder: string, filename: string, used: Set<string>): { path: string; conflict: boolean } {
  const ext = extname(filename);
  const stem = ext === "" ? filename : filename.slice(0, -ext.length);
  let candidate = filename;
  let attempt = 1;
  while (used.has(resolvePath(base, folder, candidate))) {
    attempt += 1;
    candidate = `${stem}-${attempt}${ext}`;
  }
  const path = resolvePath(base, folder, candidate);
  used.add(path);
  return { path, conflict: attempt > 1 };
}

const MAX_NAME_BYTES = 200;

function namePrefilter(query: string): { filename?: { like: string } } {
  const longest = query.split(/[%_]/).reduce((a, b) => (b.length > a.length ? b : a), "");
  return longest === "" ? {} : { filename: { like: `%${longest}%` } };
}

function capName(name: string): string {
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  const ext = extname(name);
  const budget = MAX_NAME_BYTES - Buffer.byteLength(ext);
  if (budget <= 0) return Buffer.from(name).subarray(0, MAX_NAME_BYTES).toString("latin1");
  const stem = ext === "" ? name : name.slice(0, -ext.length);
  return Buffer.from(stem).subarray(0, budget).toString("latin1") + ext;
}

function suffixedName(filename: string, attempt: number): string {
  const ext = extname(filename);
  const stem = ext === "" ? filename : filename.slice(0, -ext.length);
  const tail = `-${attempt}${ext}`;
  const budget = MAX_NAME_BYTES - Buffer.byteLength(tail);
  return `${Buffer.from(stem).subarray(0, Math.max(budget, 1)).toString("latin1")}${tail}`;
}

export function safeName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  const named = capName(cleaned === "" ? "file" : cleaned);
  return named.replace(/\.meta\.json$/i, "-meta.json");
}

/** The upload-time name for a file, which is the last segment of its key and of its public URL: the uploaded name reduced by `safeName`, without its extension when the file is published as its own type, with every remaining `.` turned into `-`, and then `.` plus the extension `publicFormOf(contentType, svgSanitized)` gives (`bin` for an unlisted type or an unsanitised SVG). So the name carries exactly one extension, and it always follows the type the file is published as, never the uploaded name. */
export function nameFor(filename: string, contentType: string, svgSanitized = false): string {
  const base = safeName(filename);
  const { extension } = publicFormOf(contentType, svgSanitized);
  const uploadedExt = extname(base);
  const stem = (extension !== NEUTRAL_EXTENSION && uploadedExt !== "" ? base.slice(0, -uploadedExt.length) : base).replace(/\./g, "-").replace(/^-+|-+$/g, "");
  return capName(`${stem === "" ? "file" : stem}.${extension}`);
}

/**
 * The name and `Content-Type` a stored file is published with — the last segment of its public URL and
 * of its public copy, and the type every host, `media.serve` and `media.download` send. The name is the
 * last segment of its key, which never changes: a name stored as `.bin` stays `.bin` and is published as
 * `application/octet-stream`, even once `EXTENSION_BY_TYPE` lists its type, so the name and the
 * type always agree for a static host that types by extension. A name that ends in the extension of
 * `publicFormOf(contentType, svgSanitized)` is published with that type. Any other name — an SVG that
 * did not pass `sanitize.svg`, a stored type that is not one media type — is demoted: every `.` turned
 * into `-`, plus `.bin`, published as `application/octet-stream`.
 */
export function publishedFileOf(item: Pick<MediaItem, "key" | "contentType"> & { svgSanitized?: boolean | null }): { name: string; contentType: string } {
  const name = urlNameOf(item.key);
  const extension = extname(name).slice(1);
  if (extension === NEUTRAL_EXTENSION) return { name, contentType: NEUTRAL_TYPE };
  const form = publicFormOf(item.contentType, item.svgSanitized === true);
  if (extension === form.extension) return { name, contentType: form.contentType };
  return { name: capName(`${name.replace(/\./g, "-")}.${NEUTRAL_EXTENSION}`), contentType: NEUTRAL_TYPE };
}

/** The last path segment of a blob key: for `<prefix><id>/<name>` this is the upload-time `<name>`. */
export function urlNameOf(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

function canonicalIdOf(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1 || rest.includes("/", slash + 1)) return null;
  return rest.slice(0, slash);
}

function isCanonicalKey(key: string, id: string, prefix: string): boolean {
  return canonicalIdOf(key, prefix) === id;
}

/** `<publicCopy.prefix><publicPath without its leading "/">/`: the root under which the public copy of every original lives. */
export function publicTreeOf(config: Pick<Config, "publicPath" | "publicCopy">): string {
  return `${config.publicCopy?.prefix ?? ""}${config.publicPath.slice(1)}/`;
}

export function publicUrlOf(config: Pick<Config, "publicPath">, id: string, name: string): string {
  return `${config.publicPath}/${id}/${name}`;
}

function copyKeyOf(config: Pick<Config, "publicPath" | "publicCopy">, id: string, name: string): string {
  return `${publicTreeOf(config)}${id}/${name}`;
}

export async function createMediaDefault(config: Config, blobs: Blobstore, db: Persistence, logger: Logger, now: () => number = Date.now): Promise<Media> {
  const items = await db.ensureCollection(COLLECTION, {
    filename: "string", folder: "string", location: { type: "string", unique: true }, contentType: "string", size: "number", key: { type: "string", unique: true }, checksum: "string", status: "string", createdAt: "number", updatedAt: "number",
    provenance: "json", width: "number", height: "number", alt: "json", title: "json", description: "json", svgSanitized: "boolean", trashedAt: "number", trashVersion: "number",
  });
  if (isErr(items)) throw new Error(`media/default: cannot prepare collection "${COLLECTION}": ${items.error.message}`);
  const folders = await db.ensureCollection(FOLDERS, { path: "string", createdAt: "number" });
  if (isErr(folders)) throw new Error(`media/default: cannot prepare collection "${FOLDERS}": ${folders.error.message}`);
  const backfilled = await db.updateMany(COLLECTION, { status: { eq: null } }, { status: "ready" });
  if (isErr(backfilled)) throw new Error(`media/default: cannot backfill the status of "${COLLECTION}": ${backfilled.error.message}`);

  const idKey = (id: string, name: string): string => `${config.prefix}${id}/${name}`;
  const sanitizedRuns = new Set<string>();
  const copyKey = (id: string, name: string): string => copyKeyOf(config, id, name);
  const publishedTypeOf = (item: Pick<MediaItem, "id" | "key" | "contentType"> & { svgSanitized?: boolean | null }): string => {
    if (item.svgSanitized !== true && mediaTypeEssence(item.contentType) === SVG) logWarn(logger, `media/default: SVG ${item.id} did not pass sanitize.svg before it was stored, so its public copy is written as ${NEUTRAL_TYPE}`, { id: item.id });
    return publishedFileOf(item).contentType;
  };
  const locationTaken = async (location: string, exceptId?: string): Promise<Result<boolean, MediaError>> => {
    const row = await db.findOne<MediaItem>(COLLECTION, { location });
    if (isErr(row)) return row;
    if (row.value === null || row.value.id === exceptId) return ok(false);
    if (row.value.status !== REMOVING) return ok(true);
    const finished = await removeItem(row.value.id);
    return isErr(finished) ? finished : ok(false);
  };
  const locationConflict = (location: string): MediaError => failure("CONFLICT", `media/default: ${location} already exists`, { details: { collection: COLLECTION, field: "location" } });
  const assertFreeLocation = async (location: string, exceptId?: string): Promise<Result<void, MediaError>> => {
    const taken = await locationTaken(location, exceptId);
    if (isErr(taken)) return taken;
    return taken.value ? err(locationConflict(location)) : ok();
  };
  const existingFor = async (location: string, checksum: string): Promise<Result<MediaItem | null, MediaError>> => {
    const row = await db.findOne<Document>(COLLECTION, { location });
    if (isErr(row)) return row;
    if (row.value === null) return ok(null);
    const item = resolveWith(row.value, fallbackLocale);
    return isReady(item) && item.checksum === checksum ? ok(item) : err(locationConflict(location));
  };
  const releaseFailed = async (location: string): Promise<Result<void, MediaError>> => {
    const row = await db.findOne<MediaItem>(COLLECTION, { location });
    if (isErr(row)) return row;
    if (row.value === null) return ok();
    const item = row.value;
    if (item.status === REMOVING) return removeItem(item.id);
    if (item.status === "uploading") {
      if (now() - item.updatedAt < config.uploadStaleAfterMs) return ok();
      const abandoned = await db.updateMany<MediaItem>(COLLECTION, { id: item.id, status: "uploading" }, { status: "failed", updatedAt: now() });
      if (isErr(abandoned)) return abandoned;
      if (abandoned.value === 0) return ok();
    } else if (item.status !== "failed") return ok();
    if (config.publicCopy !== undefined) {
      const droppedCopy = await blobs.remove(copyKey(item.id, publishedFileOf(item).name));
      if (isErr(droppedCopy)) return droppedCopy;
    }
    const droppedBlob = await blobs.remove(item.key);
    if (isErr(droppedBlob)) return droppedBlob;
    return db.deleteOne(COLLECTION, item.id);
  };
  const ensureFolder = async (path: string): Promise<Result<void, MediaError>> => {
    if (path === "") return ok();
    const existing = await db.findOne(FOLDERS, { path });
    if (isErr(existing)) return existing;
    if (existing.value !== null) return ok();
    const created = await db.createOne(FOLDERS, { path, createdAt: now() });
    return isErr(created) ? created : ok();
  };
  const eachItem = async (filter: Record<string, unknown>, fn: (item: MediaItem) => Promise<Result<void, MediaError>>): Promise<Result<number, MediaError>> => {
    let n = 0;
    let last: string | null = null;
    for (;;) {
      const pageFilter: Record<string, unknown> = last === null ? filter : { ...filter, id: { gt: last } };
      const page = await db.findMany<MediaItem>(COLLECTION, pageFilter, { sort: { id: "asc" }, limit: 500 });
      if (isErr(page)) return page;
      for (const item of page.value.items) {
        const applied = await fn(item);
        if (isErr(applied)) return applied;
        n += 1;
      }
      if (page.value.items.length < 500) break;
      last = page.value.items[page.value.items.length - 1]!.id;
    }
    return ok(n);
  };
  const eachInSubtree = async <T extends Document>(collection: string, field: string, path: string, fn: (item: T) => Promise<Result<void, MediaError>>): Promise<Result<number, MediaError>> => {
    const prefix = `${path}/`;
    let n = 0;
    for (let offset = 0; ; offset += 500) {
      const page = await db.findMany<T>(collection, { [field]: { gte: prefix } }, { sort: { [field]: "asc" }, limit: 500, offset });
      if (isErr(page)) return page;
      for (const item of page.value.items) {
        const value = (item as Record<string, unknown>)[field];
        if (typeof value !== "string" || !value.startsWith(prefix)) return ok(n);
        const applied = await fn(item);
        if (isErr(applied)) return applied;
        n += 1;
      }
      if (page.value.items.length < 500) break;
    }
    return ok(n);
  };
  const recursiveFolderItems = async (path: string): Promise<Result<MediaItem[], MediaError>> => {
    const boundary = `${path}0`;
    const descendant = `${path}/`;
    const out: MediaItem[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await db.findMany<MediaItem>(COLLECTION, { folder: { gte: path }, ...READY }, { sort: { folder: "asc" }, limit: 500, offset });
      if (isErr(page)) return page;
      for (const item of page.value.items) {
        if (item.folder >= boundary) return ok(out);
        if (item.folder === path || item.folder.startsWith(descendant)) out.push(item);
      }
      if (page.value.items.length < 500) break;
    }
    return ok(out);
  };
  const scanAll = async (filter: Record<string, unknown>, sort: Record<string, "asc" | "desc">): Promise<Result<Document[], MediaError>> => {
    const out: Document[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await db.findMany<Document>(COLLECTION, filter, { sort, limit: 500, offset });
      if (isErr(page)) return page;
      out.push(...page.value.items);
      if (page.value.items.length < 500) break;
    }
    return ok(out);
  };
  const subtreeItems = async (path: string): Promise<Result<MediaItem[], MediaError>> => {
    const out: MediaItem[] = [];
    const direct = await eachItem({ folder: path }, async (i) => {
      out.push(i);
      return ok();
    });
    if (isErr(direct)) return direct;
    const nested = await eachInSubtree<MediaItem>(COLLECTION, "folder", path, async (i) => {
      out.push(i);
      return ok();
    });
    if (isErr(nested)) return nested;
    return ok(out);
  };
  const folderExists = async (path: string): Promise<Result<boolean, MediaError>> => {
    const row = await db.findOne(FOLDERS, { path });
    if (isErr(row)) return row;
    if (row.value !== null) return ok(true);
    const direct = await db.count(COLLECTION, { folder: path, ...LIVE });
    if (isErr(direct)) return direct;
    if (direct.value > 0) return ok(true);
    let found = false;
    const nestedItems = await eachInSubtree<MediaItem>(COLLECTION, "folder", path, async (item) => {
      if (isLive(item)) found = true;
      return ok();
    });
    if (isErr(nestedItems)) return nestedItems;
    if (found) return ok(true);
    const nestedFolders = await eachInSubtree<{ id: string; path: string }>(FOLDERS, "path", path, async () => {
      found = true;
      return ok();
    });
    if (isErr(nestedFolders)) return nestedFolders;
    return ok(found);
  };

  const fallbackLocale = config.defaultLocale ?? config.locales[0] ?? "";
  const localeKey = (locale: string | undefined): Result<string, MediaError> => {
    if (locale === undefined) return ok(fallbackLocale);
    if (config.locales.length > 0 && !config.locales.includes(locale)) return err(failure("VALIDATION", `media/default: unknown locale "${locale}"`));
    return ok(locale);
  };
  const resolveWith = (row: Record<string, unknown>, key: string): MediaItem => {
    const item: Record<string, unknown> = { ...row, provenance: row.provenance ?? { origin: "unknown" }, updatedAt: row.updatedAt ?? row.createdAt, width: row.width ?? null, height: row.height ?? null, checksum: row.checksum ?? null, svgSanitized: row.svgSanitized === true, trashedAt: row.trashedAt ?? null, trashVersion: row.trashVersion ?? null };
    for (const field of TEXT_FIELDS) {
      const texts = boundaryCast<Texts | null | undefined>(row[field], "host");
      item[field] = texts?.[key] ?? null;
    }
    return boundaryCast<MediaItem>(item, "host");
  };
  const rowIf = async (id: string, accept: (row: MediaItem) => boolean): Promise<Result<MediaItem | null, MediaError>> => {
    const row = await db.findOne<MediaItem>(COLLECTION, { id });
    if (isErr(row)) return row;
    return ok(row.value !== null && accept(row.value) ? row.value : null);
  };
  const readyRow = (id: string): Promise<Result<MediaItem | null, MediaError>> => rowIf(id, isReady);
  const availableRow = (id: string): Promise<Result<MediaItem | null, MediaError>> => rowIf(id, isAvailable);
  const withBytes = async <T extends MediaItem>(item: T, throwWhenLost: boolean): Promise<Result<{ item: T; data: Uint8Array } | null, MediaError>> => {
    const blob = await blobs.get(item.key);
    if (isErr(blob)) return blob;
    if (blob.value !== null) return ok({ item, data: blob.value });
    const again = await availableRow(item.id);
    if (isErr(again)) return again;
    if (again.value === null) return ok(null);
    if (throwWhenLost) throw new Error(`media/default: blob ${item.key} for ${item.id} is missing`);
    logger.error(`media/default: the stored bytes of ready item ${item.id} are missing`, { id: item.id, key: item.key });
    return ok(null);
  };
  const scanReady = async (filter: MediaFilter, after: string | null, limit: number): Promise<Result<{ items: MediaFile[]; next: string | null }, MediaError>> => {
    const types = filter.types ?? ["*"];
    const excluded = filter.excludeTypes ?? [];
    if (types.length === 0) return ok({ items: [], next: null });
    const base: Filter = filter.createdSince === undefined ? {} : { createdAt: { gte: filter.createdSince } };
    const items: MediaFile[] = [];
    let cursor = after;
    let pageSize = Math.min(SCAN_PAGE, limit);
    for (;;) {
      const page = await db.findMany<MediaItem>(COLLECTION, cursor === null ? base : { ...base, id: { gt: cursor } }, { sort: { id: "asc" }, limit: pageSize });
      if (isErr(page)) return page;
      for (const row of page.value.items) {
        if (!isAvailable(row) || !mediaTypeAllowed(types, excluded, row.contentType)) continue;
        items.push(mediaFileOf(row));
        if (items.length === limit) return ok({ items, next: row.id });
      }
      if (page.value.items.length < pageSize) return ok({ items, next: null });
      cursor = page.value.items[page.value.items.length - 1]!.id;
      pageSize = Math.min(SCAN_PAGE, pageSize * 2);
    }
  };

  const removeItem = async (id: string): Promise<Result<void, MediaError>> => {
    const found = await db.findOne<MediaItem>(COLLECTION, { id });
    if (isErr(found)) return found;
    if (found.value !== null) {
      const item = found.value;
      if (item.status !== REMOVING) {
        const ended = await db.updateMany(COLLECTION, { id }, { status: REMOVING });
        if (isErr(ended)) return ended;
      }
      if (config.publicCopy !== undefined) {
        const droppedCopy = await blobs.remove(copyKey(id, publishedFileOf(item).name));
        if (isErr(droppedCopy)) return droppedCopy;
      }
      const droppedBlob = await blobs.remove(item.key);
      if (isErr(droppedBlob)) return droppedBlob;
      const deleted = await db.deleteOne(COLLECTION, id);
      if (isErr(deleted)) return deleted;
    }
    if (config.publicCopy !== undefined) {
      const treePrefix = `${publicTreeOf(config)}${id}/`;
      const listedCopy = await blobs.list(treePrefix);
      if (isErr(listedCopy)) return listedCopy;
      for (const info of listedCopy.value) {
        if (info.key.slice(treePrefix.length).includes("/")) continue;
        const removed = await blobs.remove(info.key);
        if (isErr(removed)) return removed;
      }
    }
    const privatePrefix = `${config.prefix}${id}/`;
    const listedBlob = await blobs.list(privatePrefix);
    if (isErr(listedBlob)) return listedBlob;
    for (const info of listedBlob.value) {
      const removed = await blobs.remove(info.key);
      if (isErr(removed)) return removed;
    }
    return ok();
  };

  if (config.publicCopy !== undefined) {
    const tree = publicTreeOf(config);
    if (tree.startsWith(config.prefix) || config.prefix.startsWith(tree)) {
      throw new Error(`media/default: publicCopy tree "${tree}" and prefix "${config.prefix}" overlap – the public copies must not share a prefix with the stored files`);
    }
  }
  let layoutViolations = 0;
  let firstViolation: { id: string; key: string } | undefined;
  const layoutChecked = await eachItem({}, async (item) => {
    if (!isCanonicalKey(item.key, item.id, config.prefix)) {
      layoutViolations += 1;
      firstViolation ??= { id: item.id, key: item.key };
    }
    return ok();
  });
  if (isErr(layoutChecked)) throw new Error(`media/default: could not check the stored key layout: ${layoutChecked.error.message}`);
  if (layoutViolations > 0) {
    throw new Error(`media/default: ${layoutViolations} stored item(s) use a blob key other than "${config.prefix}<id>/<name>" (first: ${firstViolation!.id} at "${firstViolation!.key}") – this version reads no other layout; start with an empty media store`);
  }
  const interrupted: string[] = [];
  const causeText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
  try {
    const listed = await eachItem({ status: REMOVING }, async (item) => {
      interrupted.push(item.id);
      return ok();
    });
    if (isErr(listed)) logger.error("media/default: could not list the interrupted deletes at start", { error: listed.error.message });
  } catch (cause) {
    logger.error("media/default: could not list the interrupted deletes at start", { error: causeText(cause) });
  }
  for (const id of interrupted) {
    try {
      const finished = await removeItem(id);
      if (isErr(finished)) logger.error("media/default: could not finish an interrupted delete at start", { id, error: finished.error.message });
    } catch (cause) {
      logger.error("media/default: could not finish an interrupted delete at start", { id, error: causeText(cause) });
    }
  }

  const retentionMs = (config.trashRetentionDays ?? DEFAULT_TRASH_RETENTION_DAYS) * DAY_MS;
  const dropCopy = async (item: MediaItem): Promise<Result<void, MediaError>> => {
    if (config.publicCopy === undefined) return ok();
    return blobs.remove(copyKey(item.id, publishedFileOf(item).name));
  };
  const writeCopy = async (id: string): Promise<Result<void, MediaError>> => {
    if (config.publicCopy === undefined) return ok();
    const row = await readyRow(id);
    if (isErr(row) || row.value === null) return isErr(row) ? row : ok();
    const item = row.value;
    const original = await blobs.get(item.key);
    if (isErr(original)) return original;
    if (original.value === null) {
      logger.error(`media/default: blob ${item.key} for ${item.id} is missing, its public copy was not written`, { id: item.id, key: item.key });
      return ok();
    }
    const key = copyKey(item.id, publishedFileOf(item).name);
    const put = await blobs.put(key, original.value, { contentType: publishedTypeOf(item) });
    if (isErr(put)) return put;
    const still = await readyRow(id);
    if (isErr(still)) return still;
    return still.value === null ? blobs.remove(key) : ok();
  };
  const bringBackInto = async (item: MediaItem): Promise<Result<{ filename: string; version: number } | { changed: MediaItem } | null, MediaError>> => {
    const folderReady = await ensureFolder(item.folder);
    if (isErr(folderReady)) return folderReady;
    for (let attempt = 1; attempt <= MAX_SUFFIX; attempt += 1) {
      const filename = attempt === 1 ? item.filename : suffixedName(item.filename, attempt);
      const location = keyFor(item.folder, filename);
      const released = await releaseFailed(location);
      if (isErr(released)) return released;
      const taken = await locationTaken(location, item.id);
      if (isErr(taken)) return taken;
      if (taken.value) continue;
      const version = (item.trashVersion ?? 0) + 1;
      const restored = await db.updateMany<Document>(COLLECTION, { id: item.id, status: TRASHED, folder: item.folder, trashVersion: item.trashVersion }, { status: "ready", trashedAt: null, location, filename, updatedAt: now(), trashVersion: version });
      if (isErr(restored)) {
        if (restored.error.code === "CONFLICT") continue;
        return restored;
      }
      if (restored.value > 0) return ok({ filename, version });
      const again = await db.findOne<MediaItem>(COLLECTION, { id: item.id });
      if (isErr(again)) return again;
      return ok(again.value?.status === TRASHED ? { changed: again.value } : null);
    }
    return err(locationConflict(keyFor(item.folder, item.filename)));
  };
  const bringBack = async (read: MediaItem): Promise<Result<{ filename: string; version: number } | null, MediaError>> => {
    let item = read;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const back = await bringBackInto(item);
      if (isErr(back)) return back;
      const outcome = back.value;
      if (outcome === null || !("changed" in outcome)) return ok(outcome);
      item = outcome.changed;
    }
    return err(failure("TRANSIENT", `media/default: ${read.id} kept changing while it was restored – restore it again`));
  };
  const trashOne = async (id: string): Promise<Result<{ item: MediaItem; version: number; unchanged: boolean } | null, MediaError>> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await db.findOne<MediaItem>(COLLECTION, { id });
      if (isErr(found)) return found;
      const item = found.value;
      if (item === null || (!isReady(item) && item.status !== TRASHED)) return ok(null);
      if (item.status === TRASHED) return ok({ item, version: item.trashVersion ?? 0, unchanged: true });
      const at = now();
      const version = (item.trashVersion ?? 0) + 1;
      const moved = await db.updateMany<Document>(COLLECTION, { id, ...READY, trashVersion: item.trashVersion }, { status: TRASHED, trashedAt: at, location: null, updatedAt: at, trashVersion: version });
      if (isErr(moved)) return moved;
      if (moved.value > 0) return ok({ item, version, unchanged: false });
    }
    return err(failure("TRANSIENT", `media/default: ${id} kept changing while it was trashed – trash it again`));
  };

  const moveToFolder = async (read: MediaItem, folder: string): Promise<Result<void, MediaError>> => {
    let item: MediaItem | null = read;
    for (let attempt = 0; attempt < 3 && item !== null && item.status !== REMOVING; attempt += 1) {
      const moved: Result<number, MediaError> = item.status === TRASHED
        ? await db.updateMany<Document>(COLLECTION, { id: item.id, status: TRASHED }, { folder })
        : await db.updateMany<Document>(COLLECTION, { id: item.id, ...LIVE }, { folder, location: keyFor(folder, item.filename), updatedAt: now() });
      if (isErr(moved) || moved.value > 0) return isErr(moved) ? moved : ok();
      const again: Result<MediaItem | null, MediaError> = await db.findOne<MediaItem>(COLLECTION, { id: item.id });
      if (isErr(again)) return again;
      item = again.value;
    }
    return ok();
  };
  const finishRemoving = async (items: readonly MediaItem[]): Promise<Result<MediaItem[], MediaError>> => {
    const present: MediaItem[] = [];
    for (const item of items) {
      if (item.status !== REMOVING) {
        present.push(item);
        continue;
      }
      const finished = await removeItem(item.id);
      if (isErr(finished)) return finished;
    }
    return ok(present);
  };

  const api: Media = {
    async upload(file, folder = "", provenance, svgSanitized = false) {
      const verified = verifiedMediaType(file.contentType, file.data);
      const contentType = canonicalMediaType(verified);
      const essence = contentType === null ? null : mediaTypeEssence(contentType);
      if (contentType === null || essence === null || !mediaTypeAllowed(config.allowedTypes, config.deniedTypes, essence)) {
        const declared = verified === file.contentType ? "" : ` (declared as ${JSON.stringify(file.contentType)})`;
        return err(failure("UNSUPPORTED", `media/default: type ${JSON.stringify(verified)}${declared} is not allowed`));
      }
      if (file.data.byteLength > config.maxBytes) return err(failure("PAYLOAD_TOO_LARGE", `media/default: file exceeds ${config.maxBytes} bytes`));
      const folderPath = safeFolder(folder);
      if (isErr(folderPath)) return folderPath;
      const sanitized = svgSanitized && essence === SVG;
      const name = nameFor(file.filename, contentType, sanitized);
      const location = keyFor(folderPath.value, name);
      const released = await releaseFailed(location);
      if (isErr(released)) return released;
      const checksum = createHash("sha256").update(file.data).digest("hex");
      const existing = await existingFor(location, checksum);
      if (isErr(existing)) return existing;
      if (existing.value !== null) return ok({ item: existing.value, created: false });
      const parsedProvenance = parseProvenance(provenance);
      if (isErr(parsedProvenance)) return parsedProvenance;
      const size = essence.startsWith("image/") ? imageSize(file.data) : null;
      const id = randomUUID();
      const key = idKey(id, name);
      const at = now();
      const folderReady = await ensureFolder(folderPath.value);
      if (isErr(folderReady)) return folderReady;
      const created = await db.createOne<Document>(COLLECTION, {
        id, filename: name, folder: folderPath.value, location, contentType, size: file.data.byteLength, key,
        checksum, status: "uploading", createdAt: at, updatedAt: at,
        provenance: parsedProvenance.value, width: size?.width ?? null, height: size?.height ?? null, alt: {}, title: {}, description: {}, svgSanitized: sanitized,
      });
      if (isErr(created)) return created.error.code === "CONFLICT" ? err(locationConflict(location)) : created;
      const stored = await blobs.put(key, file.data, { contentType });
      if (isErr(stored)) {
        const marked = await db.updateOne(COLLECTION, id, { status: "failed", updatedAt: now() });
        if (isErr(marked)) logger.error(`media/default: could not mark ${id} as failed`, { id, key, error: marked.error.message });
        return stored;
      }
      if (config.publicCopy !== undefined) {
        const copied = await blobs.put(copyKey(id, name), file.data, { contentType: publishedTypeOf({ id, key, contentType, svgSanitized: sanitized }) });
        if (isErr(copied)) {
          const removedBlob = await blobs.remove(key);
          if (isErr(removedBlob)) logger.error(`media/default: could not delete blob ${key} after a failed public copy`, { id, key, error: removedBlob.error.message });
          const marked = await db.updateOne(COLLECTION, id, { status: "failed", updatedAt: now() });
          if (isErr(marked)) logger.error(`media/default: could not mark ${id} as failed`, { id, key, error: marked.error.message });
          return copied;
        }
      }
      const readyAt = now();
      const ready = await db.updateMany<Document>(COLLECTION, { id, status: "uploading" }, { status: "ready", updatedAt: readyAt });
      if (isErr(ready)) return ready;
      if (ready.value === 0) {
        if (config.publicCopy !== undefined) {
          const droppedCopy = await blobs.remove(copyKey(id, name));
          if (isErr(droppedCopy)) logger.error(`media/default: could not delete the copy of abandoned upload ${id}`, { id, key, error: droppedCopy.error.message });
        }
        const droppedBlob = await blobs.remove(key);
        if (isErr(droppedBlob)) logger.error(`media/default: could not delete blob ${key} of abandoned upload ${id}`, { id, key, error: droppedBlob.error.message });
        return err(failure("TRANSIENT", `media/default: the upload of ${name} took longer than uploadStaleAfterMs and was abandoned – upload it again`));
      }
      return ok({ item: resolveWith({ ...created.value, status: "ready", updatedAt: readyAt }, fallbackLocale), created: true });
    },
    async get(id, locale) {
      noteRead({ kind: "document", type: MEDIA_READ_TYPE, id });
      const row = await db.findOne<Document>(COLLECTION, { id });
      if (isErr(row)) return row;
      if (row.value === null) return ok(null);
      const key = localeKey(locale);
      if (isErr(key)) return key;
      return ok(isReady(row.value) ? resolveWith(row.value, key.value) : null);
    },
    async list(options = {}) {
      noteRead({ kind: "type", type: MEDIA_READ_TYPE });
      const { folder, recursive, q, sortBy, direction, locale, mediaKind, ...find } = options;
      const key = localeKey(locale);
      if (isErr(key)) return key;
      const query = q?.trim() || undefined;
      const matchesKind = (contentType: unknown): boolean => mediaKind === undefined || (typeof contentType === "string" && matchesMediaKind(contentType, mediaKind));
      if (folder !== undefined && recursive === true) {
        const prefix = safeFolder(folder);
        if (isErr(prefix)) return prefix;
        if (prefix.value !== "") {
          const found = await recursiveFolderItems(prefix.value);
          if (isErr(found)) return found;
          const matched = found.value.filter((i) => (query === undefined || i.filename.includes(query)) && matchesKind(i.contentType));
          const sorted = sortItems(matched, sortBy, direction);
          const offset = find.offset ?? 0;
          const sliced = find.limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + find.limit);
          return ok({ items: sliced.map((i) => resolveWith(i, key.value)), total: sorted.length });
        }
      }
      const filter: Record<string, unknown> = { ...READY };
      if (folder !== undefined) {
        const clean = safeFolder(folder);
        if (isErr(clean)) return clean;
        filter.folder = clean.value;
      }
      if (mediaKind === "image" || mediaKind === "video") filter.contentType = { like: `${mediaKind}/%` };
      const sort: Record<string, "asc" | "desc"> = { [sortBy ?? "createdAt"]: direction ?? (sortBy === undefined ? "desc" : "asc") };
      if (query !== undefined || mediaKind === "other") {
        if (query !== undefined) Object.assign(filter, namePrefilter(query));
        const scanned = await scanAll(filter, sort);
        if (isErr(scanned)) return scanned;
        const candidates = scanned.value.filter((i) => (query === undefined || String(i.filename).includes(query)) && matchesKind(i.contentType));
        const offset = find.offset ?? 0;
        const sliced = find.limit === undefined ? candidates.slice(offset) : candidates.slice(offset, offset + find.limit);
        return ok({ items: sliced.map((i) => resolveWith(i, key.value)), total: candidates.length });
      }
      const page = await db.findMany<Document>(COLLECTION, filter, { sort, ...find });
      if (isErr(page)) return page;
      return ok({ items: page.value.items.map((i) => resolveWith(i, key.value)), total: page.value.total });
    },
    async byIds(ids, locale) {
      for (const id of ids) noteRead({ kind: "document", type: MEDIA_READ_TYPE, id });
      if (ids.length === 0) return ok([]);
      const key = localeKey(locale);
      if (isErr(key)) return key;
      const page = await db.findMany<Document>(COLLECTION, { id: { in: ids }, ...READY }, { limit: ids.length });
      if (isErr(page)) return page;
      const byId = new Map(page.value.items.map((i) => [i.id, resolveWith(i, key.value)]));
      return ok(ids.map((id) => byId.get(id)).filter((i): i is MediaItem => i !== undefined));
    },
    async folders() {
      const counts = new Map<string, number>();
      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<MediaItem>(COLLECTION, {}, { sort: { folder: "asc" }, limit: 500, offset });
        if (isErr(page)) return page;
        for (const item of page.value.items) if (isLive(item)) counts.set(item.folder, (counts.get(item.folder) ?? 0) + 1);
        if (page.value.items.length < 500) break;
      }
      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<{ id: string; path: string }>(FOLDERS, {}, { sort: { path: "asc" }, limit: 500, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) if (!counts.has(row.path)) counts.set(row.path, 0);
        if (page.value.items.length < 500) break;
      }
      for (const folder of [...counts.keys()]) {
        for (const parent of parentsOf(folder)) if (!counts.has(parent)) counts.set(parent, 0);
      }
      counts.delete("");
      return ok([...counts].map(([folder, count]) => ({ folder, count })).sort((a, b) => a.folder.localeCompare(b.folder)));
    },
    async update(id, patch, locale) {
      const found = await db.findOne<Document>(COLLECTION, { id });
      if (isErr(found)) return found;
      const existing = found.value;
      if (existing === null) return ok(null);
      if (existing.status === REMOVING) {
        const finished = await removeItem(id);
        return isErr(finished) ? finished : ok(null);
      }
      if (existing.status === TRASHED) return ok(null);
      const key = localeKey(locale);
      if (isErr(key)) return key;
      const fields: Record<string, unknown> = { updatedAt: now() };
      if (patch.filename !== undefined) fields.filename = safeName(patch.filename);
      if (patch.folder !== undefined) {
        const clean = safeFolder(patch.folder);
        if (isErr(clean)) return clean;
        fields.folder = clean.value;
      }
      if (patch.provenance !== undefined) {
        const parsed = parseProvenance(patch.provenance);
        if (isErr(parsed)) return parsed;
        fields.provenance = parsed.value;
      }
      for (const field of TEXT_FIELDS) {
        const value = patch[field];
        if (value === undefined) continue;
        if (value !== null && typeof value !== "string") return err(failure("VALIDATION", `media/default: ${field} must be a string or null`));
        if (typeof value === "string") {
          const plain = checkPlainText(field, value);
          if (isErr(plain)) return plain;
        }
        const texts: Texts = { ...(boundaryCast<Texts | null | undefined>(existing[field], "host") ?? {}) };
        if (value === null || value === "") delete texts[key.value];
        else texts[key.value] = value;
        fields[field] = texts;
      }
      if (patch.filename !== undefined || patch.folder !== undefined) {
        const nextFolder = boundaryCast<string | undefined>(fields.folder, "host") ?? boundaryCast<string>(existing.folder, "host");
        const nextName = boundaryCast<string | undefined>(fields.filename, "host") ?? boundaryCast<string>(existing.filename, "host");
        const nextLocation = keyFor(nextFolder, nextName);
        if (nextLocation !== existing.location) {
          const free = await assertFreeLocation(nextLocation, id);
          if (isErr(free)) return free;
          const folderReady = await ensureFolder(nextFolder);
          if (isErr(folderReady)) return folderReady;
          fields.location = nextLocation;
        }
      }
      const written = await db.updateMany<Document>(COLLECTION, { id, ...LIVE }, fields);
      if (isErr(written)) return written;
      if (written.value === 0) return ok(null);
      const row = await db.findOne<Document>(COLLECTION, { id });
      if (isErr(row)) return row;
      return ok(row.value === null ? null : resolveWith(row.value, key.value));
    },
    async read(id) {
      noteRead({ kind: "document", type: MEDIA_READ_TYPE, id });
      const row = await db.findOne<Document>(COLLECTION, { id });
      if (isErr(row)) return row;
      if (row.value === null || !isReady(row.value)) return ok(null);
      return withBytes(resolveWith(row.value, fallbackLocale), true);
    },
    async serveFile(id, name) {
      noteRead({ kind: "document", type: MEDIA_READ_TYPE, id });
      const row = await db.findOne<Document>(COLLECTION, { id });
      if (isErr(row)) return row;
      if (row.value === null || !isReady(row.value)) return ok(null);
      const item = resolveWith(row.value, fallbackLocale);
      if (publishedFileOf(item).name !== name) return ok(null);
      return withBytes(item, true);
    },
    async file(id) {
      noteRead({ kind: "document", type: MEDIA_READ_TYPE, id });
      const row = await availableRow(id);
      if (isErr(row)) return err(transientOnly(row.error));
      return ok(row.value === null ? null : mediaFileOf(row.value));
    },
    async files(ids) {
      const unique = [...new Set(ids)];
      for (const id of unique) noteRead({ kind: "document", type: MEDIA_READ_TYPE, id });
      const byId = new Map<string, MediaFile>();
      for (let i = 0; i < unique.length; i += IDS_CHUNK) {
        const chunk = unique.slice(i, i + IDS_CHUNK);
        const page = await db.findMany<MediaItem>(COLLECTION, { id: { in: chunk }, ...AVAILABLE }, { limit: chunk.length });
        if (isErr(page)) return err(transientOnly(page.error));
        for (const row of page.value.items) byId.set(row.id, mediaFileOf(row));
      }
      return ok(unique.flatMap((id) => byId.get(id) ?? []));
    },
    async load(id) {
      noteRead({ kind: "document", type: MEDIA_READ_TYPE, id });
      const row = await availableRow(id);
      if (isErr(row)) return err(transientOnly(row.error));
      if (row.value === null) return ok(null);
      const loaded = await withBytes(row.value, false);
      if (isErr(loaded)) return err(transientOnly(loaded.error));
      if (loaded.value === null) return ok(null);
      const answer: LoadedMediaFile = { file: mediaFileOf(loaded.value.item), data: loaded.value.data };
      return ok(answer);
    },
    async scan(filter, options) {
      const { limit } = options;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCAN_LIMIT) throw new Error(`media/default: scan limit must be an integer from 1 to ${MAX_SCAN_LIMIT}, got ${limit}`);
      noteRead({ kind: "type", type: MEDIA_READ_TYPE });
      const scanned = await scanReady(filter, options.after ?? null, limit);
      return isErr(scanned) ? err(transientOnly(scanned.error)) : scanned;
    },
    async count(filter) {
      noteRead({ kind: "type", type: MEDIA_READ_TYPE });
      const where = countableByStore(filter);
      if (where !== null) {
        const counted = await db.count(COLLECTION, where);
        return isErr(counted) ? err(transientOnly(counted.error)) : counted;
      }
      let total = 0;
      let after: string | null = null;
      for (;;) {
        const page = await scanReady(filter, after, SCAN_PAGE);
        if (isErr(page)) return err(transientOnly(page.error));
        total += page.value.items.length;
        if (page.value.next === null) return ok(total);
        after = page.value.next;
      }
    },
    remove: removeItem,
    async createFolder(path) {
      const clean = safeFolder(path);
      if (isErr(clean)) return clean;
      if (clean.value === "") return err(failure("VALIDATION", "media/default: folder path must not be empty"));
      const created = await ensureFolder(clean.value);
      if (isErr(created)) return created;
      const count = await db.count(COLLECTION, { folder: clean.value, ...LIVE });
      if (isErr(count)) return count;
      return ok({ folder: clean.value, count: count.value });
    },
    async renameFolder(from, to) {
      const source = safeFolder(from);
      if (isErr(source)) return source;
      const target = safeFolder(to);
      if (isErr(target)) return target;
      if (source.value === "" || target.value === "") return err(failure("VALIDATION", "media/default: folder path must not be empty"));
      const sourceExists = await folderExists(source.value);
      if (isErr(sourceExists)) return sourceExists;
      if (!sourceExists.value) return ok(null);
      if (target.value === source.value || target.value.startsWith(`${source.value}/`)) return err(failure("CONFLICT", `media/default: cannot move ${source.value} into itself`));
      const targetExists = await folderExists(target.value);
      if (isErr(targetExists)) return targetExists;
      if (targetExists.value) return err(failure("CONFLICT", `media/default: folder ${target.value} already exists`));
      const inSubtree = await subtreeItems(source.value);
      if (isErr(inSubtree)) return inSubtree;
      const found = await finishRemoving(inSubtree.value);
      if (isErr(found)) return found;
      const retarget = (folder: string): string => target.value + folder.slice(source.value.length);
      const live = found.value.filter(isLive);
      for (const item of live) {
        const free = await assertFreeLocation(keyFor(retarget(item.folder), item.filename), item.id);
        if (isErr(free)) return free;
      }
      for (const item of found.value) {
        const moved = await moveToFolder(item, retarget(item.folder));
        if (isErr(moved)) return moved;
      }
      const page = await db.findMany<{ id: string; path: string }>(FOLDERS, { path: source.value }, { limit: 1 });
      if (isErr(page)) return page;
      const rows = [...page.value.items];
      const nested = await eachInSubtree<{ id: string; path: string }>(FOLDERS, "path", source.value, async (row) => {
        rows.push(row);
        return ok();
      });
      if (isErr(nested)) return nested;
      for (const row of rows) {
        const renamed = await db.updateOne(FOLDERS, row.id, { path: retarget(row.path) });
        if (isErr(renamed)) return renamed;
      }
      const folderReady = await ensureFolder(target.value);
      if (isErr(folderReady)) return folderReady;
      return ok({ folder: target.value, moved: live.length });
    },
    async folderItems(path, recursive) {
      const clean = safeFolder(path);
      if (isErr(clean)) return clean;
      if (clean.value === "") return ok(null);
      const exists = await folderExists(clean.value);
      if (isErr(exists)) return exists;
      if (!exists.value) return ok(null);
      const inSubtree = await subtreeItems(clean.value);
      if (isErr(inSubtree)) return inSubtree;
      const found = inSubtree.value.filter(isLive);
      let subfolders = 0;
      const nested = await eachInSubtree<{ id: string; path: string }>(FOLDERS, "path", clean.value, async () => {
        subfolders += 1;
        return ok();
      });
      if (isErr(nested)) return nested;
      if (!recursive && (found.length > 0 || subfolders > 0)) return err(failure("CONFLICT", `media/default: folder ${clean.value} is not empty`));
      return ok({ path: clean.value, ids: found.map((i) => i.id) });
    },
    async removeFolder(path) {
      const clean = safeFolder(path);
      if (isErr(clean)) return clean;
      if (clean.value === "") return ok(null);
      const exists = await folderExists(clean.value);
      if (isErr(exists)) return exists;
      if (!exists.value) return ok(null);
      const found = await subtreeItems(clean.value);
      if (isErr(found)) return found;
      const ids: string[] = [];
      for (const item of found.value) {
        if (item.status === TRASHED) continue;
        const removed = await removeItem(item.id);
        if (isErr(removed)) return removed;
        ids.push(item.id);
      }
      const subfolderIds: string[] = [];
      const nested = await eachInSubtree<{ id: string; path: string }>(FOLDERS, "path", clean.value, async (row) => {
        subfolderIds.push(row.id);
        return ok();
      });
      if (isErr(nested)) return nested;
      const removedFolder = await db.deleteMany(FOLDERS, { path: clean.value });
      if (isErr(removedFolder)) return removedFolder;
      if (subfolderIds.length > 0) {
        const removedSubfolders = await db.deleteMany(FOLDERS, { id: { in: subfolderIds } });
        if (isErr(removedSubfolders)) return removedSubfolders;
      }
      return ok({ ok: true, removed: ids.length, ids });
    },
    async trash(ids) {
      const outcome: MoveOutcome = { ids: [], unchanged: [], skipped: [], versions: {} };
      for (const id of new Set(ids)) {
        const moved = await trashOne(id);
        if (isErr(moved)) return moved;
        if (moved.value === null) {
          outcome.skipped.push({ id, reason: "not_found" });
          continue;
        }
        if (moved.value.unchanged) outcome.unchanged.push(id);
        outcome.ids.push(id);
        outcome.versions[id] = moved.value.version;
        const dropped = await dropCopy(moved.value.item);
        if (isErr(dropped)) return dropped;
        const restoredMeanwhile = await writeCopy(id);
        if (isErr(restoredMeanwhile)) return restoredMeanwhile;
      }
      return ok(outcome);
    },
    async trashFolder(path) {
      const clean = safeFolder(path);
      if (isErr(clean)) return clean;
      if (clean.value === "") return ok(null);
      const exists = await folderExists(clean.value);
      if (isErr(exists)) return exists;
      const inSubtree = await subtreeItems(clean.value);
      if (isErr(inSubtree)) return inSubtree;
      const movable = inSubtree.value.filter((item) => isReady(item) || item.status === TRASHED).map((item) => item.id);
      if (!exists.value && movable.length === 0) return ok(null);
      const trashed = await api.trash(movable);
      if (isErr(trashed)) return trashed;
      for (const item of inSubtree.value) {
        if (isReady(item) || !isLive(item) || item.location === null) continue;
        const released = await releaseFailed(item.location);
        if (isErr(released)) return released;
      }
      const removed = await db.deleteMany(FOLDERS, { path: clean.value });
      if (isErr(removed)) return removed;
      const subfolderIds: string[] = [];
      const nested = await eachInSubtree<{ id: string; path: string }>(FOLDERS, "path", clean.value, async (row) => {
        subfolderIds.push(row.id);
        return ok();
      });
      if (isErr(nested)) return nested;
      if (subfolderIds.length > 0) {
        const removedSubfolders = await db.deleteMany(FOLDERS, { id: { in: subfolderIds } });
        if (isErr(removedSubfolders)) return removedSubfolders;
      }
      return ok({ path: clean.value, ids: trashed.value.ids, unchanged: trashed.value.unchanged, versions: trashed.value.versions });
    },
    async restore(ids) {
      const outcome: RestoreOutcome = { ids: [], unchanged: [], skipped: [], renamed: [], versions: {} };
      for (const id of new Set(ids)) {
        const found = await db.findOne<MediaItem>(COLLECTION, { id });
        if (isErr(found)) return found;
        const item = found.value;
        if (item === null || (!isReady(item) && item.status !== TRASHED)) {
          outcome.skipped.push({ id, reason: "not_found" });
          continue;
        }
        let version = item.trashVersion ?? 0;
        if (item.status === TRASHED) {
          const back = await bringBack(item);
          if (isErr(back)) return back;
          if (back.value === null) {
            const again = await db.findOne<MediaItem>(COLLECTION, { id });
            if (isErr(again)) return again;
            if (again.value === null || !isReady(again.value)) {
              outcome.skipped.push({ id, reason: "not_found" });
              continue;
            }
            outcome.unchanged.push(id);
            version = again.value.trashVersion ?? 0;
          } else {
            version = back.value.version;
            if (back.value.filename !== item.filename) outcome.renamed.push({ id, from: item.filename, to: back.value.filename });
          }
        } else outcome.unchanged.push(id);
        outcome.ids.push(id);
        outcome.versions[id] = version;
        const copied = await writeCopy(id);
        if (isErr(copied)) return copied;
      }
      return ok(outcome);
    },
    async listTrash(options = {}) {
      const key = localeKey(options.locale);
      if (isErr(key)) return key;
      const filter: Record<string, unknown> = { status: TRASHED };
      const query = options.q?.trim() || undefined;
      if (query !== undefined) Object.assign(filter, namePrefilter(query));
      const sort: Record<string, "asc" | "desc"> = { trashedAt: "desc", id: "asc" };
      const scanned = await scanAll(filter, sort);
      if (isErr(scanned)) return scanned;
      const matched = scanned.value.filter((row) => query === undefined || String(row.filename).includes(query));
      const offset = options.offset ?? 0;
      const sliced = options.limit === undefined ? matched.slice(offset) : matched.slice(offset, offset + options.limit);
      const items = sliced.map((row): TrashedItem => {
        const item = resolveWith(row, key.value);
        const trashedAt = item.trashedAt ?? item.updatedAt;
        return { ...item, trashedAt, expiresAt: trashedAt + retentionMs };
      });
      return ok({ items, total: matched.length });
    },
    async trashIds(options = {}) {
      const filter: Record<string, unknown> = { status: TRASHED };
      if (options.expired === true) filter.trashedAt = { lte: now() - retentionMs };
      const ids: string[] = [];
      const walked = await eachItem(filter, async (item) => {
        ids.push(item.id);
        return ok();
      });
      return isErr(walked) ? walked : ok(ids);
    },
    async selectTrash(ids) {
      const outcome: TrashOutcome = { ids: [], skipped: [] };
      for (const id of new Set(ids)) {
        const found = await db.findOne<MediaItem>(COLLECTION, { id });
        if (isErr(found)) return found;
        if (found.value?.status === TRASHED || found.value?.status === REMOVING) outcome.ids.push(id);
        else outcome.skipped.push({ id, reason: found.value !== null && isReady(found.value) ? "not_trashed" : "not_found" });
      }
      return ok(outcome);
    },
    async purge(ids) {
      const outcome: TrashOutcome = { ids: [], skipped: [] };
      for (const id of new Set(ids)) {
        const ended = await db.updateMany(COLLECTION, { id, status: TRASHED }, { status: REMOVING });
        if (isErr(ended)) return ended;
        if (ended.value === 0) {
          const found = await db.findOne<MediaItem>(COLLECTION, { id });
          if (isErr(found)) return found;
          if (found.value?.status !== REMOVING) {
            outcome.skipped.push({ id, reason: found.value !== null && isReady(found.value) ? "not_trashed" : "not_found" });
            continue;
          }
        }
        const removed = await removeItem(id);
        if (isErr(removed)) return removed;
        outcome.ids.push(id);
      }
      return ok(outcome);
    },
    async reconcile(options = {}) {
      const storedIds = new Set<string>();
      const rowsWithoutBlob: string[] = [];
      const listed = await blobs.list(config.prefix);
      if (isErr(listed)) return listed;
      const present = new Map<string, string>();
      for (const info of listed.value) {
        const id = canonicalIdOf(info.key, config.prefix);
        if (id !== null) present.set(info.key, id);
      }
      const walked = await eachItem({}, async (item) => {
        storedIds.add(item.id);
        if (!present.has(item.key)) rowsWithoutBlob.push(item.key);
        return ok();
      });
      if (isErr(walked)) return walked;
      const blobsWithoutRow = [...present].filter(([, id]) => !storedIds.has(id)).map(([key]) => key).sort();
      if (options.delete === true) {
        for (const key of blobsWithoutRow) {
          const dropped = await blobs.remove(key);
          if (isErr(dropped)) return dropped;
        }
      }
      if (blobsWithoutRow.length > 0 || rowsWithoutBlob.length > 0) {
        logger.info("media/default: blobstore and media_items disagree", { blobsWithoutRow: blobsWithoutRow.length, rowsWithoutBlob: rowsWithoutBlob.length, deleted: options.delete === true ? blobsWithoutRow.length : 0 });
      }
      return ok({ blobsWithoutRow, rowsWithoutBlob: rowsWithoutBlob.sort() });
    },
    async syncPublic() {
      if (config.publicCopy === undefined) return ok({ written: 0, removed: 0, missing: 0 });
      const tree = publicTreeOf(config);
      const listed = await blobs.list(tree);
      if (isErr(listed)) return listed;
      const depth1 = new Map<string, { id: string; size: number }>();
      for (const info of listed.value) {
        const rest = info.key.slice(tree.length);
        const slash = rest.indexOf("/");
        if (slash === -1) continue;
        if (rest.slice(slash + 1).includes("/")) continue;
        depth1.set(info.key, { id: rest.slice(0, slash), size: info.size });
      }
      let written = 0;
      let removed = 0;
      let missing = 0;
      const protect = new Set<string>();
      const expected = new Set<string>();
      const removeCopyIfListed = async (key: string): Promise<Result<void, MediaError>> => {
        if (depth1.delete(key)) removed += 1;
        return blobs.remove(key);
      };
      const processed = await eachItem({}, async (visited) => {
        let item = visited;
        let status = item.status;
        if (status === "uploading") {
          if (now() - item.updatedAt < config.uploadStaleAfterMs) {
            protect.add(item.id);
            return ok();
          }
          const marked = await db.updateMany<MediaItem>(COLLECTION, { id: item.id, status: "uploading" }, { status: "failed", updatedAt: now() });
          if (isErr(marked)) return marked;
          if (marked.value === 1) status = "failed";
          else {
            const current = await db.findOne<MediaItem>(COLLECTION, { id: item.id });
            if (isErr(current)) return current;
            if (current.value === null) return ok();
            item = current.value;
            status = item.status;
          }
        }
        if (status === "removing") {
          const finished = await removeItem(item.id);
          if (isErr(finished)) return finished;
          if (depth1.delete(copyKey(item.id, publishedFileOf(item).name))) removed += 1;
          return ok();
        }
        if (status === "failed") {
          const droppedCopy = await removeCopyIfListed(copyKey(item.id, publishedFileOf(item).name));
          if (isErr(droppedCopy)) return droppedCopy;
          const droppedBlob = await blobs.remove(item.key);
          if (isErr(droppedBlob)) return droppedBlob;
          return ok();
        }
        if (!isReady({ status })) return ok();
        const key = copyKey(item.id, publishedFileOf(item).name);
        expected.add(key);
        const entry = depth1.get(key);
        if (entry !== undefined && entry.size === item.size) return ok();
        const original = await blobs.get(item.key);
        if (isErr(original)) return original;
        if (original.value === null) {
          const still = await readyRow(item.id);
          if (isErr(still)) return still;
          if (still.value === null) {
            expected.delete(key);
            return ok();
          }
          missing += 1;
          logger.error(`media/default: blob ${item.key} for ${item.id} is missing, its public copy was not written`, { id: item.id, key: item.key });
          return ok();
        }
        const put = await blobs.put(key, original.value, { contentType: publishedTypeOf(item) });
        if (isErr(put)) return put;
        const reread = await db.findOne<MediaItem>(COLLECTION, { id: item.id });
        if (isErr(reread)) return reread;
        if (reread.value === null || !isReady(reread.value)) {
          const undone = await blobs.remove(key);
          if (isErr(undone)) return undone;
          expected.delete(key);
          return ok();
        }
        written += 1;
        return ok();
      });
      if (isErr(processed)) return processed;
      for (const [key, entry] of depth1) {
        if (protect.has(entry.id) || expected.has(key)) continue;
        const current = await readyRow(entry.id);
        if (isErr(current)) return current;
        if (current.value !== null && copyKey(entry.id, publishedFileOf(current.value).name) === key) continue;
        const dropped = await blobs.remove(key);
        if (isErr(dropped)) return dropped;
        const after = await readyRow(entry.id);
        if (isErr(after)) return after;
        if (after.value !== null && copyKey(entry.id, publishedFileOf(after.value).name) === key) {
          const rewritten = await writeCopy(entry.id);
          if (isErr(rewritten)) return rewritten;
          continue;
        }
        removed += 1;
      }
      return ok({ written, removed, missing });
    },
    toPublicItem(item) {
      return {
        id: item.id,
        path: publicUrlOf(config, item.id, publishedFileOf(item).name),
        filename: item.filename,
        folder: item.folder,
        contentType: item.contentType,
        size: item.size,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        provenance: item.provenance,
        width: item.width,
        height: item.height,
        alt: item.alt,
        title: item.title,
        description: item.description,
      };
    },
    publicCopyEnabled() {
      return config.publicCopy !== undefined;
    },
    anonymousListAllowed() {
      return config.anonymousList === "all";
    },
    listLimits() {
      const max = config.maxLimit ?? 200;
      return { max, fallback: config.defaultLimit ?? max };
    },
    sanitizesSvg(runId) {
      return sanitizedRuns.has(runId);
    },
    attach(kestrel) {
      const pipelines = kestrel.describe().pipelines;
      const runs = (name: string): boolean => pipelines.some((p) => p.steps.some((s) => s.module === "media/default" && s.name === name));
      const uploading = pipelines.filter((p) => p.steps.some(isUploadStep));
      const sanitizing = new Set(uploading.filter((p) => unsanitisedUpload(p) === null).map((p) => p.name));
      if (config.publicCopy === undefined) {
        const offender = pipelines.find((p) => p.steps.some((s) => s.module === "media/default" && s.name === "media.syncPublic"));
        if (offender) throw new Error(`media/default: pipeline "${offender.name}" runs media.syncPublic, but publicCopy is not set`);
      } else {
        if (!runs("media.serve")) {
          throw new Error(`media/default: publicCopy is set, but no pipeline runs media.serve – the public URL ${config.publicPath}/<id>/<name> must also resolve on this origin`);
        }
        if (mediaTypeAllowed(config.allowedTypes, config.deniedTypes, SVG)) {
          for (const pipeline of uploading) {
            const gap = unsanitisedUpload(pipeline);
            if (gap !== null) throw new Error(`media/default: publicCopy is set and SVG uploads are allowed, but pipeline "${pipeline.name}" ${gap} – an unsanitised SVG would be published; run sanitize.svg before media.upload or deny image/svg+xml`);
          }
        }
      }
      return kestrel.observe({
        stepStart(event) {
          if (event.step === UPLOAD_STEP && sanitizing.has(event.pipeline)) sanitizedRuns.add(event.runId);
        },
        stepEnd(event) {
          if (event.step === UPLOAD_STEP) sanitizedRuns.delete(event.runId);
        },
      });
    },
    async exportTo(dir) {
      const base = resolvePath(dir);
      const used = new Set<string>();
      let written = 0;
      let skipped = 0;
      let missing = 0;
      let conflicts = 0;
      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<MediaItem>(COLLECTION, { ...READY }, { sort: { createdAt: "asc", id: "asc" }, limit: 500, offset });
        if (isErr(page)) return page;
        for (const item of page.value.items) {
          const { path: target, conflict } = exportTargetPath(base, item.folder, item.filename, used);
          if (conflict) conflicts += 1;
          const rel = relative(base, target);
          if (rel.startsWith(`..${sep}`) || rel === ".." || rel === "") throw new Error(`media/default: export target ${target} escapes ${base}`);
          const existing = await stat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (existing && existing.size === item.size && existing.mtimeMs >= item.updatedAt) {
            skipped += 1;
            continue;
          }
          const blob = await blobs.get(item.key);
          if (isErr(blob)) return blob;
          if (blob.value === null) {
            missing += 1;
            continue;
          }
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, blob.value);
          const updated = new Date(item.updatedAt);
          await utimes(target, updated, updated);
          written += 1;
        }
        if (page.value.items.length < 500) break;
      }
      return ok({ written, skipped, missing, conflicts });
    },
  };

  return api;
}
