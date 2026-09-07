import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve as resolvePath, sep } from "node:path";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Document, FindOptions, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { err, failure, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
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

export type MediaStatus = "uploading" | "ready" | "failed";

export interface MediaItem extends Document {
  filename: string;
  folder: string;
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
}

export const TEXT_FIELDS = ["alt", "title", "description"] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export interface TextPatch {
  alt?: string | null;
  title?: string | null;
  description?: string | null;
}

export interface Config {
  allowedTypes: string[];
  deniedTypes: string[];
  maxBytes: number;
  locales: string[];
  defaultLocale?: string | undefined;
  prefix: string;
}

export const SORTABLE = ["createdAt", "filename", "size"] as const;
export type SortField = (typeof SORTABLE)[number];

export interface ListOptions extends FindOptions {
  folder?: string;
  recursive?: boolean;
  q?: string;
  sortBy?: SortField;
  direction?: "asc" | "desc";
}

export interface Reconciliation {
  blobsWithoutRow: string[];
  rowsWithoutBlob: string[];
}

export interface Media {
  upload(file: { filename: string; contentType: string; data: Uint8Array }, folder?: string, provenance?: unknown): Promise<Result<MediaItem, MediaError>>;
  get(id: string, locale?: string): Promise<Result<MediaItem | null, MediaError>>;
  list(options?: ListOptions & { locale?: string }): Promise<Result<{ items: MediaItem[]; total: number }, MediaError>>;
  byIds(ids: string[], locale?: string): Promise<Result<MediaItem[], MediaError>>;
  folders(): Promise<Result<Array<{ folder: string; count: number }>, MediaError>>;
  update(id: string, patch: { filename?: string; folder?: string; provenance?: unknown } & TextPatch, locale?: string): Promise<Result<MediaItem | null, MediaError>>;
  read(id: string): Promise<Result<{ item: MediaItem; data: Uint8Array } | null, MediaError>>;
  remove(id: string): Promise<Result<void, MediaError>>;
  exportTo(dir: string): Promise<Result<{ written: number; skipped: number; missing: number; conflicts: number }, MediaError>>;
  createFolder(path: string): Promise<Result<{ folder: string; count: number }, MediaError>>;
  renameFolder(from: string, to: string): Promise<Result<{ folder: string; moved: number } | null, MediaError>>;
  folderItems(path: string, recursive: boolean): Promise<Result<{ path: string; ids: string[] } | null, MediaError>>;
  removeFolder(path: string): Promise<Result<{ ok: true; removed: number } | null, MediaError>>;
  migrateKeys(): Promise<Result<{ moved: number; renamed: number; missing: number; skipped: number }, MediaError>>;
  reconcile(options?: { delete?: boolean }): Promise<Result<Reconciliation, MediaError>>;
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

function withSuffix(filename: string, n: number): string {
  const ext = extname(filename);
  const stem = ext === "" ? filename : filename.slice(0, -ext.length);
  return `${stem}-${n}${ext}`;
}

function typeAllowed(allowed: string[], contentType: string): boolean {
  return allowed.some((pattern) => pattern === "*" || pattern === contentType || (pattern.endsWith("/*") && contentType.startsWith(pattern.slice(0, -1))));
}

const ORIGINS = new Set<string>(["human", "ai", "mixed", "unknown"]);

export function parseProvenance(value: unknown): Result<Provenance, MediaError> {
  if (value === undefined || value === null || value === "") return ok({ origin: "unknown" });
  const raw: unknown = typeof value === "string" ? (value.startsWith("{") ? JSON.parse(value) : { origin: value }) : value;
  if (typeof raw !== "object" || raw === null) return err(failure("VALIDATION", "media/default: provenance must be an object or origin string"));
  const p = raw as Record<string, unknown>;
  if (typeof p.origin !== "string" || !ORIGINS.has(p.origin)) return err(failure("VALIDATION", "media/default: provenance.origin must be human, ai, mixed or unknown"));
  const out: Provenance = { origin: p.origin as Origin };
  if (typeof p.tool === "string" && p.tool !== "") out.tool = p.tool;
  if (typeof p.model === "string" && p.model !== "") out.model = p.model;
  if (typeof p.at === "number" && Number.isFinite(p.at)) out.at = p.at;
  return ok(out);
}

const MAX_TEXT_CHARS = 2000;
// every C0/C1 control character except tab and newline, which are legitimate in a description
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

const META_SUFFIX = ".meta.json";
const MAX_NAME_BYTES = 200;
// image variants are owned by images/default, which this module cannot query; a media prefix that
// happens to cover their keys must not make reconcile() report or delete them.
const VARIANTS_PREFIX = "media-variants/";

function capName(name: string): string {
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  const ext = extname(name);
  const budget = MAX_NAME_BYTES - Buffer.byteLength(ext);
  if (budget <= 0) return Buffer.from(name).subarray(0, MAX_NAME_BYTES).toString("latin1");
  const stem = ext === "" ? name : name.slice(0, -ext.length);
  return Buffer.from(stem).subarray(0, budget).toString("latin1") + ext;
}

export function safeName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  // capping before the .meta.json fix, so truncation can never re-create the suffix it removes
  const named = capName(cleaned === "" ? "file" : cleaned);
  // a filename ending in .meta.json would collide with a metadata sidecar key; neutralise it here, not just in migration
  return named.replace(/\.meta\.json$/i, "-meta.json");
}

export async function createMediaDefault(config: Config, blobs: Blobstore, db: Persistence, logger: Logger, now: () => number = Date.now): Promise<Media> {
  const items = await db.ensureCollection(COLLECTION, {
    filename: "string", folder: "string", contentType: "string", size: "number", key: "string", checksum: "string", status: "string", createdAt: "number", updatedAt: "number",
    provenance: "json", width: "number", height: "number", alt: "json", title: "json", description: "json",
  });
  if (isErr(items)) throw new Error(`media/default: cannot prepare collection "${COLLECTION}": ${items.error.message}`);
  const folders = await db.ensureCollection(FOLDERS, { path: "string", createdAt: "number" });
  if (isErr(folders)) throw new Error(`media/default: cannot prepare collection "${FOLDERS}": ${folders.error.message}`);
  // rows written before `status` existed are complete uploads; without this backfill they would
  // drop out of every `status: "ready"` filter, because SQL comparisons against NULL never match.
  const backfilled = await db.updateMany(COLLECTION, { status: { eq: null } }, { status: "ready" });
  if (isErr(backfilled)) throw new Error(`media/default: cannot backfill the status of "${COLLECTION}": ${backfilled.error.message}`);

  // media shares the blobstore with replication snapshots, the static site and redirects.json, so every
  // media blob lives under config.prefix; the stored row key is the full blobstore key.
  const blobKey = (folder: string, filename: string): string => config.prefix + keyFor(folder, filename);
  // a repeated move finds the source already gone: if the target is there, only the row update is left to do
  const moveBlob = async (from: string, to: string): Promise<Result<void, MediaError>> => {
    const moved = await blobs.move(from, to);
    if (!isErr(moved) || moved.error.code !== "NOT_FOUND") return moved;
    const target = await blobs.get(to);
    if (isErr(target)) return target;
    return target.value === null ? moved : ok();
  };
  const keyTaken = async (key: string, exceptId?: string): Promise<Result<boolean, MediaError>> => {
    const row = await db.findOne<MediaItem>(COLLECTION, { key });
    if (isErr(row)) return row;
    return ok(row.value !== null && row.value.id !== exceptId);
  };
  const assertFree = async (key: string, exceptId?: string): Promise<Result<void, MediaError>> => {
    const taken = await keyTaken(key, exceptId);
    if (isErr(taken)) return taken;
    return taken.value ? err(failure("CONFLICT", `media/default: ${key} already exists`)) : ok();
  };
  // a row from an upload whose blob write failed owns nothing; it must not block its filename forever
  const releaseFailed = async (key: string): Promise<Result<void, MediaError>> => {
    const row = await db.findOne<MediaItem>(COLLECTION, { key });
    if (isErr(row)) return row;
    if (row.value === null || row.value.status !== "failed") return ok();
    return db.deleteOne(COLLECTION, row.value.id);
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
    for (let offset = 0; ; offset += 500) {
      const page = await db.findMany<MediaItem>(COLLECTION, filter, { sort: { createdAt: "asc", id: "asc" }, limit: 500, offset });
      if (isErr(page)) return page;
      for (const item of page.value.items) {
        const applied = await fn(item);
        if (isErr(applied)) return applied;
        n += 1;
      }
      if (page.value.items.length < 500) break;
    }
    return ok(n);
  };
  // Persistence supports only one operator per field, so a subtree can't be expressed as a single gte+lt range filter.
  // Query `field >= "<path>/"` sorted ascending and stop once a row's value leaves the "<path>/" prefix — the sort
  // keeps every matching row contiguous at the front, so this never needs LIKE (which mistreats "_" as a wildcard
  // and is case-insensitive on SQLite).
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
  // Same one-operator-per-field constraint as eachInSubtree. "0" (0x30) is the first codepoint after "/" (0x2F)
  // among the characters safeFolder allows, so a row at or past "<path>0" can never be "<path>" or a descendant.
  const recursiveFolderItems = async (path: string): Promise<Result<MediaItem[], MediaError>> => {
    const boundary = `${path}0`;
    const descendant = `${path}/`;
    const out: MediaItem[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await db.findMany<MediaItem>(COLLECTION, { folder: { gte: path }, status: "ready" }, { sort: { folder: "asc" }, limit: 500, offset });
      if (isErr(page)) return page;
      for (const item of page.value.items) {
        if (item.folder >= boundary) return ok(out);
        if (item.folder === path || item.folder.startsWith(descendant)) out.push(item);
      }
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
    const direct = await db.count(COLLECTION, { folder: path });
    if (isErr(direct)) return direct;
    if (direct.value > 0) return ok(true);
    let found = false;
    const nestedItems = await eachInSubtree<MediaItem>(COLLECTION, "folder", path, async () => {
      found = true;
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
    const item: Record<string, unknown> = { ...row, provenance: row.provenance ?? { origin: "unknown" }, updatedAt: row.updatedAt ?? row.createdAt, width: row.width ?? null, height: row.height ?? null, checksum: row.checksum ?? null, status: row.status ?? "ready" };
    for (const field of TEXT_FIELDS) {
      const texts = row[field] as Texts | null | undefined;
      item[field] = texts?.[key] ?? null;
    }
    return item as MediaItem;
  };

  return {
    async upload(file, folder = "", provenance) {
      if (!typeAllowed(config.allowedTypes, file.contentType) || typeAllowed(config.deniedTypes, file.contentType)) {
        return err(failure("UNSUPPORTED", `media/default: type ${file.contentType} is not allowed`));
      }
      if (file.data.byteLength > config.maxBytes) return err(failure("PAYLOAD_TOO_LARGE", `media/default: file exceeds ${config.maxBytes} bytes`));
      const id = randomUUID();
      const filename = safeName(file.filename);
      const folderPath = safeFolder(folder);
      if (isErr(folderPath)) return folderPath;
      const key = blobKey(folderPath.value, filename);
      const released = await releaseFailed(key);
      if (isErr(released)) return released;
      const free = await assertFree(key);
      if (isErr(free)) return free;
      const parsedProvenance = parseProvenance(provenance);
      if (isErr(parsedProvenance)) return parsedProvenance;
      const size = file.contentType.startsWith("image/") ? imageSize(file.data) : null;
      const at = now();
      const folderReady = await ensureFolder(folderPath.value);
      if (isErr(folderReady)) return folderReady;
      const created = await db.createOne<Document>(COLLECTION, {
        id, filename, folder: folderPath.value, contentType: file.contentType, size: file.data.byteLength, key,
        checksum: createHash("sha256").update(file.data).digest("hex"), status: "uploading", createdAt: at, updatedAt: at,
        provenance: parsedProvenance.value, width: size?.width ?? null, height: size?.height ?? null, alt: {}, title: {}, description: {},
      });
      if (isErr(created)) return created;
      const stored = await blobs.put(key, { data: file.data, contentType: file.contentType });
      if (isErr(stored)) {
        const marked = await db.updateOne(COLLECTION, id, { status: "failed", updatedAt: now() });
        if (isErr(marked)) logger.error(`media/default: could not mark ${id} as failed`, { id, key, error: marked.error.message });
        return stored;
      }
      const ready = await db.updateOne<Document>(COLLECTION, id, { status: "ready", updatedAt: now() });
      if (isErr(ready)) return ready;
      return ok(resolveWith(ready.value, fallbackLocale));
    },
    async get(id, locale) {
      const row = await db.findOne<Document>(COLLECTION, { id });
      if (isErr(row)) return row;
      if (row.value === null) return ok(null);
      const key = localeKey(locale);
      if (isErr(key)) return key;
      const item = resolveWith(row.value, key.value);
      return ok(item.status === "ready" ? item : null);
    },
    async list(options = {}) {
      const { folder, recursive, q, sortBy, direction, locale, ...find } = options;
      const key = localeKey(locale);
      if (isErr(key)) return key;
      const query = q?.trim() || undefined;
      if (folder !== undefined && recursive === true) {
        const prefix = safeFolder(folder);
        if (isErr(prefix)) return prefix;
        if (prefix.value !== "") {
          const found = await recursiveFolderItems(prefix.value);
          if (isErr(found)) return found;
          const matched = query === undefined ? found.value : found.value.filter((i) => i.filename.includes(query));
          const sorted = sortItems(matched, sortBy, direction);
          const offset = find.offset ?? 0;
          const sliced = find.limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + find.limit);
          return ok({ items: sliced.map((i) => resolveWith(i, key.value)), total: sorted.length });
        }
      }
      const filter: Record<string, unknown> = { status: "ready" };
      if (folder !== undefined) {
        const clean = safeFolder(folder);
        if (isErr(clean)) return clean;
        filter.folder = clean.value;
      }
      const sort: Record<string, "asc" | "desc"> = { [sortBy ?? "createdAt"]: direction ?? (sortBy === undefined ? "desc" : "asc") };
      if (query !== undefined) {
        // LIKE is ASCII case-insensitive in SQL, so it can only narrow; the exact match is applied here.
        filter.filename = { like: `%${query.replace(/[%_]/g, "")}%` };
        const page = await db.findMany<Document>(COLLECTION, filter, { sort });
        if (isErr(page)) return page;
        const candidates = page.value.items.filter((i) => String(i.filename).includes(query));
        const offset = find.offset ?? 0;
        const sliced = find.limit === undefined ? candidates.slice(offset) : candidates.slice(offset, offset + find.limit);
        return ok({ items: sliced.map((i) => resolveWith(i, key.value)), total: candidates.length });
      }
      const page = await db.findMany<Document>(COLLECTION, filter, { sort, ...find });
      if (isErr(page)) return page;
      return ok({ items: page.value.items.map((i) => resolveWith(i, key.value)), total: page.value.total });
    },
    async byIds(ids, locale) {
      if (ids.length === 0) return ok([]);
      const key = localeKey(locale);
      if (isErr(key)) return key;
      const page = await db.findMany<Document>(COLLECTION, { id: { in: ids }, status: "ready" }, { limit: ids.length });
      if (isErr(page)) return page;
      const byId = new Map(page.value.items.map((i) => [i.id, resolveWith(i, key.value)]));
      return ok(ids.map((id) => byId.get(id)).filter((i): i is MediaItem => i !== undefined));
    },
    async folders() {
      const counts = new Map<string, number>();
      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<MediaItem>(COLLECTION, {}, { sort: { folder: "asc" }, limit: 500, offset });
        if (isErr(page)) return page;
        for (const item of page.value.items) counts.set(item.folder, (counts.get(item.folder) ?? 0) + 1);
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
        const texts: Texts = { ...((existing[field] as Texts | null | undefined) ?? {}) };
        if (value === null || value === "") delete texts[key.value];
        else texts[key.value] = value;
        fields[field] = texts;
      }
      // fields is fully built and validated (including text fields) before we touch the blob, so a rejected
      // patch never leaves the blob moved with no matching row.
      let moved: { from: string; to: string } | null = null;
      if (patch.filename !== undefined || patch.folder !== undefined) {
        const nextFolder = (fields.folder as string | undefined) ?? (existing.folder as string);
        const nextName = (fields.filename as string | undefined) ?? (existing.filename as string);
        const nextKey = blobKey(nextFolder, nextName);
        if (nextKey !== existing.key) {
          const free = await assertFree(nextKey, id);
          if (isErr(free)) return free;
          const relocated = await moveBlob(existing.key as string, nextKey);
          if (isErr(relocated)) return relocated;
          const folderReady = await ensureFolder(nextFolder);
          if (isErr(folderReady)) return folderReady;
          fields.key = nextKey;
          moved = { from: existing.key as string, to: nextKey };
        }
      }
      const row = await db.updateOne<Document>(COLLECTION, id, fields);
      if (isErr(row)) {
        if (moved !== null) {
          const back = await moveBlob(moved.to, moved.from);
          if (isErr(back)) logger.error(`media/default: could not move ${moved.to} back to ${moved.from} after a failed row update`, { id, error: back.error.message });
        }
        return row;
      }
      return ok(resolveWith(row.value, key.value));
    },
    async read(id) {
      const row = await db.findOne<Document>(COLLECTION, { id });
      if (isErr(row)) return row;
      if (row.value === null) return ok(null);
      const item = resolveWith(row.value, fallbackLocale);
      if (item.status !== "ready") return ok(null);
      const blob = await blobs.get(item.key);
      if (isErr(blob)) return blob;
      if (blob.value === null) throw new Error(`media/default: blob ${item.key} for ${id} is missing`);
      return ok({ item, data: blob.value.data });
    },
    async remove(id) {
      const found = await db.findOne<MediaItem>(COLLECTION, { id });
      if (isErr(found)) return found;
      if (found.value === null) return ok();
      const item = found.value;
      const deleted = await db.deleteOne(COLLECTION, id);
      if (isErr(deleted)) return deleted;
      // the row is gone, so the blob is already unreachable; media.reconcile sweeps it up later
      const dropped = await blobs.remove(item.key);
      if (isErr(dropped)) logger.error(`media/default: could not delete blob ${item.key} of removed item ${id}`, { id, key: item.key, error: dropped.error.message });
      return ok();
    },
    async createFolder(path) {
      const clean = safeFolder(path);
      if (isErr(clean)) return clean;
      if (clean.value === "") return err(failure("VALIDATION", "media/default: folder path must not be empty"));
      const created = await ensureFolder(clean.value);
      if (isErr(created)) return created;
      const count = await db.count(COLLECTION, { folder: clean.value });
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
      const found = await subtreeItems(source.value);
      if (isErr(found)) return found;
      const retarget = (folder: string): string => target.value + folder.slice(source.value.length);
      for (const item of found.value) {
        const free = await assertFree(blobKey(retarget(item.folder), item.filename), item.id);
        if (isErr(free)) return free;
      }
      for (const item of found.value) {
        const folder = retarget(item.folder);
        const key = blobKey(folder, item.filename);
        const relocated = await moveBlob(item.key, key);
        if (isErr(relocated)) return relocated;
        const updated = await db.updateOne(COLLECTION, item.id, { folder, key, updatedAt: now() });
        if (isErr(updated)) return updated;
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
      return ok({ folder: target.value, moved: found.value.length });
    },
    async folderItems(path, recursive) {
      const clean = safeFolder(path);
      if (isErr(clean)) return clean;
      if (clean.value === "") return ok(null);
      const exists = await folderExists(clean.value);
      if (isErr(exists)) return exists;
      if (!exists.value) return ok(null);
      const found = await subtreeItems(clean.value);
      if (isErr(found)) return found;
      let subfolders = 0;
      const nested = await eachInSubtree<{ id: string; path: string }>(FOLDERS, "path", clean.value, async () => {
        subfolders += 1;
        return ok();
      });
      if (isErr(nested)) return nested;
      if (!recursive && (found.value.length > 0 || subfolders > 0)) return err(failure("CONFLICT", `media/default: folder ${clean.value} is not empty`));
      return ok({ path: clean.value, ids: found.value.map((i) => i.id) });
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
      for (const item of found.value) {
        const dropped = await blobs.remove(item.key);
        if (isErr(dropped)) return dropped;
        const deleted = await db.deleteOne(COLLECTION, item.id);
        if (isErr(deleted)) return deleted;
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
      return ok({ ok: true, removed: found.value.length });
    },
    async migrateKeys() {
      let moved = 0;
      let renamed = 0;
      let missing = 0;
      let skipped = 0;
      const migrate = async (item: MediaItem): Promise<Result<void, MediaError>> => {
        let filename = item.filename;
        let key = blobKey(item.folder, filename);
        const desired = key;
        if (key === item.key) return ok();
        // a folder/filename that safeFolder/safeName would themselves change (or reject), or a key that
        // would land on a metadata-sidecar suffix, is not safe to migrate automatically; leave it for
        // manual cleanup instead of silently renaming or moving it.
        const cleanFolder = safeFolder(item.folder);
        if (isErr(cleanFolder) || cleanFolder.value !== item.folder || safeName(item.filename) !== item.filename || key.endsWith(META_SUFFIX)) {
          skipped += 1;
          logger.error(`media/default: item ${item.id} (${item.folder}/${item.filename}) cannot be safely migrated, skipped`, { id: item.id, key: item.key });
          return ok();
        }
        const current = await blobs.get(item.key);
        if (isErr(current)) return current;
        if (current.value === null) {
          // an interrupted earlier run may have moved the blob already; then only the row is behind
          const already = await blobs.get(desired);
          if (isErr(already)) return already;
          if (already.value !== null) {
            const folderReady = await ensureFolder(item.folder);
            if (isErr(folderReady)) return folderReady;
            const updated = await db.updateOne(COLLECTION, item.id, { key: desired, filename });
            if (isErr(updated)) return updated;
            moved += 1;
            return ok();
          }
          missing += 1;
          logger.error(`media/default: blob ${item.key} for ${item.id} is missing, key not migrated`, { id: item.id, key: item.key });
          return ok();
        }
        for (let n = 2; ; n += 1) {
          const taken = await keyTaken(key, item.id);
          if (isErr(taken)) return taken;
          const present = await blobs.get(key);
          if (isErr(present)) return present;
          if (!taken.value && present.value === null) break;
          filename = withSuffix(item.filename, n);
          key = blobKey(item.folder, filename);
        }
        if (filename !== item.filename) renamed += 1;
        const relocated = await moveBlob(item.key, key);
        if (isErr(relocated)) return relocated;
        const folderReady = await ensureFolder(item.folder);
        if (isErr(folderReady)) return folderReady;
        const updated = await db.updateOne(COLLECTION, item.id, { key, filename });
        if (isErr(updated)) return updated;
        moved += 1;
        return ok();
      };
      const walked = await eachItem({}, async (item) => {
        const migrated = await migrate(item);
        if (isErr(migrated)) {
          skipped += 1;
          logger.error(`media/default: failed to migrate key for ${item.id}`, { id: item.id, key: item.key, error: migrated.error.message });
        }
        return ok();
      });
      if (isErr(walked)) return walked;
      if (moved > 0 || missing > 0 || skipped > 0) logger.info("media/default: migrated blob keys to <prefix><folder>/<filename>", { moved, renamed, missing, skipped });
      return ok({ moved, renamed, missing, skipped });
    },
    async reconcile(options = {}) {
      const stored = new Set<string>();
      const rowsWithoutBlob: string[] = [];
      const listed = await blobs.list(config.prefix);
      if (isErr(listed)) return listed;
      const present = new Set(listed.value.map((info) => info.key).filter((key) => !key.startsWith(VARIANTS_PREFIX)));
      const walked = await eachItem({}, async (item) => {
        stored.add(item.key);
        if (!present.has(item.key)) rowsWithoutBlob.push(item.key);
        return ok();
      });
      if (isErr(walked)) return walked;
      const blobsWithoutRow = [...present].filter((key) => !stored.has(key)).sort();
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
    async exportTo(dir) {
      const base = resolvePath(dir);
      const used = new Set<string>();
      let written = 0;
      let skipped = 0;
      let missing = 0;
      let conflicts = 0;
      for (let offset = 0; ; offset += 500) {
        const page = await db.findMany<MediaItem>(COLLECTION, {}, { sort: { createdAt: "asc", id: "asc" }, limit: 500, offset });
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
          await writeFile(target, blob.value.data);
          const updated = new Date(item.updatedAt);
          await utimes(target, updated, updated);
          written += 1;
        }
        if (page.value.items.length < 500) break;
      }
      return ok({ written, skipped, missing, conflicts });
    },
  };
}
