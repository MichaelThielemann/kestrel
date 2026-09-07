import { z } from "zod";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { binaryResult, first, stepFactory, type Context, type StepResult } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createMediaDefault, SORTABLE, type ListOptions, type Media, type MediaItem, type SortField } from "./impl.ts";

export const configSchema = z
  .object({
    allowedTypes: z.array(z.string().min(1)).default(["image/*", "application/pdf"]),
    deniedTypes: z.array(z.string().min(1)).default(["image/svg+xml", "text/html", "application/xhtml+xml"]),
    maxBytes: z.number().int().positive().default(5 * 1024 * 1024),
    locales: z.array(z.string().min(1)).default([]),
    defaultLocale: z.string().min(1).optional(),
    prefix: z.string().regex(/^([A-Za-z0-9._-]+\/)+$/, 'prefix must be one or more "<segment>/" parts, e.g. "media/"').default("media/"),
  })
  .strict();

function localeOf(ctx: Context): string | undefined {
  return ctx.params.locale ?? first(ctx.payload.locale);
}

function idsFrom(value: unknown): string[] {
  const raw: string[] = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : [];
  return [...new Set(raw.flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean))];
}

function listOptions(payload: Record<string, unknown>): ListOptions & { locale?: string } {
  const options: ListOptions & { locale?: string } = {};
  const locale = first(payload.locale);
  if (locale !== undefined) options.locale = locale;
  const folder = first(payload.folder);
  if (folder !== undefined) options.folder = folder;
  const recursive = first(payload.recursive);
  if (payload.recursive === true || recursive === "true") options.recursive = true;
  const q = first(payload.q);
  if (q !== undefined) options.q = q;
  const sort = first(payload.sort);
  if (sort !== undefined && sort !== "") {
    const desc = sort.startsWith("-");
    const field = desc ? sort.slice(1) : sort;
    if ((SORTABLE as readonly string[]).includes(field)) {
      options.sortBy = field as SortField;
      options.direction = desc ? "desc" : "asc";
    }
  }
  const limit = Number(first(payload.limit));
  const offset = Number(first(payload.offset));
  if (Number.isInteger(limit) && limit > 0) options.limit = limit;
  if (Number.isInteger(offset) && offset >= 0) options.offset = offset;
  return options;
}

const PROVENANCE = { type: "object", properties: { origin: { type: "string", enum: ["human", "ai", "mixed", "unknown"] }, tool: { type: "string" }, model: { type: "string" }, at: { type: "number" } }, required: ["origin"], description: "who made the file; anything but human is flagged on download (X-Content-Provenance); an upload without provenance is recorded as unknown" };
const MEDIA_ITEM_SCHEMA = { type: "object", properties: { id: { type: "string" }, filename: { type: "string" }, folder: { type: "string" }, contentType: { type: "string" }, size: { type: "number" }, key: { type: "string" }, checksum: { type: ["string", "null"], description: "sha256 of the uploaded bytes, hex; null for items uploaded before checksums were recorded" }, status: { type: "string", enum: ["uploading", "ready", "failed"], description: "only ready items are listed, readable and downloadable" }, createdAt: { type: "number" }, updatedAt: { type: "number" }, provenance: PROVENANCE, width: { type: ["number", "null"] }, height: { type: ["number", "null"] }, alt: { type: ["string", "null"] }, title: { type: ["string", "null"] }, description: { type: ["string", "null"] } }, required: ["id", "filename", "folder", "contentType", "size", "key", "checksum", "status", "createdAt", "updatedAt", "provenance"] };
const RECONCILE_SCHEMA = { type: "object", properties: { blobsWithoutRow: { type: "array", items: { type: "string" } }, rowsWithoutBlob: { type: "array", items: { type: "string" } } }, required: ["blobsWithoutRow", "rowsWithoutBlob"] };

