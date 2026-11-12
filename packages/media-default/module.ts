import { z } from "zod";
import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import { AUTHZ, type AuthzError } from "@michaelthielemann/kestrel-contracts/authz";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { MEDIA } from "@michaelthielemann/kestrel-contracts/media";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { binaryResult, first, stepFactory, type Context, type StepResult } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import { createMediaDefault, MEDIA_KINDS, publishedFileOf, SORTABLE, type ListOptions, type Media, type MediaItem, type MediaKind, type SortField, type TrashListOptions, type TrashOutcome } from "./impl.ts";

export const configSchema = z
  .object({
    allowedTypes: z.array(z.string().min(1)).default(["image/*", "application/pdf"]),
    deniedTypes: z.array(z.string().min(1)).default(["image/svg+xml", "text/html", "application/xhtml+xml"]),
    maxBytes: z.number().int().positive().default(5 * 1024 * 1024),
    locales: z.array(z.string().min(1)).default([]),
    defaultLocale: z.string().min(1).optional(),
    prefix: z.string().regex(/^([A-Za-z0-9._-]+\/)+$/, 'prefix must be one or more "<segment>/" parts, e.g. "media/"').default("media/"),
    publicPath: z.string().regex(/^(\/[A-Za-z0-9._-]+)+$/, 'publicPath must be "/" followed by path segments, without a trailing "/", e.g. "/media"').default("/media"),
    publicCopy: z
      .object({
        prefix: z.string().regex(/^([A-Za-z0-9._-]+\/)*$/, 'publicCopy.prefix must be "" or one or more "<segment>/" parts, e.g. "site/"'),
      })
      .strict()
      .optional(),
    uploadStaleAfterMs: z.number().int().min(60000).default(900000),
    anonymousList: z.enum(["ids", "all"]).default("ids"),
    maxLimit: z.number().int().min(1).default(200),
    defaultLimit: z.number().int().min(1).optional(),
    listPermission: z.string().min(1).default("media.list").describe("The permission a signed-in caller needs to list the library or its folders when an authz module is loaded"),
    trashRetentionDays: z.number().int().min(1).default(30).describe("How many days a trashed item is kept before media.selectExpiredTrash selects it for media.purge"),
  })
  .strict()
  .refine((config) => config.defaultLimit === undefined || config.defaultLimit <= config.maxLimit, { message: "defaultLimit must not exceed maxLimit", path: ["defaultLimit"] });

function localeOf(ctx: Context): string | undefined {
  return ctx.params.locale ?? first(ctx.payload.locale);
}

function isSortField(value: string): value is SortField {
  return (SORTABLE as readonly string[]).includes(value);
}

function isMediaKind(value: string): value is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(value);
}

function idsFrom(value: unknown): string[] {
  const raw: string[] = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : [];
  return [...new Set(raw.flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean))];
}

function listOptions(payload: Record<string, unknown>, fallback: number): ListOptions & { locale?: string } {
  const options: ListOptions & { locale?: string } = { limit: fallback };
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
    if (isSortField(field)) {
      options.sortBy = field;
      options.direction = desc ? "desc" : "asc";
    }
  }
  const limit = Number(first(payload.limit));
  const offset = Number(first(payload.offset));
  if (Number.isInteger(limit) && limit > 0) options.limit = limit;
  if (Number.isInteger(offset) && offset >= 0) options.offset = offset;
  const type = first(payload.type);
  if (type !== undefined && isMediaKind(type)) options.mediaKind = type;
  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_REQUEST_IDS = 200;
const IDS_REFUSAL = `ids must name 1 to ${MAX_REQUEST_IDS} media items`;

function requestedIds(ctx: Context): string[] | null {
  const ids = idsFrom(ctx.payload.ids);
  return ids.length === 0 || ids.length > MAX_REQUEST_IDS ? null : ids;
}

function earlierSelection(ctx: Context): TrashOutcome | null {
  if (!isRecord(ctx.result) || !Array.isArray(ctx.result.ids)) return null;
  const ids = ctx.result.ids.filter((id): id is string => typeof id === "string");
  const skipped = Array.isArray(ctx.result.skipped) ? ctx.result.skipped.filter((entry): entry is TrashOutcome["skipped"][number] => isRecord(entry) && typeof entry.id === "string" && typeof entry.reason === "string") : [];
  return { ids, skipped };
}

