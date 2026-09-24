import type { z } from "zod";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content } from "@michaelthielemann/kestrel-contracts/content";
import { publishedLocale } from "@michaelthielemann/kestrel-contracts/content-locale";
import { err, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Filter } from "@michaelthielemann/kestrel-contracts/query";
import type { Renderer, RenderOutput } from "@michaelthielemann/kestrel-contracts/renderer";
import type { Site } from "@michaelthielemann/kestrel-contracts/site";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { exportLlms, validateLlmsConfig, type LlmsSource } from "./llms.ts";
import type { configSchema } from "./module.ts";

export const STATUS = "delivery_publish_status";

export type Config = z.output<typeof configSchema>;
export type TypeConfig = Config["types"][string];

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

function isTransientError(error: KestrelError): error is DeliveryError {
  return error.code === "TRANSIENT";
}

function transientOnly(error: KestrelError, source: string): DeliveryError {
  if (!isTransientError(error)) throw new Error(`delivery/static: unexpected ${source} failure ${error.code}: ${error.message}`);
  return error;
}

function bytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

export function keyFor(prefix: string, path: string, extension: string): string {
  const dir = path === "/" ? "" : `${path.slice(1)}/`;
  return `${prefix}${dir}index.${extension}`;
}

/** The reserved path `path` equals or lies under, if any. */
export function reservedMatch(path: string, reservedPaths: readonly string[]): string | undefined {
  return reservedPaths.find((reserved) => path === reserved || path.startsWith(`${reserved}/`));
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
    const statusFilter = { [tc.statusField]: tc.publishedValue };
    const viewResult = await publishedLocale(content, type, id, locale, statusFilter, { fallback: config.fallback });
    if (isErr(viewResult)) return err(transientOnly(viewResult.error, "content@1"));
    const fetched = viewResult.value;
    if (!fetched) return unpublished();
    const rules = { home: tc.home, slugField: tc.slugField, prefixPrimary: config.prefixPrimary, fallback: config.fallback, filter: statusFilter };
    const options = { ...(locale === undefined ? {} : { locale }), rules };
    const linked = await site.resolveLinks(type, fetched, options);
    if (isErr(linked)) return err(transientOnly(linked.error, "site@1"));
    const doc = linked.value;
    const path = site.pathOf(type, doc, options);
    if (path === null) {
      const removed = await removeBlobs(previous?.path ?? null);
      if (isErr(removed)) return removed;
      return setStatus(type, id, key, { state: "error", path: null, error: `no ${tc.slugField}` });
    }
    const failed = (message: string): Promise<Result<PublishStatus, DeliveryError>> =>
      setStatus(type, id, key, { state: "error", path: previous?.state === "live" ? previous.path : null, error: message });
    const reservedPage = reservedMatch(path, config.reservedPaths);
    if (reservedPage !== undefined) return failed(`path ${path} is reserved (${reservedPage})`);
    try {
      const outputs: RenderOutput[] = [];
      for (const format of config.formats) {
        const rendered = await renderer.render({ type, id, ...(locale === undefined ? {} : { locale }), path, format, document: doc });
        if (isErr(rendered)) return failed(rendered.error.message);
        for (const asset of rendered.value.assets ?? []) {
          const assetPath = asset.path.replace(/^\/+/, "");
          if (assetPath === "" || assetPath.split("/").some((p) => p === "..")) throw new Error(`delivery/static: invalid asset path ${JSON.stringify(asset.path)}`);
          const reservedAsset = reservedMatch(`/${assetPath}`, config.reservedPaths);
          if (reservedAsset !== undefined) return failed(`asset /${assetPath} lies under the reserved path ${reservedAsset}`);
        }
        outputs.push(rendered.value);
      }
      for (const out of outputs) {
        const stored = await blobs.put(keyFor(config.prefix, path, out.extension), bytes(out.data), { contentType: out.contentType });
        if (isErr(stored)) return failed(stored.error.message);
        for (const asset of out.assets ?? []) {
          const key = `${config.prefix}${asset.path.replace(/^\/+/, "")}`;
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
      const filterFor = (type: string): Filter => {
        const tc = typeConfig(type);
        return { [tc.statusField]: tc.publishedValue };
      };
      const exported = await exportLlms(config.llms, { content, blobs, logger, prefix: config.prefix, fallback: config.fallback, defaultLocale: model.defaultLocale, hasLocales: locales.length > 0, types: Object.keys(config.types), filterFor, sources: liveSources });
      if (isErr(exported)) return err(transientOnly(exported.error, "llms export"));
      return ok(exported.value);
    },
  };
}