export default defineModule({
  name: "media/default",
  provides: [],
  requires: [BLOBSTORE, PERSISTENCE],
  configSchema,

  async setup(config, deps): Promise<Media> {
    if (config.defaultLocale !== undefined && !config.locales.includes(config.defaultLocale)) throw new Error("media/default: defaultLocale must be one of locales");
    const media = await createMediaDefault(config, deps.get(BLOBSTORE), deps.get(PERSISTENCE), deps.logger);
    const migrated = await media.migrateKeys();
    if (isErr(migrated)) throw new Error(`media/default: could not migrate blob keys: ${migrated.error.message}`);
    return media;
  },

  steps: (media) => ({
    upload: async (ctx: Context): Promise<StepResult> => {
      if (ctx.files.length === 0) return ctx.fail("VALIDATION", "no file uploaded (multipart field expected)");
      const folder = first(ctx.payload.folder) ?? "";
      if (ctx.files.length === 1) {
        const item = await media.upload(ctx.files[0] as Context["files"][number], folder, ctx.payload.provenance);
        if (isErr(item)) return ctx.fail(item.error);
        return ok({ ...ctx, result: item.value });
      }
      const items: MediaItem[] = [];
      const errors: Array<{ filename: string; status: number; code: string; message: string }> = [];
      for (const file of ctx.files) {
        const item = await media.upload(file, folder, ctx.payload.provenance);
        if (!isErr(item)) {
          items.push(item.value);
          continue;
        }
        // a per-file rejection is reported next to the files that made it through; a failing
        // blobstore or database is not per-file and fails the whole request
        if (item.error.code === "TRANSIENT") return ctx.fail(item.error);
        errors.push({ filename: file.filename, status: item.error.status, code: item.error.code, message: item.error.message });
      }
      return ok({ ...ctx, result: { items, errors, ids: items.map((item) => item.id) } });
    },
    update: async (ctx: Context): Promise<StepResult> => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const patch: { filename?: string; folder?: string; provenance?: unknown; alt?: string | null; title?: string | null; description?: string | null } = {};
      const filename = first(ctx.payload.filename);
      if (filename !== undefined) patch.filename = filename;
      const folder = first(ctx.payload.folder);
      if (folder !== undefined) patch.folder = folder;
      if (ctx.payload.provenance !== undefined) patch.provenance = ctx.payload.provenance;
      for (const field of ["alt", "title", "description"] as const) {
        const value = ctx.payload[field];
        if (value === null || typeof value === "string") patch[field] = value;
      }
      const item = await media.update(ctx.params.id, patch, localeOf(ctx));
      if (isErr(item)) return ctx.fail(item.error);
      if (item.value === null) return ctx.fail("NOT_FOUND", `media/${ctx.params.id} not found`);
      return ok({ ...ctx, result: item.value });
    },
    get: async (ctx: Context): Promise<StepResult> => {
      const notFound = () => ctx.fail("NOT_FOUND", `media/${ctx.params.id ?? ""} not found`);
      if (!ctx.params.id) return notFound();
      const item = await media.get(ctx.params.id, localeOf(ctx));
      if (isErr(item)) return ctx.fail(item.error);
      if (item.value === null) return notFound();
      return ok({ ...ctx, result: item.value });
    },
    list: async (ctx: Context): Promise<StepResult> => {
      const ids = idsFrom(ctx.payload.ids);
      if (ids.length > 0) {
        const items = await media.byIds(ids.slice(0, 200), localeOf(ctx));
        if (isErr(items)) return ctx.fail(items.error);
        return ok({ ...ctx, result: { items: items.value, total: items.value.length } });
      }
      const page = await media.list(listOptions(ctx.payload));
      if (isErr(page)) return ctx.fail(page.error);
      return ok({ ...ctx, result: page.value });
    },
    listFolders: async (ctx: Context): Promise<StepResult> => {
      const folders = await media.folders();
      if (isErr(folders)) return ctx.fail(folders.error);
      return ok({ ...ctx, result: folders.value });
    },
    createFolder: async (ctx: Context): Promise<StepResult> => {
      const path = first(ctx.payload.path);
      if (path === undefined) return ctx.fail("VALIDATION", "missing path");
      const folder = await media.createFolder(path);
      if (isErr(folder)) return ctx.fail(folder.error);
      return ok({ ...ctx, result: folder.value });
    },
    renameFolder: async (ctx: Context): Promise<StepResult> => {
      if (!ctx.params.path) return ctx.fail("VALIDATION", "missing path");
      const path = first(ctx.payload.path);
      if (path === undefined) return ctx.fail("VALIDATION", "missing target path");
      const renamed = await media.renameFolder(ctx.params.path, path);
      if (isErr(renamed)) return ctx.fail(renamed.error);
      if (renamed.value === null) return ctx.fail("NOT_FOUND", `media folder ${ctx.params.path} not found`);
      return ok({ ...ctx, result: renamed.value });
    },
    folderItems: async (ctx: Context): Promise<StepResult> => {
      if (!ctx.params.path) return ctx.fail("VALIDATION", "missing path");
      const found = await media.folderItems(ctx.params.path, ctx.payload.recursive === true || first(ctx.payload.recursive) === "true");
      if (isErr(found)) return ctx.fail(found.error);
      if (found.value === null) return ctx.fail("NOT_FOUND", `media folder ${ctx.params.path} not found`);
      return ok({ ...ctx, result: found.value });
    },
    removeFolder: async (ctx: Context): Promise<StepResult> => {
      if (!ctx.params.path) return ctx.fail("VALIDATION", "missing path");
      const removed = await media.removeFolder(ctx.params.path);
      if (isErr(removed)) return ctx.fail(removed.error);
      if (removed.value === null) return ctx.fail("NOT_FOUND", `media folder ${ctx.params.path} not found`);
      return ok({ ...ctx, result: removed.value });
    },
    download: async (ctx: Context): Promise<StepResult> => {
      const notFound = () => ctx.fail("NOT_FOUND", `media/${ctx.params.id ?? ""} not found`);
      if (!ctx.params.id) return notFound();
      const found = await media.read(ctx.params.id);
      if (isErr(found)) return ctx.fail(found.error);
      if (found.value === null) return notFound();
      const { item, data } = found.value;
      const result = binaryResult(data, item.contentType, item.filename);
      if (item.provenance.origin !== "human") result.headers = { "x-content-provenance": item.provenance.origin };
      return ok({ ...ctx, result });
    },
    remove: async (ctx: Context): Promise<StepResult> => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const removed = await media.remove(ctx.params.id);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok({ ...ctx, result: { ok: true } });
    },
    reconcile: async (ctx: Context): Promise<StepResult> => {
      const report = await media.reconcile({ delete: ctx.payload.delete === true || first(ctx.payload.delete) === "true" });
      if (isErr(report)) return ctx.fail(report.error);
      return ok({ ...ctx, result: report.value });
    },
    reconcileDelete: async (ctx: Context): Promise<StepResult> => {
      const report = await media.reconcile({ delete: true });
      if (isErr(report)) return ctx.fail(report.error);
      return ok({ ...ctx, result: report.value });
    },
    export: stepFactory((dir: string) => async (ctx: Context): Promise<StepResult> => {
      const exported = await media.exportTo(dir);
      if (isErr(exported)) return ctx.fail(exported.error);
      return ok({ ...ctx, result: exported.value });
    }),
  }),

  describe: () => ({
    upload: {
      summary: "Upload one or more files (multipart field `file`, repeatable). A single file returns the item; multiple files return per-file results",
      reads: ["files"],
      writes: ["result"],
      multipart: true,
      input: { type: "object", properties: { folder: { type: "string" }, provenance: { type: "string", description: "origin (human|ai|mixed|unknown) or JSON of the provenance object, applied to every file; omitted means unknown" } } },
      output: {
        oneOf: [
          MEDIA_ITEM_SCHEMA,
          { type: "object", properties: { items: { type: "array", items: MEDIA_ITEM_SCHEMA }, errors: { type: "array", items: { type: "object", properties: { filename: { type: "string" }, status: { type: "number" }, code: { type: "string" }, message: { type: "string" } }, required: ["filename", "status", "code", "message"] } }, ids: { type: "array", items: { type: "string" } } }, required: ["items", "errors", "ids"] },
        ],
      },
      errors: { 400: "no file or invalid folder/provenance (per-file for a multi-file request)", 409: "filename already exists in that folder (per-file for a multi-file request)", 413: "file exceeds maxBytes (per-file for a multi-file request)", 415: "type not allowed (per-file for a multi-file request)" },
    },
    get: { summary: "Media metadata", reads: ["params.id"], writes: ["result"], output: MEDIA_ITEM_SCHEMA, errors: { 400: "unknown locale", 404: "not found" } },
    list: { summary: "List media, newest first", reads: [], writes: ["result"], query: { folder: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } }, output: { type: "object", properties: { items: { type: "array", items: MEDIA_ITEM_SCHEMA }, total: { type: "number" } } }, errors: { 400: "invalid folder or unknown locale" } },
    download: { summary: "The file itself", reads: ["params.id"], writes: ["result"], binary: true, errors: { 404: "not found" } },
    listFolders: { summary: "Folders (persistent and implied) with item counts", reads: [], writes: ["result"], output: { type: "array", items: { type: "object", properties: { folder: { type: "string" }, count: { type: "number" } }, required: ["folder", "count"] } } },
    update: { summary: "Rename, move, set provenance or texts (alt/title/description per locale)", reads: ["params.id"], writes: ["result"], input: { type: "object", properties: { filename: { type: "string" }, folder: { type: "string" }, provenance: PROVENANCE, locale: { type: "string" }, alt: { type: ["string", "null"] }, title: { type: ["string", "null"] }, description: { type: ["string", "null"] } } }, output: MEDIA_ITEM_SCHEMA, errors: { 400: "invalid name, folder or text (texts are plain text, max 2000 chars)", 404: "not found", 409: "filename already exists in that folder" } },
    remove: { summary: "Delete file and metadata", reads: ["params.id"], writes: ["result"], output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, errors: { 400: "missing id" } },
    reconcile: { summary: "Compare the blobs under the media prefix with the media_items rows; with `delete` also removes blobs that no row points at (rows are never deleted)", reads: [], writes: ["result"], input: { type: "object", properties: { delete: { type: "boolean" } } }, output: RECONCILE_SCHEMA },
    reconcileDelete: { summary: "Like media.reconcile, but always deletes the orphan blobs – the deletion is in the pipeline, not in the request", reads: [], writes: ["result"], output: RECONCILE_SCHEMA },
    export: (dir: string) => ({ summary: `Copy every media item to ${dir}/<folder>/<filename>`, reads: [], writes: ["result"], output: { type: "object", properties: { written: { type: "number" }, skipped: { type: "number" }, missing: { type: "number" }, conflicts: { type: "number" } } } }),
    createFolder: { summary: "Create a folder (idempotent: an existing folder is returned unchanged)", reads: [], writes: ["result"], input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, output: { type: "object", properties: { folder: { type: "string" }, count: { type: "number" } }, required: ["folder", "count"] }, errors: { 400: "missing or invalid path" } },
    renameFolder: { summary: "Rename or move a folder, moving its blobs", reads: ["params.path"], writes: ["result"], input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, output: { type: "object", properties: { folder: { type: "string" }, moved: { type: "number" } }, required: ["folder", "moved"] }, errors: { 400: "missing or invalid path", 404: "folder not found", 409: "target folder already exists" } },
    folderItems: { summary: "Item ids in a folder, for use with references.guardAll:media before removeFolder", reads: ["params.path"], writes: ["result"], query: { recursive: { type: "boolean" } }, output: { type: "object", properties: { path: { type: "string" }, ids: { type: "array", items: { type: "string" } } }, required: ["path", "ids"] }, errors: { 400: "missing or invalid path", 404: "folder not found", 409: "folder not empty (without `recursive`)" } },
    removeFolder: { summary: "Delete a folder and everything in it", reads: ["params.path"], writes: ["result"], output: { type: "object", properties: { ok: { type: "boolean" }, removed: { type: "number" } }, required: ["ok", "removed"] }, errors: { 400: "invalid path", 404: "folder not found", 409: "folder not empty or still referenced" } },
  }),
});
