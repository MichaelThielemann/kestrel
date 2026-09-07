import { describe, it, expect } from "vitest";
import type { Blob, Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext, type Context } from "@michaelthielemann/kestrel/context";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import module, { configSchema } from "./module.ts";
import { createMediaDefault, type Config, type Media } from "./impl.ts";

function fakeBlobstore(): Blobstore & { blobs: Map<string, Blob> } {
  const blobs = new Map<string, Blob>();
  return {
    blobs,
    async put(key, blob) { blobs.set(key, blob); return ok(); },
    async get(key) { return ok(blobs.get(key) ?? null); },
    async remove(key) { blobs.delete(key); return ok(); },
    async move(from, to) { const b = blobs.get(from); if (!b) return err(failure("NOT_FOUND", `${from} not found`)); blobs.set(to, b); blobs.delete(from); return ok(); },
    async list(prefix) { return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.data.byteLength, contentType: b.contentType }))); },
  };
}

function fakeCtx(files: Context["files"] = [], payload: Record<string, unknown> = {}, params: Record<string, string> = {}): Context {
  return createContext({ trigger: { kind: "http", name: "t" }, payload, params, files });
}

const noLogger: Logger = { step() {}, info() {}, error() {} };
const config = (overrides: Partial<Config> = {}): Config => ({ allowedTypes: ["image/*"], deniedTypes: [], maxBytes: 1024, locales: [], prefix: "media/", ...overrides });

async function make(overrides: Partial<Config> = {}): Promise<{ media: Media; blobs: Blobstore & { blobs: Map<string, Blob> }; db: FakePersistence; steps: ReturnType<NonNullable<typeof module.steps>> }> {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  const media = await createMediaDefault(config(overrides), blobs, db, noLogger);
  return { media, blobs, db, steps: module.steps!(media) };
}

const file = (filename: string, data: Uint8Array = new Uint8Array([1])): Context["files"][number] => ({ field: "file", filename, contentType: "image/png", data });

describe("media/default upload step", () => {
  it("maps a duplicate filename to CONFLICT", async () => {
    const { steps } = await make();
    expectOk(await steps.upload(fakeCtx([file("a.png")])));
    const error = expectErr(await steps.upload(fakeCtx([file("a.png")])), "CONFLICT");
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/already exists/);
  });

  it("no file uploaded is a VALIDATION failure", async () => {
    const { steps } = await make();
    expect(expectErr(await steps.upload(fakeCtx([])), "VALIDATION").status).toBe(400);
  });

  it("a single file keeps the item-only response", async () => {
    const { steps } = await make();
    const ctx = expectOk(await steps.upload(fakeCtx([file("a.png")])));
    expect((ctx.result as { filename: string }).filename).toBe("a.png");
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
    const result = ctx.result as { items: Array<{ filename: string; id: string }>; errors: Array<{ filename: string; status: number; code: string; message: string }>; ids: string[] };
    expect(result.items.map((i) => i.filename)).toEqual(["a.png", "b.png"]);
    expect(result.errors).toEqual([{ filename: "c.png", status: 413, code: "PAYLOAD_TOO_LARGE", message: expect.stringContaining("exceeds") as string }]);
    expect(result.ids).toEqual(result.items.map((i) => i.id));
  });

  it("multiple files: a conflict is a CONFLICT error entry, not a failed step", async () => {
    const { steps } = await make();
    expectOk(await steps.upload(fakeCtx([file("a.png")])));
    const ctx = expectOk(await steps.upload(fakeCtx([file("a.png"), file("d.png")])));
    const result = ctx.result as { items: Array<{ filename: string }>; errors: Array<{ filename: string; status: number; code: string }> };
    expect(result.items.map((i) => i.filename)).toEqual(["d.png"]);
    expect(result.errors).toEqual([{ filename: "a.png", status: 409, code: "CONFLICT", message: expect.stringContaining("already exists") as string }]);
  });

  it("multiple files: a transient failure fails the whole request instead of becoming an entry", async () => {
    const { steps, db } = await make();
    db.failNext("TRANSIENT");
    const error = expectErr(await steps.upload(fakeCtx([file("a.png"), file("b.png")])), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("media/default download step", () => {
  it("flags an upload without provenance as unknown", async () => {
    const { media, steps } = await make();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }));
    expect(item.provenance).toEqual({ origin: "unknown" });
    const ctx = expectOk(await steps.download(fakeCtx([], {}, { id: item.id })));
    expect((ctx.result as { headers?: Record<string, string> }).headers).toEqual({ "x-content-provenance": "unknown" });
  });

  it("sets no provenance header for a human upload", async () => {
    const { media, steps } = await make();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }, "", "human"));
    const ctx = expectOk(await steps.download(fakeCtx([], {}, { id: item.id })));
    expect((ctx.result as { headers?: Record<string, string> }).headers).toBeUndefined();
  });

  it("keeps the binary result shape", async () => {
    const { media, steps } = await make();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1, 2]) }));
    const ctx = expectOk(await steps.download(fakeCtx([], {}, { id: item.id })));
    expect(ctx.result).toMatchObject({ binary: true, contentType: "image/png", filename: "a.png" });
    expect(Array.from((ctx.result as { data: Uint8Array }).data)).toEqual([1, 2]);
  });

  it("an unknown id is NOT_FOUND", async () => {
    const { steps } = await make();
    expect(expectErr(await steps.download(fakeCtx([], {}, { id: "missing" })), "NOT_FOUND").status).toBe(404);
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
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }));
    expect(expectErr(await steps.get(fakeCtx([], { locale: "fr" }, { id: item.id })), "VALIDATION").status).toBe(400);
  });

  it("a taken filename is CONFLICT", async () => {
    const { media, steps } = await make();
    expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }));
    const b = expectOk(await media.upload({ filename: "b.png", contentType: "image/png", data: new Uint8Array([1]) }));
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
    expect(expectErr(await steps.folderItems(fakeCtx([], {}, { path: "x" })), "CONFLICT").status).toBe(409);
    expect(expectOk(await steps.folderItems(fakeCtx([], { recursive: true }, { path: "x" }))).result).toMatchObject({ path: "x" });
  });

  it("an invalid path is VALIDATION and a missing payload path too", async () => {
    const { steps } = await make();
    expect(expectErr(await steps.createFolder(fakeCtx()), "VALIDATION").status).toBe(400);
    expect(expectErr(await steps.createFolder(fakeCtx([], { path: "../x" })), "VALIDATION").status).toBe(400);
  });
});

