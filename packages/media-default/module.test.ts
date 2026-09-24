import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Manifest, RunObserver } from "@michaelthielemann/kestrel";
import { createContext, DONE, type Context } from "@michaelthielemann/kestrel/context";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger, type Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { validateSchema } from "@michaelthielemann/kestrel/schema";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import module, { configSchema } from "./module.ts";
import { createMediaDefault, type Config, type Media } from "./impl.ts";

const OBJECT_BINDING_PROOF_FILE = join(process.cwd(), "node_modules", ".cache", "kestrel-object-binding-proofs.ndjson");

function provesObjectBinding(moduleName: string, step: string): void {
  mkdirSync(dirname(OBJECT_BINDING_PROOF_FILE), { recursive: true });
  appendFileSync(OBJECT_BINDING_PROOF_FILE, `${moduleName}#${step}\n`);
}

function fakeBlobstore(): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    blobs,
    async put(key, data, options) { blobs.set(key, { data, contentType: options?.contentType ?? "application/octet-stream" }); return ok(); },
    async get(key) { return ok(blobs.get(key)?.data ?? null); },
    async remove(key) { blobs.delete(key); return ok(); },
    async move(from, to) { const b = blobs.get(from); if (!b) return err(failure("NOT_FOUND", `${from} not found`)); blobs.set(to, b); blobs.delete(from); return ok(); },
    async list(prefix) { return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.data.byteLength }))); },
  };
}

function fakeCtx(files: Context["files"] = [], payload: Record<string, unknown> = {}, params: Record<string, string> = {}, identity?: Context["identity"]): Context {
  const ctx = createContext({ trigger: { kind: "http", name: "t" }, payload, params, files });
  return identity === undefined ? ctx : { ...ctx, identity };
}

const noLogger: Logger = { step() {}, info() {}, error() {} };
const config = (overrides: Partial<Config> = {}): Config => ({ allowedTypes: ["image/*"], deniedTypes: [], maxBytes: 1024, locales: [], prefix: "media/", publicPath: "/media", uploadStaleAfterMs: 900000, anonymousList: "ids", ...overrides });

async function make(overrides: Partial<Config> = {}): Promise<{ media: Media; blobs: Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> }; db: FakePersistence; steps: ReturnType<NonNullable<typeof module.steps>> }> {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  const media = await createMediaDefault(config(overrides), blobs, db, noLogger);
  return { media, blobs, db, steps: module.steps!(media) };
}

const file = (filename: string, data: Uint8Array = new Uint8Array([1])): Context["files"][number] => ({ field: "file", filename, contentType: "image/png", data });

