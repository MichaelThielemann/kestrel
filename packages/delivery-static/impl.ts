import { extname } from "node:path";
import type { z } from "zod";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { err, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import type { Site } from "@michaelthielemann/kestrel-contracts/site";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { exportLlms, validateLlmsConfig, type LlmsSource } from "./llms.ts";
import type { configSchema } from "./module.ts";

export const STATUS = "delivery_publish_status";

export type Config = z.output<typeof configSchema>;
export type TypeConfig = Config["types"][string];
export type MediaConfig = NonNullable<Config["media"]>;

export type State = "live" | "error" | "draft";

export type DeliveryError = KestrelError<"TRANSIENT">;

export interface PublishStatus extends Document {
  type: string;
  docId: string;
  locale: string;
  state: State;
  path: string | null;
  error: string | null;
  publishedAt: number | null;
  updatedAt: number;
}

export interface Delivery {
  publish(type: string, id: string): Promise<Result<PublishStatus[], DeliveryError>>;
  unpublish(type: string, id: string): Promise<Result<number, DeliveryError>>;
  status(type: string, id: string): Promise<Result<PublishStatus[], DeliveryError>>;
  publishAll(type: string): Promise<Result<{ documents: number; live: number; errors: number }, DeliveryError>>;
  exportLlms(): Promise<Result<{ entries: number; full: boolean }, DeliveryError>>;
}

const PAGE = 100;

// Collections are addressed by generated id or by delivery's own filters and every locale comes from
// the content model, so only a transient failure of a dependency is expected here.
function transientOnly(error: KestrelError, source: string): DeliveryError {
  if (error.code !== "TRANSIENT") throw new Error(`delivery/static: unexpected ${source} failure ${error.code}: ${error.message}`);
  return error as DeliveryError;
}

function bytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  webp: "image/webp", avif: "image/avif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml",
  ico: "image/x-icon", pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", json: "application/json", txt: "text/plain",
};

export function contentTypeByExtension(key: string): string {
  const extension = extname(key).slice(1).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function keyFor(prefix: string, path: string, extension: string): string {
  const dir = path === "/" ? "" : `${path.slice(1)}/`;
  return `${prefix}${dir}index.${extension}`;
}

export interface MediaMatch {
  raw: string;
  id: string;
  size?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The negative lookaheads pin the match to a segment boundary: "/file-x" or "/fileabc" must not
// match "/file", and "thumb.webp.bak" must not match "thumb.webp" — but "?" and "/" (query strings,
// trailing path segments) are not in the class, so those still terminate a match correctly.
function mediaPattern(publicPath: string): RegExp {
  return new RegExp(`${escapeRegExp(publicPath)}/([0-9a-f-]{36})/(?:file(?![A-Za-z0-9._-])|variants/([a-z][a-z0-9-]*)\\.([a-z0-9]+)(?![A-Za-z0-9._-]))`, "g");
}

function mediaKey(id: string, size: string | undefined): string {
  return size === undefined ? `${id}|file` : `${id}|${size}`;
}

function mediaMatches(html: string, publicPath: string): MediaMatch[] {
  const re = mediaPattern(publicPath);
  const out: MediaMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push({ raw: m[0], id: m[1]!, ...(m[2] === undefined ? {} : { size: m[2] }) });
  return out;
}

// Pure so it can be unit-tested without a Persistence/Blobstore fake: resolution of ids and copying
// of blobs happens beforehand, this only substitutes text it already has the answer for.
export function rewriteMedia(html: string, publicPath: string, resolve: (match: MediaMatch) => string | undefined): string {
  return html.replace(mediaPattern(publicPath), (raw, id: string, size: string | undefined) => resolve({ raw, id, ...(size === undefined ? {} : { size }) }) ?? raw);
}

interface MediaRow extends Document {
  key: string;
  folder: string;
  filename: string;
  contentType: string;
}

interface VariantRow extends Document {
  mediaId: string;
  size: string;
  key: string;
  state: string;
}

// Mirrors the check the renderer-asset branch already applies to asset.path: media rows are normally
// sanitized by media-default, but delivery-static must not trust that blindly when building blob keys.
function assertSafeMediaSegment(value: string, label: string, id: string): void {
  if (value.startsWith("/") || value.split("/").some((p) => p === "..")) throw new Error(`delivery/static: invalid media ${label} ${JSON.stringify(value)} for ${id}`);
}

async function findManyIn<T extends Document>(db: Persistence, collection: string, field: string, values: string[]): Promise<Result<T[], DeliveryError>> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += 200) {
    const chunk = values.slice(i, i + 200);
    for (let offset = 0; ; offset += 500) {
      const page = await db.findMany<T>(collection, { [field]: { in: chunk } }, { limit: 500, offset });
      if (isErr(page)) return err(transientOnly(page.error, "persistence@1"));
      out.push(...page.value.items);
      if (page.value.items.length < 500) break;
    }
  }
  return ok(out);
}