function trashListOptions(payload: Record<string, unknown>, fallback: number): TrashListOptions {
  const options: TrashListOptions = { limit: fallback };
  const limit = Number(first(payload.limit));
  const offset = Number(first(payload.offset));
  if (Number.isInteger(limit) && limit > 0) options.limit = limit;
  if (Number.isInteger(offset) && offset >= 0) options.offset = offset;
  const q = first(payload.q);
  if (q !== undefined) options.q = q;
  const locale = first(payload.locale);
  if (locale !== undefined) options.locale = locale;
  return options;
}

type Instance = Media & { listAccess?: (identity: Identity) => Promise<Result<boolean, AuthzError>> };

async function listRefusal(media: Instance, ctx: Context): Promise<StepResult | undefined> {
  if (media.anonymousListAllowed()) return undefined;
  if (!ctx.identity) return ctx.fail("UNAUTHENTICATED", ANONYMOUS_LIST_MESSAGE);
  if (media.listAccess === undefined) return undefined;
  const allowed = await media.listAccess(ctx.identity);
  if (isErr(allowed)) return ctx.fail(allowed.error);
  return allowed.value ? undefined : ctx.fail("FORBIDDEN", "media/default: listing the library needs its list permission");
}

const ANONYMOUS_LIST_MESSAGE = "media/default: anonymous callers read media by id only – sign in to list the library";