describe("media/default upload step", () => {
  it("returns the public projection with path, never key/checksum/status/location", async () => {
    const { steps } = await make();
    const ctx = expectOk(await steps.upload(fakeCtx([file("a.png")])));
    const item = boundaryCast<Record<string, unknown>>(ctx.result, "host");
    expect(item.path).toMatch(new RegExp(`^/media/[^/]+/a\\.png$`));
    for (const field of ["key", "checksum", "status", "location"]) expect(field in item).toBe(false);
  });

  it("maps a duplicate filename with other bytes to CONFLICT naming location", async () => {
    const { steps } = await make();
    expectOk(await steps.upload(fakeCtx([file("a.png")])));
    const error = expectErr(await steps.upload(fakeCtx([file("a.png", new Uint8Array([2]))])), "CONFLICT");
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/already exists/);
    expect(error.details).toMatchObject({ field: "location" });
  });

  it("an identical re-upload answers 200 with the stored item and ends the pipeline before events.emit", async () => {
    const { media, steps, db } = await make();
    const first = expectOk(await steps.upload(fakeCtx([file("a.png")])));
    const again = expectOk(await steps.upload(fakeCtx([file("a.png")])));
    expect(boundaryCast<{ id: string }>(again.result, "host").id).toBe(boundaryCast<{ id: string }>(first.result, "host").id);
    expect(Reflect.get(again, DONE)).toBe(true);
    expect(Reflect.get(first, DONE)).toBeUndefined();
    expect(expectOk(await db.count("media_items", {}))).toBe(1);
    expect(expectOk(await media.list()).total).toBe(1);
  });

  it("multiple files: ids carries only what was stored, and an all-idempotent batch ends the pipeline", async () => {
    const { steps } = await make();
    expectOk(await steps.upload(fakeCtx([file("a.png")])));
    const mixed = expectOk(await steps.upload(fakeCtx([file("a.png"), file("b.png")])));
    const result = boundaryCast<{ items: Array<{ id: string; filename: string }>; ids: string[] }>(mixed.result, "host");
    expect(result.items.map((i) => i.filename)).toEqual(["a.png", "b.png"]);
    expect(result.ids).toEqual([result.items[1]?.id]);
    expect(Reflect.get(mixed, DONE)).toBeUndefined();

    const repeat = expectOk(await steps.upload(fakeCtx([file("a.png"), file("b.png")])));
    expect(boundaryCast<{ ids: string[] }>(repeat.result, "host").ids).toEqual([]);
    expect(Reflect.get(repeat, DONE)).toBe(true);
  });

  it("no file uploaded is a VALIDATION failure", async () => {
    const { steps } = await make();
    expect(expectErr(await steps.upload(fakeCtx([])), "VALIDATION").status).toBe(400);
  });

  it("a disallowed type is UNSUPPORTED (415), an oversized file PAYLOAD_TOO_LARGE (413)", async () => {
    const { steps } = await make({ allowedTypes: ["image/*"], deniedTypes: ["image/svg+xml"], maxBytes: 2 });
    const svg = { field: "file", filename: "a.svg", contentType: "image/svg+xml", data: new Uint8Array([1]) };
    expect(expectErr(await steps.upload(fakeCtx([svg])), "UNSUPPORTED").status).toBe(415);
    expect(expectErr(await steps.upload(fakeCtx([file("b.png", new Uint8Array([1, 2, 3]))])), "PAYLOAD_TOO_LARGE").status).toBe(413);
  });

  it("multiple files: partial success returns items and errors with a code, 200", async () => {
    const { steps } = await make({ maxBytes: 2 });
    const ctx = expectOk(await steps.upload(fakeCtx([file("a.png"), file("b.png"), file("c.png", new Uint8Array([1, 2, 3]))])));
    const result = boundaryCast<{ items: Array<{ filename: string; id: string }>; errors: Array<{ filename: string; status: number; code: string; message: string }>; ids: string[] }>(ctx.result, "host");
    expect(result.items.map((i) => i.filename)).toEqual(["a.png", "b.png"]);
    expect(result.errors).toEqual([{ filename: "c.png", status: 413, code: "PAYLOAD_TOO_LARGE", message: expect.stringContaining("exceeds") as unknown }]);
    expect(result.ids).toEqual(result.items.map((i) => i.id));
  });

  it("multiple files: a transient failure fails the whole request instead of becoming an entry", async () => {
    const { steps, db } = await make();
    db.failNext("TRANSIENT");
    const error = expectErr(await steps.upload(fakeCtx([file("a.png"), file("b.png")])), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("media/default download and serve steps", () => {
  it("download flags an upload without provenance as unknown", async () => {
    const { media, steps } = await make();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    expect(item.provenance).toEqual({ origin: "unknown" });
    const ctx = expectOk(await steps.download(fakeCtx([], {}, { id: item.id })));
    expect(boundaryCast<{ headers?: Record<string, string> }>(ctx.result, "host").headers).toEqual({ "x-content-provenance": "unknown" });
  });

  it("download: an unknown id is NOT_FOUND", async () => {
    const { steps } = await make();
    expect(expectErr(await steps.download(fakeCtx([], {}, { id: "missing" })), "NOT_FOUND").status).toBe(404);
  });

  it("serve: 200 with the current name, 404 for another name or an unknown id", async () => {
    const { media, steps } = await make();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1, 2]) })).item;
    const ok1 = expectOk(await steps.serve(fakeCtx([], {}, { id: item.id, name: item.filename })));
    expect(Array.from(boundaryCast<{ data: Uint8Array }>(ok1.result, "host").data)).toEqual([1, 2]);
    expect(expectErr(await steps.serve(fakeCtx([], {}, { id: item.id, name: "other.png" })), "NOT_FOUND").status).toBe(404);
    expect(expectErr(await steps.serve(fakeCtx([], {}, { id: "missing", name: "a.png" })), "NOT_FOUND").status).toBe(404);
  });

  it("serve: answers with the same neutral type as the public copy for a type that is not a known inert one", async () => {
    const { media, steps } = await make({ allowedTypes: ["*"], publicCopy: { prefix: "site/" } });
    const item = expectOk(await media.upload({ filename: "x.html", contentType: "text/html", data: new TextEncoder().encode("<p>x</p>") })).item;
    const served = boundaryCast<{ contentType: string; filename: string }>(expectOk(await steps.serve(fakeCtx([], {}, { id: item.id, name: "x-html.bin" }))).result, "host");
    expect(served.contentType).toBe("application/octet-stream");
    expect(served.filename).toBe("x-html.bin");
    const downloaded = boundaryCast<{ contentType: string }>(expectOk(await steps.download(fakeCtx([], {}, { id: item.id }))).result, "host");
    expect(downloaded.contentType).toBe("text/html");
  });

  it("upload and serve: an SVG is stored as one only in a run whose pipeline runs sanitize.svg before media.upload", async () => {
    const { media, steps } = await make({ publicCopy: { prefix: "site/" } });
    const observers: RunObserver[] = [];
    const step = (module: string, name: string, writes: string[] = []) => ({ spec: name, name, module, description: { summary: "", reads: [], writes } });
    const manifest = boundaryCast<Manifest>({ pipelines: [
      { name: "serveMediaFile", steps: [step("media/default", "media.serve")] },
      { name: "uploadMedia", steps: [step("sanitize/svg", "sanitize.svg", ["files"]), step("media/default", "media.upload", ["result"])] },
    ] }, "host");
    media.attach({ describe: () => manifest, observe: (observer) => { observers.push(observer); return () => {}; }, health: () => ({ ok: true, restartRequired: false, modules: [] }) });
    const svg = (filename: string): Context["files"][number] => ({ field: "file", filename, contentType: "image/svg+xml", data: new TextEncoder().encode("<svg/>") });

    const sanitised = fakeCtx([svg("logo.svg")]);
    for (const observer of observers) observer.stepStart?.({ runId: sanitised.runId, pipeline: "uploadMedia", step: "media.upload", at: 1 });
    const stored = boundaryCast<{ id: string; path: string }>(expectOk(await steps.upload(sanitised)).result, "host");
    expect(stored.path).toBe(`/media/${stored.id}/logo.svg`);
    const served = boundaryCast<{ contentType: string }>(expectOk(await steps.serve(fakeCtx([], {}, { id: stored.id, name: "logo.svg" }))).result, "host");
    expect(served.contentType).toBe("image/svg+xml");

    const unsanitised = fakeCtx([svg("other.svg")]);
    const raw = boundaryCast<{ id: string; path: string }>(expectOk(await steps.upload(unsanitised)).result, "host");
    expect(raw.path).toBe(`/media/${raw.id}/other-svg.bin`);
    const rawServed = boundaryCast<{ contentType: string }>(expectOk(await steps.serve(fakeCtx([], {}, { id: raw.id, name: "other-svg.bin" }))).result, "host");
    expect(rawServed.contentType).toBe("application/octet-stream");
    expect(expectErr(await steps.serve(fakeCtx([], {}, { id: raw.id, name: "other.svg" })), "NOT_FOUND").status).toBe(404);

    const downloaded = async (id: string): Promise<string> => boundaryCast<{ contentType: string }>(expectOk(await steps.download(fakeCtx([], {}, { id }))).result, "host").contentType;
    expect(await downloaded(stored.id)).toBe("image/svg+xml");
    expect(await downloaded(raw.id)).toBe("application/octet-stream");
  });

  it("serve: immutable cache-control, private without publicCopy, public with it", async () => {
    const withoutCopy = await make();
    const itemA = expectOk(await withoutCopy.media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    const resA = expectOk(await withoutCopy.steps.serve(fakeCtx([], {}, { id: itemA.id, name: itemA.filename })));
    expect(boundaryCast<{ headers?: Record<string, string> }>(resA.result, "host").headers).toMatchObject({ "cache-control": "private, max-age=31536000, immutable" });

    const withCopy = await make({ publicCopy: { prefix: "site/" } });
    const itemB = expectOk(await withCopy.media.upload({ filename: "b.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    const resB = expectOk(await withCopy.steps.serve(fakeCtx([], {}, { id: itemB.id, name: itemB.filename })));
    expect(boundaryCast<{ headers?: Record<string, string> }>(resB.result, "host").headers).toMatchObject({ "cache-control": "public, max-age=31536000, immutable" });
  });
});

describe("media/default get and update steps", () => {
  it("an unknown id is NOT_FOUND for get and update", async () => {
    const { steps } = await make();
    expect(expectErr(await steps.get(fakeCtx([], {}, { id: "missing" })), "NOT_FOUND").status).toBe(404);
    expect(expectErr(await steps.update(fakeCtx([], { filename: "x.png" }, { id: "missing" })), "NOT_FOUND").status).toBe(404);
  });

  it("an unknown locale is VALIDATION", async () => {
    const { media, steps } = await make({ locales: ["de"], defaultLocale: "de" });
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    expect(expectErr(await steps.get(fakeCtx([], { locale: "fr" }, { id: item.id })), "VALIDATION").status).toBe(400);
  });

  it("a taken filename is CONFLICT", async () => {
    const { media, steps } = await make();
    expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }));
    const b = expectOk(await media.upload({ filename: "b.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    expect(expectErr(await steps.update(fakeCtx([], { filename: "a.png" }, { id: b.id })), "CONFLICT").status).toBe(409);
  });

  it("a missing id is VALIDATION on update and remove", async () => {
    const { steps } = await make();
    expect(expectErr(await steps.update(fakeCtx()), "VALIDATION").status).toBe(400);
    expect(expectErr(await steps.remove(fakeCtx()), "VALIDATION").status).toBe(400);
  });
});

describe("media/default folder steps", () => {
  it("reports a missing folder as NOT_FOUND and a non-empty one as CONFLICT", async () => {
    const { media, steps } = await make();
    expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }, "x/y"));
    expect(expectErr(await steps.renameFolder(fakeCtx([], { path: "z" }, { path: "nope" })), "NOT_FOUND").status).toBe(404);
    expect(expectErr(await steps.removeFolder(fakeCtx([], {}, { path: "nope" })), "NOT_FOUND").status).toBe(404);
    expect(expectErr(await steps.listFolderItems(fakeCtx([], {}, { path: "x" })), "CONFLICT").status).toBe(409);
    expect(expectOk(await steps.listFolderItems(fakeCtx([], { recursive: true }, { path: "x" }))).result).toMatchObject({ path: "x" });
  });

  it("removeFolder returns the removed ids", async () => {
    const { media, steps } = await make();
    const a = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }, "x")).item;
    const res = expectOk(await steps.removeFolder(fakeCtx([], {}, { path: "x" })));
    expect(boundaryCast<{ ids: string[] }>(res.result, "host").ids).toEqual([a.id]);
  });
});