export async function createDeliveryStatic(config: Config, deps: { content: Content; site: Site; renderer: Renderer; blobs: Blobstore; db: Persistence; logger: Logger }, now: () => number = Date.now): Promise<Delivery> {
  const { content, site, renderer, blobs, db, logger } = deps;
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
  const prepared = await db.ensureCollection(STATUS, { type: "string", docId: "string", locale: "string", state: "string", path: "string", error: "string", publishedAt: "number", updatedAt: "number" });
  if (isErr(prepared)) throw new Error(`delivery/static: cannot prepare "${STATUS}": ${prepared.error.message}`);

  const uploadedAssets = new Set<string>();

  const typeConfig = (type: string): TypeConfig => {
    const tc = config.types[type];
    if (!tc) throw new Error(`delivery/static: type "${type}" is not configured for delivery`);
    return tc;
  };
  const statusRows = async (type: string, id: string): Promise<Result<PublishStatus[], DeliveryError>> => {
    const page = await db.findMany<PublishStatus>(STATUS, { type, docId: id }, { sort: { locale: "asc" } });
    if (isErr(page)) return err(transientOnly(page.error, "persistence@1"));
    return ok(page.value.items);
  };
  const liveSources = async (type: string): Promise<Result<LlmsSource[], DeliveryError>> => {
    const out: LlmsSource[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await db.findMany<PublishStatus>(STATUS, { type, state: "live" }, { sort: { path: "asc" }, limit: 500, offset });
      if (isErr(page)) return err(transientOnly(page.error, "persistence@1"));
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
      if (page.value.items.length < 500) break;
    }
    return ok(out);
  };
  const setStatus = async (type: string, id: string, locale: string, patch: Partial<Omit<PublishStatus, "id" | "type" | "docId" | "locale">>): Promise<Result<PublishStatus, DeliveryError>> => {
    const existing = await db.findOne<PublishStatus>(STATUS, { type, docId: id, locale });
    if (isErr(existing)) return err(transientOnly(existing.error, "persistence@1"));
    const at = now();
    const row = existing.value
      ? await db.updateOne<PublishStatus>(STATUS, existing.value.id, { ...patch, updatedAt: at })
      : await db.createOne<PublishStatus>(STATUS, { type, docId: id, locale, state: "draft", path: null, error: null, publishedAt: null, ...patch, updatedAt: at });
    if (isErr(row)) return err(transientOnly(row.error, "persistence@1"));
    return ok(row.value);
  };
  const removeBlobs = async (path: string | null): Promise<Result<void, DeliveryError>> => {
    if (path === null) return ok();
    for (const format of config.formats) {
      const removed = await blobs.remove(keyFor(config.prefix, path, format));
      if (isErr(removed)) return err(transientOnly(removed.error, "blobstore@1"));
    }
    return ok();
  };

  // Resolution (findMany) and copying (blobs.get/put) both need to happen before the pure rewriteMedia()
  // substitution, so this batches them up front and then feeds a synchronous resolver into it.
  const rewriteAndCopyMedia = async (html: string, logged: Set<string>): Promise<Result<string, DeliveryError>> => {
    const media = config.media;
    if (!media) return ok(html);
    const matches = mediaMatches(html, media.publicPath);
    if (matches.length === 0) return ok(html);

    const ids = [...new Set(matches.map((m) => m.id))];
    const mediaRows = await findManyIn<MediaRow>(db, media.collection, "id", ids);
    if (isErr(mediaRows)) return mediaRows;
    const mediaById = new Map(mediaRows.value.map((r) => [r.id, r]));
    const variantIds = [...new Set(matches.filter((m) => m.size !== undefined).map((m) => m.id))];
    const variantByKey = new Map<string, VariantRow>();
    if (variantIds.length > 0) {
      const variantRows = await findManyIn<VariantRow>(db, media.variants, "mediaId", variantIds);
      if (isErr(variantRows)) return variantRows;
      for (const r of variantRows.value) variantByKey.set(`${r.mediaId}|${r.size}`, r);
    }

    const resolutions = new Map<string, string | undefined>();
    const copies: Array<{ source: string; dest: string; id: string }> = [];
    for (const match of matches) {
      const key = mediaKey(match.id, match.size);
      if (resolutions.has(key)) continue;
      const row = mediaById.get(match.id);
      if (!row) {
        if (!logged.has(key)) {
          logger.error("delivery/static: media reference not exported", { id: match.id, path: match.raw });
          logged.add(key);
        }
        resolutions.set(key, undefined);
        continue;
      }
      assertSafeMediaSegment(row.folder, "folder", match.id);
      assertSafeMediaSegment(row.filename, "filename", match.id);
      const folderPrefix = row.folder ? `${row.folder}/` : "";
      if (match.size === undefined) {
        const dest = `${media.target}${folderPrefix}${row.filename}`;
        copies.push({ source: row.key, dest, id: match.id });
        resolutions.set(key, `/${dest}`);
        continue;
      }
      const variant = variantByKey.get(`${match.id}|${match.size}`);
      if (!variant || variant.state !== "done") {
        if (!logged.has(key)) {
          logger.error("delivery/static: media reference not exported", { id: match.id, size: match.size, path: match.raw });
          logged.add(key);
        }
        resolutions.set(key, undefined);
        continue;
      }
      const ext = extname(variant.key).replace(/^\./, "");
      const dest = `${media.target}${folderPrefix}${row.filename}.${match.size}.${ext}`;
      copies.push({ source: variant.key, dest, id: match.id });
      resolutions.set(key, `/${dest}`);
    }

    for (const { source, dest, id } of copies) {
      const destKey = `${config.prefix}${dest}`;
      if (uploadedAssets.has(destKey)) continue;
      const blob = await blobs.get(source);
      if (isErr(blob)) return err(transientOnly(blob.error, "blobstore@1"));
      // a row without its blob is not "unresolved" (which leaves the URL untouched) — the HTML would
      // otherwise be rewritten to a path nothing ever writes, so this fails the publish like any other
      // copy failure instead.
      if (!blob.value) throw new Error(`delivery/static: media blob ${source} missing for ${id}`);
      const stored = await blobs.put(destKey, blob.value, { contentType: contentTypeByExtension(dest) });
      if (isErr(stored)) return err(transientOnly(stored.error, "blobstore@1"));
      uploadedAssets.add(destKey);
    }

    return ok(rewriteMedia(html, media.publicPath, (match) => resolutions.get(mediaKey(match.id, match.size))));
  };

  const publishLocale = async (type: string, id: string, locale: string | undefined): Promise<Result<PublishStatus, DeliveryError>> => {
    const tc = typeConfig(type);
    const key = locale ?? "";
    const found = await db.findOne<PublishStatus>(STATUS, { type, docId: id, locale: key });
    if (isErr(found)) return err(transientOnly(found.error, "persistence@1"));
    const previous = found.value;
    const unpublished = async (): Promise<Result<PublishStatus, DeliveryError>> => {
      const removed = await removeBlobs(previous?.path ?? null);
      if (isErr(removed)) return removed;
      return setStatus(type, id, key, { state: "draft", path: null, error: null });
    };
    const read = await content.get(type, id, locale === undefined ? {} : { locale });
    if (isErr(read)) return err(transientOnly(read.error, "content@1"));
    const strict = read.value;
    if (!strict) return unpublished();
    if (strict[tc.statusField] !== tc.publishedValue) return unpublished();
    let fetched: ContentDocument = strict;
    if (config.fallback && locale !== undefined) {
      const merged = await content.get(type, id, { locale, fallback: true });
      if (isErr(merged)) return err(transientOnly(merged.error, "content@1"));
      if (merged.value !== null) fetched = merged.value;
    }
    const rules = { home: tc.home, slugField: tc.slugField, prefixPrimary: config.prefixPrimary, fallback: config.fallback, filter: { [tc.statusField]: tc.publishedValue } };
    const options = { ...(locale === undefined ? {} : { locale }), rules };
    const linked = await site.resolveLinks(type, fetched, options);
    if (isErr(linked)) return err(transientOnly(linked.error, "site@1"));
    const doc = linked.value;
    const path = site.pathOf(type, doc, options);
    if (path === null) return setStatus(type, id, key, { state: "error", error: `no ${tc.slugField}` });
    const failed = (message: string): Promise<Result<PublishStatus, DeliveryError>> =>
      setStatus(type, id, key, { state: "error", path: previous?.state === "live" ? previous.path : null, error: message });
    const loggedMedia = new Set<string>();
    try {
      for (const format of config.formats) {
        const rendered = await renderer.render({ type, id, ...(locale === undefined ? {} : { locale }), path, format, document: doc });
        if (isErr(rendered)) return failed(rendered.error.message);
        const out = rendered.value;
        let data: Uint8Array | string = out.data;
        if (config.media && (typeof out.data === "string" || out.contentType.startsWith("text/"))) {
          const html = typeof out.data === "string" ? out.data : new TextDecoder().decode(out.data);
          const rewritten = await rewriteAndCopyMedia(html, loggedMedia);
          if (isErr(rewritten)) return failed(rewritten.error.message);
          data = rewritten.value;
        }
        const stored = await blobs.put(keyFor(config.prefix, path, out.extension), bytes(data), { contentType: out.contentType });
        if (isErr(stored)) return failed(stored.error.message);
        for (const asset of out.assets ?? []) {
          const assetPath = asset.path.replace(/^\/+/, "");
          if (assetPath === "" || assetPath.split("/").some((p) => p === "..")) throw new Error(`delivery/static: invalid asset path ${JSON.stringify(asset.path)}`);
          const key = `${config.prefix}${assetPath}`;
          if (!uploadedAssets.has(key)) {
            const put = await blobs.put(key, bytes(asset.data), { contentType: asset.contentType });
            if (isErr(put)) return failed(put.error.message);
            uploadedAssets.add(key);
          }
        }
      }
      if (previous?.path && previous.path !== path) {
        const removed = await removeBlobs(previous.path);
        if (isErr(removed)) return failed(removed.error.message);
      }
      return setStatus(type, id, key, { state: "live", path, error: null, publishedAt: now() });
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  };

  const publish: Delivery["publish"] = async (type, id) => {
    typeConfig(type);
    const targets = locales.length > 0 ? locales : [undefined];
    const out: PublishStatus[] = [];
    for (const locale of targets) {
      const status = await publishLocale(type, id, locale);
      if (isErr(status)) return status;
      out.push(status.value);
    }
    return ok(out);
  };

  return {
    publish,
    async unpublish(type, id) {
      typeConfig(type);
      const rows = await statusRows(type, id);
      if (isErr(rows)) return rows;
      for (const row of rows.value) {
        const removed = await removeBlobs(row.path);
        if (isErr(removed)) return removed;
      }
      const deleted = await db.deleteMany(STATUS, { type, docId: id });
      if (isErr(deleted)) return err(transientOnly(deleted.error, "persistence@1"));
      return ok(deleted.value);
    },
    async status(type, id) {
      typeConfig(type);
      return statusRows(type, id);
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
    async exportLlms() {
      const exported = await exportLlms(config.llms, { content, blobs, logger, prefix: config.prefix, fallback: config.fallback, defaultLocale: model.defaultLocale, hasLocales: locales.length > 0, types: Object.keys(config.types), sources: liveSources });
      if (isErr(exported)) return err(transientOnly(exported.error, "llms export"));
      return ok(exported.value);
    },
  };
}