describe("media/default list step", () => {
  it("uses the first value of a repeated query param", async () => {
    const { media, steps } = await make();
    expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }, "a"));
    const ctx = expectOk(await steps.list(fakeCtx([], { folder: ["a", "b"] })));
    expect((ctx.result as { total: number }).total).toBe(1);
  });

  it("answers TRANSIENT (503, retryable) when persistence is down", async () => {
    const { steps, db } = await make();
    db.failNext("TRANSIENT");
    const error = expectErr(await steps.list(fakeCtx()), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("media/default reconcile step", () => {
  it("reports orphans and deletes them only when payload.delete is set", async () => {
    const { blobs, steps } = await make();
    expectOk(await blobs.put("media/stray.png", { data: new Uint8Array([1]), contentType: "image/png" }));

    const reported = expectOk(await steps.reconcile(fakeCtx()));
    expect(reported.result).toEqual({ blobsWithoutRow: ["media/stray.png"], rowsWithoutBlob: [] });
    expect(expectOk(await blobs.get("media/stray.png"))).not.toBeNull();

    expectOk(await steps.reconcile(fakeCtx([], { delete: true })));
    expect(expectOk(await blobs.get("media/stray.png"))).toBeNull();
  });

  it("reconcileDelete deletes without a payload flag", async () => {
    const { blobs, steps } = await make();
    expectOk(await blobs.put("media/stray.png", { data: new Uint8Array([1]), contentType: "image/png" }));

    const ctx = expectOk(await steps.reconcileDelete(fakeCtx()));
    expect(ctx.result).toEqual({ blobsWithoutRow: ["media/stray.png"], rowsWithoutBlob: [] });
    expect(expectOk(await blobs.get("media/stray.png"))).toBeNull();
  });
});

describe("media/default configSchema prefix validation", () => {
  it("rejects empty prefix", () => {
    expect(configSchema.safeParse({ prefix: "" }).success).toBe(false);
  });

  it("rejects prefix without trailing slash", () => {
    expect(configSchema.safeParse({ prefix: "media" }).success).toBe(false);
  });

  it("rejects prefix with leading slash", () => {
    expect(configSchema.safeParse({ prefix: "/media/" }).success).toBe(false);
  });

  it("accepts valid single-segment prefix", () => {
    expect(configSchema.safeParse({ prefix: "media/" }).success).toBe(true);
  });

  it("accepts valid multi-segment prefix", () => {
    expect(configSchema.safeParse({ prefix: "assets/media/" }).success).toBe(true);
  });
});