const PROVENANCE = { type: "object", properties: { origin: { type: "string", enum: ["human", "ai", "mixed", "unknown"] }, tool: { type: "string" }, model: { type: "string" }, at: { type: "number" } }, required: ["origin"], description: "who made the file; anything but human is flagged on download (X-Content-Provenance); an upload without provenance is recorded as unknown" };
const MEDIA_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    path: { type: "string", description: "the file's one public URL, <publicPath>/<id>/<name>; the name is fixed at upload, so renaming or moving the item never changes it" },
    filename: { type: "string" },
    folder: { type: "string" },
    contentType: { type: "string" },
    size: { type: "number" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    provenance: PROVENANCE,
    width: { type: ["number", "null"] },
    height: { type: ["number", "null"] },
    alt: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
  },
  required: ["id", "path", "filename", "folder", "contentType", "size", "createdAt", "updatedAt", "provenance", "width", "height", "alt", "title", "description"],
  additionalProperties: false,
};
const RECONCILE_SCHEMA = { type: "object", properties: { blobsWithoutRow: { type: "array", items: { type: "string" } }, rowsWithoutBlob: { type: "array", items: { type: "string" } } }, required: ["blobsWithoutRow", "rowsWithoutBlob"] };
const PUBLIC_SYNC_SCHEMA = { type: "object", properties: { written: { type: "number" }, removed: { type: "number" }, missing: { type: "number" } }, required: ["written", "removed", "missing"] };
const UPLOAD_RESULT_SCHEMA = {
  oneOf: [
    MEDIA_ITEM_SCHEMA,
    { type: "object", properties: { items: { type: "array", items: MEDIA_ITEM_SCHEMA }, errors: { type: "array", items: { type: "object", properties: { filename: { type: "string" }, status: { type: "number" }, code: { type: "string" }, message: { type: "string" } }, required: ["filename", "status", "code", "message"] } }, ids: { type: "array", items: { type: "string" }, description: "the newly stored items only; an unchanged re-upload is in `items` but not here, and is not announced as an event" } }, required: ["items", "errors", "ids"] },
  ],
};
const IDS_INPUT = { type: "object", properties: { ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_REQUEST_IDS } }, required: ["ids"], additionalProperties: false };
const SKIPPED_SCHEMA = { type: "array", items: { type: "object", properties: { id: { type: "string" }, reason: { type: "string", description: "not_found, already_trashed or not_trashed from media-default; an earlier step of a purge may add its own, such as referenced" } }, required: ["id", "reason"] } };
const TRASH_RESULT_SCHEMA = { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "the ids the step acted on or selected" }, skipped: SKIPPED_SCHEMA }, required: ["ids", "skipped"] };
const RESTORE_RESULT_SCHEMA = { type: "object", properties: { ...TRASH_RESULT_SCHEMA.properties, renamed: { type: "array", description: "restored items whose display name was taken and that came back as <stem>-<n>.<ext>; key and path are unchanged", items: { type: "object", properties: { id: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["id", "from", "to"] } } }, required: ["ids", "skipped", "renamed"] };
const TRASH_ITEM_SCHEMA = {
  ...MEDIA_ITEM_SCHEMA,
  properties: {
    ...MEDIA_ITEM_SCHEMA.properties,
    path: { type: "null", description: "a trashed item has no public URL until it is restored" },
    folder: { type: "string", description: "the folder the item is restored to" },
    trashedAt: { type: "number" },
    expiresAt: { type: "number", description: "trashedAt plus trashRetentionDays; from then on media.selectExpiredTrash selects the item" },
  },
  required: [...MEDIA_ITEM_SCHEMA.required, "trashedAt", "expiresAt"],
};
const FOLDER_ITEMS_SUMMARY = "Item ids in a folder, for use with references.guardAll:media before removeFolder";

function listFolderItemsStep(media: Media): (ctx: Context) => Promise<StepResult> {
  return async (ctx) => {
    if (!ctx.params.path) return ctx.fail("VALIDATION", "missing path");
    const found = await media.folderItems(ctx.params.path, ctx.payload.recursive === true || first(ctx.payload.recursive) === "true");
    if (isErr(found)) return ctx.fail(found.error);
    if (found.value === null) return ctx.fail("NOT_FOUND", `media folder ${ctx.params.path} not found`);
    return ok({ ...ctx, result: found.value });
  };
}

export default defineModule({
  name: "media/default",
  provides: [MEDIA],
  requires: [BLOBSTORE, PERSISTENCE],
  optional: [AUTHZ],
  configSchema,

  async setup(config, deps): Promise<Instance> {
    if (config.defaultLocale !== undefined && !config.locales.includes(config.defaultLocale)) throw new Error("media/default: defaultLocale must be one of locales");
    const media = await createMediaDefault(config, deps.get(BLOBSTORE), deps.get(PERSISTENCE), deps.logger);
    const authz = deps.find(AUTHZ);
    if (authz === undefined) return media;
    const listAccess = (identity: Identity) => authz.can(identity, config.listPermission);
    return Object.assign(media, { listAccess });
  },

  attach: (media, kestrel) => media.attach(kestrel),

  steps: (media) => ({
    upload: async (ctx: Context): Promise<StepResult> => {
      if (ctx.files.length === 0) return ctx.fail("VALIDATION", "no file uploaded (multipart field expected)");
      const folder = first(ctx.payload.folder) ?? "";
      if (ctx.files.length === 1) {
        const [file] = ctx.files;
        if (!file) throw new Error("media/default: upload: expected exactly one file");
        const uploaded = await media.upload(file, folder, ctx.payload.provenance, media.sanitizesSvg(ctx.runId));
        if (isErr(uploaded)) return ctx.fail(uploaded.error);
        const item = media.toPublicItem(uploaded.value.item);
        return uploaded.value.created ? ok({ ...ctx, result: item }) : ctx.done(item);
      }
      const items: MediaItem[] = [];
      const ids: string[] = [];
      const errors: Array<{ filename: string; status: number; code: string; message: string }> = [];
      for (const file of ctx.files) {
        const uploaded = await media.upload(file, folder, ctx.payload.provenance, media.sanitizesSvg(ctx.runId));
        if (!isErr(uploaded)) {
          items.push(uploaded.value.item);
          if (uploaded.value.created) ids.push(uploaded.value.item.id);
          continue;
        }
        if (uploaded.error.code === "TRANSIENT") return ctx.fail(uploaded.error);
        errors.push({ filename: file.filename, status: uploaded.error.status, code: uploaded.error.code, message: uploaded.error.message });
      }
      const result = { items: items.map((item) => media.toPublicItem(item)), errors, ids };
      return ids.length === 0 ? ctx.done(result) : ok({ ...ctx, result });
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
      return ok({ ...ctx, result: media.toPublicItem(item.value) });
    },
    get: async (ctx: Context): Promise<StepResult> => {
      const notFound = () => ctx.fail("NOT_FOUND", `media/${ctx.params.id ?? ""} not found`);
      if (!ctx.params.id) return notFound();
      const item = await media.get(ctx.params.id, localeOf(ctx));
      if (isErr(item)) return ctx.fail(item.error);
      if (item.value === null) return notFound();
      return ok({ ...ctx, result: media.toPublicItem(item.value) });
    },
    list: async (ctx: Context): Promise<StepResult> => {
      const ids = idsFrom(ctx.payload.ids);
      if (ids.length === 0) {
        const refused = await listRefusal(media, ctx);
        if (refused !== undefined) return refused;
      }
      if (ids.length > 0) {
        const items = await media.byIds(ids.slice(0, media.listLimits().max), localeOf(ctx));
        if (isErr(items)) return ctx.fail(items.error);
        return ok({ ...ctx, result: { items: items.value.map((i) => media.toPublicItem(i)), total: items.value.length } });
      }
      const page = await media.list(listOptions(ctx.payload, media.listLimits().fallback));
      if (isErr(page)) return ctx.fail(page.error);
      return ok({ ...ctx, result: { items: page.value.items.map((i) => media.toPublicItem(i)), total: page.value.total } });
    },
    listFolders: async (ctx: Context): Promise<StepResult> => {
      const refused = await listRefusal(media, ctx);
      if (refused !== undefined) return refused;
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
    listFolderItems: listFolderItemsStep(media),
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
      const result = binaryResult(data, publishedFileOf(item).contentType, item.filename);
      if (item.provenance.origin !== "human") result.headers = { "x-content-provenance": item.provenance.origin };
      return ok({ ...ctx, result });
    },
    serve: async (ctx: Context): Promise<StepResult> => {
      const id = ctx.params.id;
      const name = ctx.params.name;
      const notFound = () => ctx.fail("NOT_FOUND", `media/${id ?? ""} not found, not ready, or not the name the file was uploaded under`);
      if (!id || !name) return notFound();
      const found = await media.serveFile(id, name);
      if (isErr(found)) return ctx.fail(found.error);
      if (found.value === null) return notFound();
      const { item, data } = found.value;
      const result = binaryResult(data, publishedFileOf(item).contentType, name);
      const headers: Record<string, string> = { "cache-control": media.publicCopyEnabled() ? "public, max-age=31536000, immutable" : "private, max-age=31536000, immutable" };
      if (item.provenance.origin !== "human") headers["x-content-provenance"] = item.provenance.origin;
      result.headers = headers;
      return ok({ ...ctx, result });
    },
    remove: async (ctx: Context): Promise<StepResult> => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const removed = await media.remove(ctx.params.id);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok({ ...ctx, result: { ok: true } });
    },
    trash: async (ctx: Context): Promise<StepResult> => {
      const ids = requestedIds(ctx);
      if (ids === null) return ctx.fail("VALIDATION", IDS_REFUSAL);
      const trashed = await media.trash(ids);
      if (isErr(trashed)) return ctx.fail(trashed.error);
      return ok({ ...ctx, result: trashed.value });
    },
    trashFolder: async (ctx: Context): Promise<StepResult> => {
      if (!ctx.params.path) return ctx.fail("VALIDATION", "missing path");
      const trashed = await media.trashFolder(ctx.params.path);
      if (isErr(trashed)) return ctx.fail(trashed.error);
      if (trashed.value === null) return ctx.fail("NOT_FOUND", `media folder ${ctx.params.path} not found`);
      return ok({ ...ctx, result: trashed.value });
    },
    restore: async (ctx: Context): Promise<StepResult> => {
      const ids = requestedIds(ctx);
      if (ids === null) return ctx.fail("VALIDATION", IDS_REFUSAL);
      const restored = await media.restore(ids);
      if (isErr(restored)) return ctx.fail(restored.error);
      return ok({ ...ctx, result: restored.value });
    },
    listTrash: async (ctx: Context): Promise<StepResult> => {
      const page = await media.listTrash(trashListOptions(ctx.payload, media.listLimits().fallback));
      if (isErr(page)) return ctx.fail(page.error);
      const items = page.value.items.map((item) => ({ ...media.toPublicItem(item), path: null, trashedAt: item.trashedAt, expiresAt: item.expiresAt }));
      return ok({ ...ctx, result: { items, total: page.value.total } });
    },
    selectTrash: async (ctx: Context): Promise<StepResult> => {
      const ids = requestedIds(ctx);
      if (ids === null) return ctx.fail("VALIDATION", IDS_REFUSAL);
      const selected = await media.selectTrash(ids);
      if (isErr(selected)) return ctx.fail(selected.error);
      return ok({ ...ctx, result: selected.value });
    },
    selectAllTrash: async (ctx: Context): Promise<StepResult> => {
      const ids = await media.trashIds();
      if (isErr(ids)) return ctx.fail(ids.error);
      return ok({ ...ctx, result: { ids: ids.value, skipped: [] } });
    },
    selectExpiredTrash: async (ctx: Context): Promise<StepResult> => {
      const ids = await media.trashIds({ expired: true });
      if (isErr(ids)) return ctx.fail(ids.error);
      return ok({ ...ctx, result: { ids: ids.value, skipped: [] } });
    },
    purge: async (ctx: Context): Promise<StepResult> => {
      const earlier = earlierSelection(ctx);
      const ids = earlier?.ids ?? requestedIds(ctx);
      if (ids === null) return ctx.fail("VALIDATION", IDS_REFUSAL);
      const purged = await media.purge(ids);
      if (isErr(purged)) return ctx.fail(purged.error);
      return ok({ ...ctx, result: { ids: purged.value.ids, skipped: [...(earlier?.skipped ?? []), ...purged.value.skipped] } });
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
    syncPublic: async (ctx: Context): Promise<StepResult> => {
      const synced = await media.syncPublic();
      if (isErr(synced)) return ctx.fail(synced.error);
      const previous = isRecord(ctx.result) ? ctx.result : {};
      return ok({ ...ctx, result: { ...previous, _publicMedia: synced.value } });
    },
    export: stepFactory((dir: string) => async (ctx: Context): Promise<StepResult> => {
      const exported = await media.exportTo(dir);
      if (isErr(exported)) return ctx.fail(exported.error);
      return ok({ ...ctx, result: exported.value });
    }),
  }),

  describe: (media) => ({
    upload: {
      summary: "Upload one or more files (multipart field `file`, repeatable). A single file returns the item; multiple files return per-file results. Idempotent: same folder, same filename and same bytes return the item that is already there, and the step then ends the pipeline itself (200), so no following step – notably events.emit:media.uploaded – runs for an upload that stored nothing",
      reads: ["files"],
      writes: ["result"],
      multipart: true,
      input: { type: "object", properties: { folder: { type: "string" }, provenance: { type: "string", description: "origin (human|ai|mixed|unknown) or JSON of the provenance object, applied to every file; omitted means unknown" } }, additionalProperties: false },
      output: UPLOAD_RESULT_SCHEMA,
      terminalOutput: UPLOAD_RESULT_SCHEMA,
      errors: { 400: "no file or invalid folder/provenance (per-file for a multi-file request)", 409: "the folder already has a file with that name, `details.field: \"location\"` (per-file for a multi-file request); the same bytes again are idempotent, not a conflict", 413: "file exceeds maxBytes (per-file for a multi-file request)", 415: "type not allowed (per-file for a multi-file request)" },
    },
    get: { summary: "Media metadata", reads: ["params.id"], writes: ["result"], query: { locale: { type: "string" } }, output: MEDIA_ITEM_SCHEMA, errors: { 400: "unknown locale", 404: "not found" } },
    list: { summary: "List media, newest first; anonymous callers may only fetch by ids", reads: ["identity?"], writes: ["result"], query: { folder: { type: "string" }, recursive: { type: "boolean" }, q: { type: "string" }, sort: { type: "string" }, type: { type: "string", enum: [...MEDIA_KINDS] }, limit: { type: "integer", minimum: 1, maximum: media.listLimits().max }, offset: { type: "integer", minimum: 0 }, ids: { type: "string" }, locale: { type: "string" } }, output: { type: "object", properties: { items: { type: "array", items: MEDIA_ITEM_SCHEMA }, total: { type: "number" } }, required: ["items", "total"] }, errors: { 400: "invalid folder, unknown locale, invalid type, or limit above maxLimit", 401: "no identity and no ids (unless anonymousList is \"all\")", 403: "no ids and, with an authz module, no listPermission" } },
    download: { summary: "The file itself", reads: ["params.id"], writes: ["result"], binary: true, errors: { 404: "not found" } },
    serve: media.publicCopyEnabled()
      ? {
          summary: "The file at its public URL (params.id, params.name); the name must be the one it was uploaded under",
          reads: ["params.id", "params.name"],
          writes: ["result"],
          binary: true,
          errors: { 404: "not found, not ready, or not the name the file was uploaded under" },
          anonymous: "required" as const,
        }
      : {
          summary: "The file at its public URL (params.id, params.name); the name must be the one it was uploaded under",
          reads: ["params.id", "params.name"],
          writes: ["result"],
          binary: true,
          errors: { 404: "not found, not ready, or not the name the file was uploaded under" },
        },
    listFolders: { summary: "Folders (persistent and implied) with item counts; anonymous callers are refused", reads: ["identity?"], writes: ["result"], output: { type: "array", items: { type: "object", properties: { folder: { type: "string" }, count: { type: "number" } }, required: ["folder", "count"] } }, errors: { 401: "no identity (unless anonymousList is \"all\")", 403: "with an authz module, no listPermission" } },
    update: { summary: "Rename, move, set provenance or texts (alt/title/description per locale); the file's key and path never change", reads: ["params.id"], writes: ["result"], input: { type: "object", properties: { filename: { type: "string" }, folder: { type: "string" }, provenance: PROVENANCE, locale: { type: "string" }, alt: { type: ["string", "null"] }, title: { type: ["string", "null"] }, description: { type: ["string", "null"] } }, additionalProperties: false }, query: { locale: { type: "string" } }, output: MEDIA_ITEM_SCHEMA, errors: { 400: "invalid name, folder or text (texts are plain text, max 2000 chars)", 404: "not found", 409: "the folder already has a file with that name, `details.field: \"location\"`" } },
    remove: { summary: "Delete file and metadata: end the item's readiness, then remove copy, blob and row, then a final sweep", reads: ["params.id"], writes: ["result"], output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, errors: { 400: "missing id" } },
    reconcile: { summary: "Compare the blobs under the media prefix with the media_items rows; with `delete` also removes blobs that no row points at (rows are never deleted)", reads: [], writes: ["result"], input: { type: "object", properties: { delete: { type: "boolean" } }, additionalProperties: false }, output: RECONCILE_SCHEMA },
    reconcileDelete: { summary: "Like media.reconcile, but always deletes the orphan blobs – the deletion is in the pipeline, not in the request", reads: [], writes: ["result"], output: RECONCILE_SCHEMA },
    syncPublic: {
      summary: "Reconcile the public copies of every ready item's original with the stored items: fail abandoned uploads, finish interrupted deletes, write missing or mismatched copies, and remove copies of failed, trashed or deleted items and foreign files, re-reading an item before its copy goes (adds _publicMedia: { written, removed, missing } to the result)",
      reads: [],
      writes: ["result._publicMedia"],
      extendsOutput: { type: "object", properties: { _publicMedia: PUBLIC_SYNC_SCHEMA }, required: ["_publicMedia"] },
    },
    export: (dir: string) => ({ summary: `Copy every ready media item to ${dir}/<folder>/<filename>`, reads: [], writes: ["result"], output: { type: "object", properties: { written: { type: "number" }, skipped: { type: "number" }, missing: { type: "number" }, conflicts: { type: "number" } }, required: ["written", "skipped", "missing", "conflicts"] } }),
    createFolder: { summary: "Create a folder (idempotent: an existing folder is returned unchanged)", reads: [], writes: ["result"], input: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, output: { type: "object", properties: { folder: { type: "string" }, count: { type: "number" } }, required: ["folder", "count"] }, errors: { 400: "missing or invalid path" } },
    renameFolder: { summary: "Rename or move a folder (metadata only: keys and paths do not change)", reads: ["params.path"], writes: ["result"], input: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, output: { type: "object", properties: { folder: { type: "string" }, moved: { type: "number" } }, required: ["folder", "moved"] }, errors: { 400: "missing or invalid path", 404: "folder not found", 409: "target folder already exists" } },
    listFolderItems: { summary: FOLDER_ITEMS_SUMMARY, reads: ["params.path"], writes: ["result"], query: { recursive: { type: "boolean" } }, output: { type: "object", properties: { path: { type: "string" }, ids: { type: "array", items: { type: "string" } } }, required: ["path", "ids"] }, errors: { 400: "missing or invalid path", 404: "folder not found", 409: "folder not empty (without `recursive`)" } },
    trash: { summary: "Move the items in body.ids to the trash: the library no longer shows them, their names are free and their public copies are removed, while media@1 still reads them as ready until media.purge; per-id answer, an unknown or already trashed id is skipped", reads: [], writes: ["result"], input: IDS_INPUT, output: TRASH_RESULT_SCHEMA, errors: { 400: `no ids or more than ${MAX_REQUEST_IDS}` } },
    trashFolder: { summary: "Move every live item in a folder's subtree to the trash and drop the folder rows of that subtree; media.restore recreates the folders of the items it restores", reads: ["params.path"], writes: ["result"], output: { type: "object", properties: { path: { type: "string" }, ids: { type: "array", items: { type: "string" } } }, required: ["path", "ids"] }, errors: { 400: "missing or invalid path", 404: "folder not found" } },
    restore: { summary: "Bring the trashed items in body.ids back with the same id, key, path, folder and texts; a display name taken meanwhile becomes <stem>-<n>.<ext> (listed in renamed); per-id answer, an id that is not trashed gets its public copy ensured and is skipped", reads: [], writes: ["result"], input: IDS_INPUT, output: RESTORE_RESULT_SCHEMA, errors: { 400: `no ids or more than ${MAX_REQUEST_IDS}` } },
    listTrash: { summary: "The trashed items, most recently trashed first, with trashedAt and expiresAt and no public path", reads: [], writes: ["result"], query: { q: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: media.listLimits().max }, offset: { type: "integer", minimum: 0 }, locale: { type: "string" } }, output: { type: "object", properties: { items: { type: "array", items: TRASH_ITEM_SCHEMA }, total: { type: "number" } }, required: ["items", "total"] }, errors: { 400: "unknown locale or limit above maxLimit" } },
    selectTrash: { summary: "Select the trashed items among body.ids into result.ids for media.purge, reporting the others in result.skipped", reads: [], writes: ["result"], input: IDS_INPUT, output: TRASH_RESULT_SCHEMA, errors: { 400: `no ids or more than ${MAX_REQUEST_IDS}` } },
    selectAllTrash: { summary: "Select every trashed item into result.ids for media.purge", reads: [], writes: ["result"], output: TRASH_RESULT_SCHEMA },
    selectExpiredTrash: { summary: "Select the trashed items whose trashRetentionDays have run out into result.ids for media.purge", reads: [], writes: ["result"], output: TRASH_RESULT_SCHEMA },
    purge: { summary: `Delete trashed items for good, each as media.remove: the ids in result.ids when an earlier step selected them (its result.skipped is kept), otherwise body.ids (at most ${MAX_REQUEST_IDS}); an id that is not trashed is skipped`, reads: ["result.ids?", "result.skipped?"], writes: ["result"], input: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_REQUEST_IDS } }, additionalProperties: false }, output: TRASH_RESULT_SCHEMA, errors: { 400: `no ids selected and no body.ids, or more than ${MAX_REQUEST_IDS} body.ids` } },
    removeFolder: { summary: "Delete a folder and everything in it (each item as media.remove)", reads: ["params.path"], writes: ["result"], output: { type: "object", properties: { ok: { type: "boolean" }, removed: { type: "number" }, ids: { type: "array", items: { type: "string" } } }, required: ["ok", "removed", "ids"] }, errors: { 400: "invalid path", 404: "folder not found", 409: "folder not empty or still referenced" } },
  }),
});