describe("media/default list and listFolders: anonymous reads by id only", () => {
  it("list without an identity and without ids answers 401", async () => {
    const { steps } = await make();
    const error = expectErr(await steps.list(fakeCtx()), "UNAUTHENTICATED");
    expect(error.status).toBe(401);
  });

  it("list without an identity but with ids answers 200", async () => {
    const { media, steps } = await make();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    const res = expectOk(await steps.list(fakeCtx([], { ids: item.id })));
    expect(boundaryCast<{ total: number }>(res.result, "host").total).toBe(1);
  });

  it("list with an identity answers 200 even without ids", async () => {
    const { steps } = await make();
    const res = expectOk(await steps.list(fakeCtx([], {}, {}, { id: "u", claims: {} })));
    expect(boundaryCast<{ total: number }>(res.result, "host").total).toBe(0);
  });

  it("anonymousList: \"all\" restores anonymous listing", async () => {
    const { steps } = await make({ anonymousList: "all" });
    const res = expectOk(await steps.list(fakeCtx()));
    expect(boundaryCast<{ total: number }>(res.result, "host").total).toBe(0);
  });

  it("listFolders without an identity answers 401, with one 200", async () => {
    const { steps } = await make();
    expect(expectErr(await steps.listFolders(fakeCtx()), "UNAUTHENTICATED").status).toBe(401);
    const res = expectOk(await steps.listFolders(fakeCtx([], {}, {}, { id: "u", claims: {} })));
    expect(Array.isArray(res.result)).toBe(true);
  });

  it("answers TRANSIENT (503, retryable) when persistence is down for a signed-in list", async () => {
    const { steps, db } = await make();
    db.failNext("TRANSIENT");
    const error = expectErr(await steps.list(fakeCtx([], {}, {}, { id: "u", claims: {} })), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("media/default reconcile and syncPublic steps", () => {
  it("reconcile reports orphans and deletes them only when payload.delete is set", async () => {
    const { blobs, steps } = await make();
    expectOk(await blobs.put("media/stray.png", new Uint8Array([1]), { contentType: "image/png" }));

    const reported = expectOk(await steps.reconcile(fakeCtx()));
    expect(reported.result).toEqual({ blobsWithoutRow: ["media/stray.png"], rowsWithoutBlob: [] });
    expect(expectOk(await blobs.get("media/stray.png"))).not.toBeNull();

    expectOk(await steps.reconcile(fakeCtx([], { delete: true })));
    expect(expectOk(await blobs.get("media/stray.png"))).toBeNull();
  });

  it("reconcileDelete deletes without a payload flag", async () => {
    const { blobs, steps } = await make();
    expectOk(await blobs.put("media/stray.png", new Uint8Array([1]), { contentType: "image/png" }));

    const ctx = expectOk(await steps.reconcileDelete(fakeCtx()));
    expect(ctx.result).toEqual({ blobsWithoutRow: ["media/stray.png"], rowsWithoutBlob: [] });
    expect(expectOk(await blobs.get("media/stray.png"))).toBeNull();
  });

  it("syncPublic merges _publicMedia into the result", async () => {
    const { media, steps } = await make({ publicCopy: { prefix: "site/" } });
    await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) });
    const ctx = expectOk(await steps.syncPublic(fakeCtx()));
    expect(boundaryCast<{ _publicMedia: { written: number } }>(ctx.result, "host")._publicMedia.written).toBe(0);
  });
});

describe("media/default configSchema", () => {
  it("rejects an invalid prefix, publicPath, publicCopy.prefix, uploadStaleAfterMs and anonymousList", () => {
    expect(configSchema.safeParse({ prefix: "" }).success).toBe(false);
    expect(configSchema.safeParse({ prefix: "media" }).success).toBe(false);
    expect(configSchema.safeParse({ prefix: "/media/" }).success).toBe(false);
    expect(configSchema.safeParse({ publicPath: "/" }).success).toBe(false);
    expect(configSchema.safeParse({ publicPath: "/media/" }).success).toBe(false);
    expect(configSchema.safeParse({ publicPath: "media" }).success).toBe(false);
    expect(configSchema.safeParse({ publicPath: "/me dia" }).success).toBe(false);
    expect(configSchema.safeParse({ publicCopy: { prefix: "site" } }).success).toBe(false);
    expect(configSchema.safeParse({ uploadStaleAfterMs: 1000 }).success).toBe(false);
    expect(configSchema.safeParse({ anonymousList: "yes" }).success).toBe(false);
  });

  it("accepts valid values and the defaults", () => {
    expect(configSchema.safeParse({ prefix: "media/" }).success).toBe(true);
    expect(configSchema.safeParse({ prefix: "assets/media/" }).success).toBe(true);
    expect(configSchema.safeParse({ publicPath: "/media" }).success).toBe(true);
    expect(configSchema.safeParse({ publicCopy: { prefix: "site/" } }).success).toBe(true);
    expect(configSchema.safeParse({ publicCopy: { prefix: "" } }).success).toBe(true);
    const defaults = configSchema.parse({});
    expect(defaults).toMatchObject({ publicPath: "/media", uploadStaleAfterMs: 900000, anonymousList: "ids" });
    expect(defaults.publicCopy).toBeUndefined();
  });
});

async function makeInstance(overrides: Partial<Config> = {}): Promise<{ media: Media; blobs: Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> }; db: FakePersistence }> {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  const parsed = configSchema.parse(config(overrides));
  const media = boundaryCast<Media>(
    await module.setup(parsed, {
      get<T>(contract: { name: string }): T {
        if (contract === BLOBSTORE) return boundaryCast<T>(blobs, "host");
        if (contract === PERSISTENCE) return boundaryCast<T>(db, "host");
        throw new Error(`unexpected contract ${contract.name}`);
      },
      find: () => undefined,
      logger: silentLogger,
      root: process.cwd(),
      eventTriggers: [],
    }),
    "host",
  );
  return { media, blobs, db };
}

function pipeline(...steps: string[]) {
  return definePipeline({ name: "test", steps });
}

const setsIdentity = { "identity.set": async (ctx: Context) => ok({ ...ctx, identity: { id: "u", claims: {} } }) };
const identityWrite = { "identity.set": ["identity?"] };

describe("media/default steps via runPipeline", () => {
  it("upload: validates the body and stores the file", async () => {
    const { media } = await makeInstance();
    const invalid = await runPipeline(pipeline("media.upload"), { files: [file("a.png")], body: { nope: 1 } }, { modules: [{ module, instance: media }] });
    expect(invalid.status).toBe(400);
    expect(invalid.code).toBe("VALIDATION");
    expect(invalid.details?.problems).toEqual([{ path: "$.nope", message: "is not allowed by additionalProperties: false" }]);

    const ok1 = await runPipeline(pipeline("media.upload"), { files: [file("a.png")], body: { folder: "photos" } }, { modules: [{ module, instance: media }] });
    expect(ok1.status).toBe(200);
    expect(boundaryCast<{ folder: string }>(ok1.result, "host").folder).toBe("photos");
  });

  it("upload: the same name with other bytes is a 409 naming the location field", async () => {
    const { media } = await makeInstance();
    expect((await runPipeline(pipeline("media.upload"), { files: [file("a.png")] }, { modules: [{ module, instance: media }] })).status).toBe(200);
    const res = await runPipeline(pipeline("media.upload"), { files: [file("a.png", new Uint8Array([2]))] }, { modules: [{ module, instance: media }] });
    expect(res).toMatchObject({ status: 409, code: "CONFLICT", step: "media.upload", details: { collection: "media_items", field: "location" } });
    expect(res.error).toMatch(/a\.png already exists/);
  });

  it("upload's terminalOutput requires ids on the list-result branch", () => {
    const description = module.describe!({ publicCopyEnabled: () => false }).upload;
    const schema = description.terminalOutput;
    expect(schema).toBeDefined();
    expect(validateSchema(schema ?? {}, { items: [], errors: [] })).not.toEqual([]);
    expect(validateSchema(schema ?? {}, { items: [], errors: [], ids: [] })).toEqual([]);
  });

  it("get: query.locale is validated and coerced", async () => {
    const { media } = await makeInstance();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    const res = await runPipeline(pipeline("media.get"), { params: { id: item.id }, query: { locale: "de" } }, { modules: [{ module, instance: media }] });
    expect(res.status).toBe(200);
    expect(boundaryCast<{ id: string }>(res.result, "host").id).toBe(item.id);
  });

  it("list: with an identity, query.limit/offset are coerced from strings, folder/q/sort/ids/recursive/locale are declared", async () => {
    const { media } = await makeInstance();
    await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }, "photos");
    const res = await runPipeline(pipeline("identity.set", "media.list"), { query: { folder: "photos", limit: "10", offset: "0" } }, { modules: [{ module, instance: media }], steps: setsIdentity, writes: identityWrite });
    expect(res.status).toBe(200);
    expect(boundaryCast<{ total: number }>(res.result, "host").total).toBe(1);
  });

  it("download: serves the binary result", async () => {
    const { media } = await makeInstance();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1, 2]) })).item;
    const res = await runPipeline(pipeline("media.download"), { params: { id: item.id } }, { modules: [{ module, instance: media }] });
    expect(res.status).toBe(200);
    expect(res.result).toMatchObject({ binary: true });
  });

  it("serve: serves the binary result at the public URL's name", async () => {
    const { media } = await makeInstance();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1, 2]) })).item;
    const res = await runPipeline(pipeline("media.serve"), { params: { id: item.id, name: item.filename } }, { modules: [{ module, instance: media }] });
    expect(res.status).toBe(200);
    expect(res.result).toMatchObject({ binary: true });
  });

  it("serve: does not return another media item's file for a different name", async () => {
    const { media } = await makeInstance();
    const a = expectOk(await media.upload({ filename: "one.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    const b = expectOk(await media.upload({ filename: "two.png", contentType: "image/png", data: new Uint8Array([2]) })).item;
    const own = await runPipeline(pipeline("media.serve"), { params: { id: a.id, name: a.filename } }, { modules: [{ module, instance: media }] });
    expect(own.result).toMatchObject({ binary: true });
    const crossed = await runPipeline(pipeline("media.serve"), { params: { id: a.id, name: b.filename } }, { modules: [{ module, instance: media }] });
    expect(crossed.status).toBe(404);
    provesObjectBinding("media/default", "serve");
  });

  it("listFolders: with an identity, returns folders", async () => {
    const { media } = await makeInstance();
    const res = await runPipeline(pipeline("identity.set", "media.listFolders"), {}, { modules: [{ module, instance: media }], steps: setsIdentity, writes: identityWrite });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.result)).toBe(true);
  });

  it("update: replaces fields, keeping the key and path", async () => {
    const { media } = await makeInstance();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    const res = await runPipeline(pipeline("media.update"), { params: { id: item.id }, body: { filename: "b.png" } }, { modules: [{ module, instance: media }] });
    expect(res.status).toBe(200);
    const updated = boundaryCast<{ filename: string; path: string }>(res.result, "host");
    expect(updated.filename).toBe("b.png");
    expect(updated.path).toBe(`/media/${item.id}/${item.filename}`);
  });

  it("remove: deletes the item", async () => {
    const { media } = await makeInstance();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    const res = await runPipeline(pipeline("media.remove"), { params: { id: item.id } }, { modules: [{ module, instance: media }] });
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ ok: true });
  });

  it("reconcile: reports and, with body.delete, removes orphan blobs", async () => {
    const { media, blobs } = await makeInstance();
    expectOk(await blobs.put("media/stray.png", new Uint8Array([1]), { contentType: "image/png" }));
    const reported = await runPipeline(pipeline("media.reconcile"), {}, { modules: [{ module, instance: media }] });
    expect(reported.result).toEqual({ blobsWithoutRow: ["media/stray.png"], rowsWithoutBlob: [] });
    const deleted = await runPipeline(pipeline("media.reconcile"), { body: { delete: true } }, { modules: [{ module, instance: media }] });
    expect(deleted.status).toBe(200);
    expect(expectOk(await blobs.get("media/stray.png"))).toBeNull();
  });

  it("export: copies every media item to the target directory", async () => {
    const { media } = await makeInstance();
    await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) });
    const dir = await mkdtemp(join(tmpdir(), "media-module-export-"));
    try {
      const res = await runPipeline(pipeline(`media.export:${dir}`), {}, { modules: [{ module, instance: media }] });
      expect(res.status).toBe(200);
      expect(boundaryCast<{ written: number }>(res.result, "host").written).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("createFolder: creates a folder from body.path", async () => {
    const { media } = await makeInstance();
    const res = await runPipeline(pipeline("media.createFolder"), { body: { path: "x/y" } }, { modules: [{ module, instance: media }] });
    expect(res.status).toBe(200);
    expect(boundaryCast<{ folder: string }>(res.result, "host").folder).toBe("x/y");
  });

  it("renameFolder: moves a folder", async () => {
    const { media } = await makeInstance();
    expectOk(await media.createFolder("x"));
    const res = await runPipeline(pipeline("media.renameFolder"), { params: { path: "x" }, body: { path: "y" } }, { modules: [{ module, instance: media }] });
    expect(res.status).toBe(200);
    expect(boundaryCast<{ folder: string }>(res.result, "host").folder).toBe("y");
  });

  it("listFolderItems: query.recursive is coerced from a string", async () => {
    const { media } = await makeInstance();
    await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }, "x/y");
    const res = await runPipeline(pipeline("media.listFolderItems"), { params: { path: "x" }, query: { recursive: "true" } }, { modules: [{ module, instance: media }] });
    expect(res.status).toBe(200);
    expect(boundaryCast<{ ids: string[] }>(res.result, "host").ids).toHaveLength(1);
  });

  it("removeFolder: deletes a folder and its contents", async () => {
    const { media } = await makeInstance();
    expectOk(await media.createFolder("x"));
    const res = await runPipeline(pipeline("media.removeFolder"), { params: { path: "x" } }, { modules: [{ module, instance: media }] });
    expect(res.status).toBe(200);
    expect(res.result).toMatchObject({ ok: true });
  });
});
