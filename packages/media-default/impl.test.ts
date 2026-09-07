import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { createBlobstoreFilesystem } from "@michaelthielemann/kestrel-blobstore-filesystem/impl";
import type { Blob, Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Document, NewDocument, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { COLLECTION, FOLDERS, createMediaDefault, parseProvenance, safeName, type Config } from "./impl.ts";

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
const png = { filename: "../evil name.PNG", contentType: "image/png", data: new Uint8Array([1, 2, 3]) };
const noLogger: Logger = { step() {}, info() {}, error() {} };
const make = async (config: Config = { allowedTypes: ["image/*"], deniedTypes: ["image/svg+xml"], maxBytes: 10, locales: ["de", "en"], defaultLocale: "de", prefix: "media/" }) => {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  const infos: string[] = [];
  const errors: string[] = [];
  const logger: Logger = { step() {}, info: (m) => infos.push(m), error: (m) => errors.push(m) };
  return { media: await createMediaDefault(config, blobs, db, logger, () => 7), blobs, db, infos, errors };
};

describe("media/default", () => {
  it("stores the blob under a generated key and the metadata in its collection", async () => {
    const { media, blobs, db } = await make();
    const item = expectOk(await media.upload(png));
    expect(item).toMatchObject({ filename: "evil-name.PNG", contentType: "image/png", size: 3, createdAt: 7 });
    expect(item.key).toBe("media/evil-name.PNG");
    expect(blobs.blobs.get(item.key)?.contentType).toBe("image/png");
    expect(expectOk(await db.count(COLLECTION, {}))).toBe(1);
  });

  it("rejects disallowed types as UNSUPPORTED and oversized files as PAYLOAD_TOO_LARGE", async () => {
    const { media } = await make();
    expect(expectErr(await media.upload({ ...png, contentType: "text/html" }), "UNSUPPORTED").message).toMatch(/not allowed/);
    expect(expectErr(await media.upload({ ...png, contentType: "image/svg+xml" }), "UNSUPPORTED").status).toBe(415);
    expect(expectErr(await media.upload({ ...png, data: new Uint8Array(11) }), "PAYLOAD_TOO_LARGE").status).toBe(413);
  });

  it("reads bytes back and removes blob and metadata together", async () => {
    const { media, blobs } = await make();
    const item = expectOk(await media.upload(png));
    expect(Array.from(expectOk(await media.read(item.id))?.data ?? [])).toEqual([1, 2, 3]);
    expectOk(await media.remove(item.id));
    expect(blobs.blobs.size).toBe(0);
    expect(expectOk(await media.get(item.id))).toBeNull();
    expectOk(await media.remove(item.id));
  });

  it("renames and moves items, keeping the blob content but relocating its key", async () => {
    const { media, blobs } = await make();
    const item = expectOk(await media.upload(png, "2026/press"));
    expect(item.folder).toBe("2026/press");
    const moved = expectOk(await media.update(item.id, { filename: "Hero Image.png", folder: "/archive/" }));
    expect(moved).toMatchObject({ filename: "Hero-Image.png", folder: "archive", key: "media/archive/Hero-Image.png" });
    expect(blobs.blobs.size).toBe(1);
    expect(expectOk(await media.list({ folder: "archive" })).total).toBe(1);
    expect(expectOk(await media.list({ folder: "2026/press" })).total).toBe(0);
    expect(expectErr(await media.update(item.id, { folder: "../x" }), "VALIDATION").message).toMatch(/invalid folder/);
    expect(expectOk(await media.update("missing", { filename: "x" }))).toBeNull();
  });

  it("defaults provenance to unknown and accepts origin strings or objects", async () => {
    const { media } = await make();
    expect(expectOk(await media.upload(png)).provenance).toEqual({ origin: "unknown" });
    expect(expectOk(await media.upload({ ...png, filename: "human.png" }, "", "human")).provenance).toEqual({ origin: "human" });
    expect(expectOk(await media.upload({ ...png, filename: "ai.png" }, "", "ai")).provenance).toEqual({ origin: "ai" });
    expect(expectOk(await media.upload({ ...png, filename: "mixed.png" }, "", '{"origin":"mixed","tool":"editor","model":"x-1","at":5}')).provenance).toEqual({ origin: "mixed", tool: "editor", model: "x-1", at: 5 });
    expect(expectErr(await media.upload({ ...png, filename: "robot.png" }, "", "robot"), "VALIDATION").message).toMatch(/origin must be/);
    expect(expectOk(parseProvenance({ origin: "ai", tool: "" }))).toEqual({ origin: "ai" });
    const item = expectOk(await media.upload({ ...png, filename: "plain.png" }));
    expect(expectOk(await media.update(item.id, { provenance: { origin: "ai", model: "m" } }))?.provenance).toEqual({ origin: "ai", model: "m" });
    expect(expectOk(await media.list()).items.every((i) => i.provenance.origin !== undefined)).toBe(true);
  });

  it("searches, sorts, filters folders recursively and lists folders", async () => {
    const blobs = fakeBlobstore();
    let t = 0;
    const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, blobs, createFakePersistence(), noLogger, () => ++t);
    const a = expectOk(await media.upload({ ...png, filename: "alpha.png" }, "2026/press"));
    const b = expectOk(await media.upload({ ...png, filename: "beta.png", data: new Uint8Array(10) }, "2026"));
    const c = expectOk(await media.upload({ ...png, filename: "gamma.png" }, "archive"));
    expect(expectOk(await media.list({ q: "ALPH" })).items.map((i) => i.id)).toEqual([]);
    expect(expectOk(await media.list({ q: "alph" })).items.map((i) => i.id)).toEqual([a.id]);
    expect(expectOk(await media.list({ folder: "2026", recursive: true, q: "ALPH" })).items.map((i) => i.id)).toEqual([]);
    expect(expectOk(await media.list({ folder: "2026", recursive: true, q: "alph" })).items.map((i) => i.id)).toEqual([a.id]);
    expect(expectOk(await media.list({ sortBy: "filename" })).items.map((i) => i.filename)).toEqual(["alpha.png", "beta.png", "gamma.png"]);
    expect(expectOk(await media.list({ sortBy: "size", direction: "desc" })).items[0]?.id).toBe(b.id);
    expect(expectOk(await media.list({ folder: "2026" })).items.map((i) => i.id)).toEqual([b.id]);
    expect(expectOk(await media.list({ folder: "2026", recursive: true })).items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect(expectOk(await media.folders())).toEqual([{ folder: "2026", count: 1 }, { folder: "2026/press", count: 1 }, { folder: "archive", count: 1 }]);
    expect(expectOk(await media.byIds([c.id, "missing", a.id])).map((i) => i.id)).toEqual([c.id, a.id]);
    expect(expectOk(await media.byIds([]))).toEqual([]);
  });

  it("recursive list matches the exact subtree, not a LIKE prefix or byte range", async () => {
    const blobs = fakeBlobstore();
    let t = 0;
    const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, blobs, createFakePersistence(), noLogger, () => ++t);
    const a = expectOk(await media.upload({ ...png, filename: "a.png" }, "2026"));
    const b = expectOk(await media.upload({ ...png, filename: "b.png" }, "2026/presse"));
    expectOk(await media.upload({ ...png, filename: "c.png" }, "2026x"));
    expectOk(await media.upload({ ...png, filename: "d.png" }, "2026-alt"));
    const found = expectOk(await media.list({ folder: "2026", recursive: true }));
    expect(found.items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect(found.total).toBe(2);

    const e = expectOk(await media.upload({ ...png, filename: "e.png" }, "bilder_2026/sub"));
    expect(expectOk(await media.list({ folder: "bilder_2026", recursive: true })).items.map((i) => i.id)).toEqual([e.id]);

    const f = expectOk(await media.upload({ ...png, filename: "f.png" }, "Presse"));
    const g = expectOk(await media.upload({ ...png, filename: "g.png" }, "presse"));
    expect(expectOk(await media.list({ folder: "Presse", recursive: true })).items.map((i) => i.id)).toEqual([f.id]);
    expect(expectOk(await media.list({ folder: "presse", recursive: true })).items.map((i) => i.id)).toEqual([g.id]);
  });

  it("recursive list applies q, sort and paging in memory with a correct total", async () => {
    const blobs = fakeBlobstore();
    let t = 0;
    const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, blobs, createFakePersistence(), noLogger, () => ++t);
    expectOk(await media.upload({ ...png, filename: "alpha.png" }, "root"));
    expectOk(await media.upload({ ...png, filename: "beta-alpha.png" }, "root/sub1"));
    expectOk(await media.upload({ ...png, filename: "gamma-alpha.png" }, "root/sub2"));
    expectOk(await media.upload({ ...png, filename: "delta.png" }, "root/sub2"));
    const page = expectOk(await media.list({ folder: "root", recursive: true, q: "alpha", sortBy: "filename", direction: "asc", limit: 1, offset: 1 }));
    expect(page.items.map((i) => i.filename)).toEqual(["beta-alpha.png"]);
    expect(page.total).toBe(3);
  });

  it("stores localized texts, resolves them per locale and bumps updatedAt", async () => {
    const { media } = await make();
    const item = expectOk(await media.upload(png));
    expect(item).toMatchObject({ alt: null, title: null, description: null, updatedAt: item.createdAt });
    const de = expectOk(await media.update(item.id, { alt: "Ein Bild", title: "Titel" }));
    expect(de).toMatchObject({ alt: "Ein Bild", title: "Titel", description: null });
    const en = expectOk(await media.update(item.id, { alt: "A picture" }, "en"));
    expect(en).toMatchObject({ alt: "A picture", title: null });
    expect(expectOk(await media.get(item.id, "de"))).toMatchObject({ alt: "Ein Bild", title: "Titel" });
    expect(expectOk(await media.get(item.id))?.alt).toBe("Ein Bild");
    expect(expectOk(await media.byIds([item.id], "en"))[0]?.alt).toBe("A picture");
    expect(expectOk(await media.list({ locale: "en" })).items[0]?.alt).toBe("A picture");
    expectOk(await media.update(item.id, { alt: null }, "en"));
    expect(expectOk(await media.get(item.id, "en"))?.alt).toBeNull();
    expect(expectErr(await media.get(item.id, "fr"), "VALIDATION").message).toMatch(/unknown locale/);
    const numericAlt: { alt?: string | null } = {};
    Object.assign(numericAlt, { alt: 5 });
    expect(expectErr(await media.update(item.id, numericAlt), "VALIDATION").message).toMatch(/must be a string/);
  });

  it("takes the texts as plain text: markup stays intact, control characters and overlong values are rejected", async () => {
    const { media } = await make();
    const item = expectOk(await media.upload(png));
    const kept = expectOk(await media.update(item.id, { alt: "5 < 6 & 7 > 6", description: "Zeile 1\nZeile 2\tEnde" }));
    expect(kept).toMatchObject({ alt: "5 < 6 & 7 > 6", description: "Zeile 1\nZeile 2\tEnde" });
    for (const field of ["alt", "title", "description"] as const) {
      expect(expectErr(await media.update(item.id, { [field]: "a\u0000b" }), "VALIDATION").message).toMatch(new RegExp(`${field} must be plain text \\(max 2000 chars\\)`));
      expect(expectErr(await media.update(item.id, { [field]: "x".repeat(2001) }), "VALIDATION").message).toMatch(/must be plain text/);
      expect(expectOk(await media.update(item.id, { [field]: "x".repeat(2000) }, "en"))).toMatchObject({ [field]: "x".repeat(2000) });
    }
  });

  it("reads image dimensions from the file header", async () => {
    const { media } = await make({ allowedTypes: ["image/*"], deniedTypes: [], maxBytes: 1000, locales: [], prefix: "media/" });
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x01, 0x40, 0, 0, 0, 0xf0]);
    expect(expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: pngHeader }))).toMatchObject({ width: 320, height: 240 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x08, 0x00]);
    expect(expectOk(await media.upload({ filename: "a.gif", contentType: "image/gif", data: gif }))).toMatchObject({ width: 16, height: 8 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(expectOk(await media.upload({ filename: "a.jpg", contentType: "image/jpeg", data: jpeg }))).toMatchObject({ width: 200, height: 100 });
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 0, 0, 0, 0, 0, 0, 0, 0, 0x3f, 0x01, 0x00, 0xdf, 0x00, 0x00]);
    expect(expectOk(await media.upload({ filename: "a.webp", contentType: "image/webp", data: webp }))).toMatchObject({ width: 320, height: 224 });
    expect(expectOk(await media.upload({ filename: "x.bin", contentType: "image/x-unknown", data: new Uint8Array([1, 2, 3]) }))).toMatchObject({ width: null, height: null });
  });

  it("lists newest first", async () => {
    const blobs = fakeBlobstore();
    let t = 0;
    const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, blobs, createFakePersistence(), noLogger, () => ++t);
    expectOk(await media.upload({ ...png, filename: "a.png" }));
    expectOk(await media.upload({ ...png, filename: "b.png" }));
    expect(expectOk(await media.list()).items.map((i) => i.filename)).toEqual(["b.png", "a.png"]);
  });

  it("keys are <folder>/<filename>, folders are created on upload and filenames are unique per folder", async () => {
    const { media, blobs, db } = await make();
    const a = expectOk(await media.upload(png, "2026/presse"));
    expect(a.key).toBe("media/2026/presse/evil-name.PNG");
    expect(blobs.blobs.has("media/2026/presse/evil-name.PNG")).toBe(true);
    expect(expectOk(await db.count(FOLDERS, { path: "2026/presse" }))).toBe(1);
    expect(expectErr(await media.upload(png, "2026/presse"), "CONFLICT").message).toMatch(/already exists/);
    const b = expectOk(await media.upload({ ...png, filename: "other.png" }, "2026/presse"));
    expectErr(await media.update(b.id, { filename: "evil-name.PNG" }), "CONFLICT");
  });

  it("moving or renaming an item moves its blob", async () => {
    const { media, blobs } = await make();
    const a = expectOk(await media.upload(png, "alt"));
    const moved = expectOk(await media.update(a.id, { folder: "neu/tief", filename: "x.png" }));
    expect(moved?.key).toBe("media/neu/tief/x.png");
    expect(blobs.blobs.has("media/alt/evil-name.PNG")).toBe(false);
    expect(blobs.blobs.get("media/neu/tief/x.png")?.contentType).toBe("image/png");
    expect(expectOk(await media.folders()).map((f) => f.folder)).toEqual(["alt", "neu", "neu/tief"]);
  });

  it("lists persistent empty folders and implied ancestors with counts", async () => {
    const { media } = await make();
    expect(expectOk(await media.createFolder("leer/tief"))).toEqual({ folder: "leer/tief", count: 0 });
    expect(expectOk(await media.createFolder("leer/tief"))).toEqual({ folder: "leer/tief", count: 0 });
    expectOk(await media.upload(png, "a/b"));
    expect(expectOk(await media.folders())).toEqual([
      { folder: "a", count: 0 }, { folder: "a/b", count: 1 }, { folder: "leer", count: 0 }, { folder: "leer/tief", count: 0 },
    ]);
    expectErr(await media.createFolder(""), "VALIDATION");
    expectErr(await media.createFolder("../x"), "VALIDATION");
  });

  it("renames a folder with its subtree, moving blobs and rewriting folder rows", async () => {
    const { media, blobs, db } = await make();
    const a = expectOk(await media.upload(png, "alt"));
    const b = expectOk(await media.upload({ ...png, filename: "b.png" }, "alt/sub"));
    expectOk(await media.createFolder("alt/leer"));
    expect(expectOk(await media.renameFolder("alt", "neu/name"))).toEqual({ folder: "neu/name", moved: 2 });
    expect(expectOk(await media.get(a.id))?.key).toBe("media/neu/name/evil-name.PNG");
    expect(expectOk(await media.get(b.id))?.folder).toBe("neu/name/sub");
    expect([...blobs.blobs.keys()].sort()).toEqual(["media/neu/name/evil-name.PNG", "media/neu/name/sub/b.png"]);
    expect(expectOk(await db.findMany(FOLDERS, {})).items.map((r) => r.path).sort()).toEqual(["neu/name", "neu/name/leer", "neu/name/sub"]);
    expect(expectOk(await media.renameFolder("gibt-es-nicht", "x"))).toBeNull();
    expectOk(await media.createFolder("belegt"));
    expectErr(await media.renameFolder("neu", "belegt"), "CONFLICT");
  });

  it("rename pre-checks key conflicts before moving anything", async () => {
    const { media, blobs } = await make();
    expectOk(await media.upload(png, "a"));
    expectOk(await media.upload(png, "b"));
    expectErr(await media.renameFolder("a", "b"), "CONFLICT");
    expect([...blobs.blobs.keys()].sort()).toEqual(["media/a/evil-name.PNG", "media/b/evil-name.PNG"]);
  });

  it("folderItems and removeFolder respect emptiness and recursion", async () => {
    const { media, blobs, db } = await make();
    const a = expectOk(await media.upload(png, "x/y"));
    expectOk(await media.createFolder("x/z"));
    expect(expectOk(await media.folderItems("nope", false))).toBeNull();
    expect(expectErr(await media.folderItems("x", false), "CONFLICT").message).toMatch(/not empty/);
    expect(expectOk(await media.folderItems("x/z", false))).toEqual({ path: "x/z", ids: [] });
    expect(expectOk(await media.folderItems("x", true))).toEqual({ path: "x", ids: [a.id] });
    expect(expectOk(await media.removeFolder("x"))).toEqual({ ok: true, removed: 1 });
    expect(blobs.blobs.size).toBe(0);
    expect(expectOk(await db.count(COLLECTION, {}))).toBe(0);
    expect(expectOk(await db.count(FOLDERS, {}))).toBe(0);
    expect(expectOk(await media.removeFolder("x"))).toBeNull();
  });

  it("migrates legacy uuid keys to path keys, suffixing on collision and logging missing blobs", async () => {
    const { media, blobs, db, infos, errors } = await make();
    expectOk(await blobs.put("legacy1.png", { data: new Uint8Array([1]), contentType: "image/png" }));
    expectOk(await blobs.put("legacy2.png", { data: new Uint8Array([2]), contentType: "image/png" }));
    const base = { contentType: "image/png", size: 1, createdAt: 1, updatedAt: 1, provenance: { origin: "human" }, width: null, height: null, alt: {}, title: {}, description: {} };
    expectOk(await db.createOne(COLLECTION, { ...base, filename: "bild.png", folder: "f", key: "legacy1.png" }));
    expectOk(await db.createOne(COLLECTION, { ...base, filename: "bild.png", folder: "f", key: "legacy2.png" }));
    expectOk(await db.createOne(COLLECTION, { ...base, filename: "weg.png", folder: "", key: "gone.png" }));
    expect(expectOk(await media.migrateKeys())).toEqual({ moved: 2, renamed: 1, missing: 1, skipped: 0 });
    expect([...blobs.blobs.keys()].sort()).toEqual(["media/f/bild-2.png", "media/f/bild.png"]);
    const rows = expectOk(await db.findMany<{ id: string; key: string; filename: string }>(COLLECTION, {}, { sort: { key: "asc" } })).items;
    expect(rows.map((r) => [r.key, r.filename])).toEqual([["gone.png", "weg.png"], ["media/f/bild-2.png", "bild-2.png"], ["media/f/bild.png", "bild.png"]]);
    expect(errors.some((m) => /gone\.png/.test(m))).toBe(true);
    expect(infos.some((m) => /migrated/.test(m))).toBe(true);
    expect(expectOk(await media.migrateKeys())).toEqual({ moved: 0, renamed: 0, missing: 1, skipped: 0 });
    expect(expectOk(await db.count(FOLDERS, { path: "f" }))).toBe(1);
  });

  it("migrateKeys never fails as a whole and skips names that would collide with a metadata sidecar", async () => {
    const { media, blobs, db, errors } = await make();
    expectOk(await blobs.put("legacy3.png", { data: new Uint8Array([3]), contentType: "image/png" }));
    const base = { contentType: "image/png", size: 1, createdAt: 1, updatedAt: 1, provenance: { origin: "human" }, width: null, height: null, alt: {}, title: {}, description: {} };
    expectOk(await db.createOne(COLLECTION, { ...base, filename: "x.meta.json", folder: "f", key: "legacy3.png" }));
    expect(expectOk(await media.migrateKeys())).toEqual({ moved: 0, renamed: 0, missing: 0, skipped: 1 });
    expect(blobs.blobs.has("legacy3.png")).toBe(true);
    expect(errors.some((m) => /x\.meta\.json/.test(m))).toBe(true);
  });

  it("migrateKeys counts an item whose blob store fails as skipped and carries on", async () => {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    const errors: string[] = [];
    const logger: Logger = { step() {}, info() {}, error: (m) => errors.push(m) };
    let failing = true;
    const media = await createMediaDefault(
      { allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" },
      { ...blobs, async get(key) { if (failing) { failing = false; return err(failure("TRANSIENT", "blobstore is busy")); } return blobs.get(key); } },
      db, logger, () => 7,
    );
    const base = { contentType: "image/png", size: 1, provenance: { origin: "human" }, width: null, height: null, alt: {}, title: {}, description: {}, status: "ready", checksum: null };
    expectOk(await db.createOne(COLLECTION, { ...base, createdAt: 1, updatedAt: 1, filename: "a.png", folder: "f", key: "legacy-a.png" }));
    expectOk(await db.createOne(COLLECTION, { ...base, createdAt: 2, updatedAt: 2, filename: "b.png", folder: "f", key: "legacy-b.png" }));
    expectOk(await blobs.put("legacy-b.png", { data: new Uint8Array([1]), contentType: "image/png" }));
    expect(expectOk(await media.migrateKeys())).toEqual({ moved: 1, renamed: 0, missing: 0, skipped: 1 });
    expect(errors.some((m) => /failed to migrate key/.test(m))).toBe(true);
  });

  it("update() validates every field before touching the blob", async () => {
    const { media, blobs } = await make();
    const item = expectOk(await media.upload(png, "a"));
    const patch: { filename?: string; alt?: string | null } = { filename: "b.png" };
    Object.assign(patch, { alt: 123 });
    expect(expectErr(await media.update(item.id, patch), "VALIDATION").message).toMatch(/must be a string/);
    expect(blobs.blobs.has(item.key)).toBe(true);
    expect(blobs.blobs.has("media/a/b.png")).toBe(false);
    expect(expectOk(await media.read(item.id))?.item.key).toBe(item.key);
  });

  it("neutralises a .meta.json suffix on upload so it cannot collide with a metadata sidecar", async () => {
    const { media } = await make();
    const item = expectOk(await media.upload({ ...png, filename: "evil.meta.json" }));
    expect(item.filename).toBe("evil-meta.json");
    expect(item.key).toBe("media/evil-meta.json");
    for (const name of ["x.meta.json", "x.META.JSON"]) expect(safeName(name).toLowerCase().endsWith(".meta.json")).toBe(false);
  });

  it("subtree operations match folder boundaries exactly, not SQL LIKE wildcards", async () => {
    const { media, blobs } = await make();
    const a = expectOk(await media.upload(png, "bilder_2026"));
    const b = expectOk(await media.upload({ ...png, filename: "b.png" }, "bilder_2026/presse"));
    expect(expectOk(await media.renameFolder("bilder_2026", "neu"))).toEqual({ folder: "neu", moved: 2 });
    expect(expectOk(await media.get(a.id))?.folder).toBe("neu");
    expect(expectOk(await media.get(b.id))?.folder).toBe("neu/presse");

    const c = expectOk(await media.upload({ ...png, filename: "c.png" }, "ab/x"));
    expect(expectOk(await media.folderItems("a_b", false))).toBeNull();
    expect(expectOk(await media.removeFolder("a_b"))).toBeNull();
    expect(expectOk(await media.renameFolder("a_b", "z"))).toBeNull();
    expect(expectOk(await media.get(c.id))?.folder).toBe("ab/x");
    expect(blobs.blobs.has(c.key)).toBe(true);

    expectOk(await media.createFolder("Presse"));
    expectOk(await media.createFolder("presse"));
    expect(expectOk(await media.folders()).map((f) => f.folder)).toEqual(expect.arrayContaining(["Presse", "presse"]));
    expect(expectOk(await media.folderItems("Presse", false))).toEqual({ path: "Presse", ids: [] });
    expect(expectOk(await media.folderItems("presse", false))).toEqual({ path: "presse", ids: [] });
  });

  it("caps sanitised filenames at 200 bytes, keeping the extension", async () => {
    const long = safeName(`${"a".repeat(500)}.png`);
    expect(Buffer.byteLength(long)).toBe(200);
    expect(long.endsWith(".png")).toBe(true);
    expect(safeName(`${"a".repeat(500)}.meta.json`).toLowerCase().endsWith(".meta.json")).toBe(false);
    const { media } = await make();
    expect(expectOk(await media.upload({ ...png, filename: `${"b".repeat(500)}.png` })).filename.length).toBe(200);
  });

  it("keeps media blobs under the configured prefix, out of the way of other blobstore users", async () => {
    const { media, blobs } = await make();
    const item = expectOk(await media.upload(png, "2026/presse"));
    expect(item.key).toBe("media/2026/presse/evil-name.PNG");
    expect([...blobs.blobs.keys()]).toEqual(["media/2026/presse/evil-name.PNG"]);
    expect(expectOk(await media.read(item.id))?.item.key).toBe("media/2026/presse/evil-name.PNG");
  });

  it("migrates keys that predate the prefix", async () => {
    const { media, blobs, db } = await make();
    expectOk(await blobs.put("2026/presse/x.png", { data: new Uint8Array([1]), contentType: "image/png" }));
    const base = { contentType: "image/png", size: 1, createdAt: 1, updatedAt: 1, provenance: { origin: "human" }, width: null, height: null, alt: {}, title: {}, description: {} };
    expectOk(await db.createOne(COLLECTION, { ...base, filename: "x.png", folder: "2026/presse", key: "2026/presse/x.png" }));
    expect(expectOk(await media.migrateKeys())).toEqual({ moved: 1, renamed: 0, missing: 0, skipped: 0 });
    expect([...blobs.blobs.keys()]).toEqual(["media/2026/presse/x.png"]);
  });

  it("finishes a migration whose blob was already moved before the row was updated", async () => {
    const { media, blobs, db } = await make();
    expectOk(await blobs.put("media/f/bild.png", { data: new Uint8Array([1]), contentType: "image/png" }));
    const base = { contentType: "image/png", size: 1, createdAt: 1, updatedAt: 1, provenance: { origin: "human" }, width: null, height: null, alt: {}, title: {}, description: {} };
    const row = expectOk(await db.createOne(COLLECTION, { ...base, filename: "bild.png", folder: "f", key: "legacy.png" }));
    expect(expectOk(await media.migrateKeys())).toEqual({ moved: 1, renamed: 0, missing: 0, skipped: 0 });
    expect(expectOk(await media.get(row.id))?.key).toBe("media/f/bild.png");
    expect(expectOk(await db.count(FOLDERS, { path: "f" }))).toBe(1);
  });

  it("update and renameFolder finish a move whose blob already reached the target", async () => {
    const { media, blobs } = await make();
    const a = expectOk(await media.upload(png, "alt"));
    // simulate a crash after blobs.move but before the row update
    blobs.blobs.set("media/neu/evil-name.PNG", blobs.blobs.get(a.key)!);
    blobs.blobs.delete(a.key);
    expect(expectOk(await media.update(a.id, { folder: "neu" }))?.key).toBe("media/neu/evil-name.PNG");

    const b = expectOk(await media.upload({ ...png, filename: "b.png" }, "ordner"));
    blobs.blobs.set("media/ziel/b.png", blobs.blobs.get(b.key)!);
    blobs.blobs.delete(b.key);
    expect(expectOk(await media.renameFolder("ordner", "ziel"))).toEqual({ folder: "ziel", moved: 1 });
    expect(expectOk(await media.get(b.id))?.key).toBe("media/ziel/b.png");
  });

  it("passes a failed move on when the target is not there either", async () => {
    const { media, blobs } = await make();
    const a = expectOk(await media.upload(png, "alt"));
    blobs.blobs.delete(a.key);
    expect(expectErr(await media.update(a.id, { folder: "neu" }), "NOT_FOUND").message).toMatch(/not found/);
  });

  describe("two-phase upload", () => {
    it("records a sha256 checksum and a ready status, writing the row before the blob", async () => {
      const blobs = fakeBlobstore();
      const order: string[] = [];
      const db = createFakePersistence();
      const observed: Persistence = { ...db, async createOne<T extends Document>(collection: string, data: NewDocument<T>) { if (collection === COLLECTION) order.push(`row:${String(data.status)}`); return db.createOne<T>(collection, data); } };
      const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, { ...blobs, async put(key, blob) { order.push("blob"); return blobs.put(key, blob); } }, observed, noLogger, () => 7);
      const item = expectOk(await media.upload({ ...png, filename: "shot.png" }));
      expect(order).toEqual(["row:uploading", "blob"]);
      expect(item.status).toBe("ready");
      expect(item.checksum).toBe(createHash("sha256").update(png.data).digest("hex"));
    });

    it("marks the row failed when the blob write fails, hides it and frees the name again", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      let broken = true;
      const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, { ...blobs, async put(key, blob) { if (broken) return err(failure("TRANSIENT", "blobstore down")); return blobs.put(key, blob); } }, db, noLogger, () => 7);
      expect(expectErr(await media.upload({ ...png, filename: "shot.png" }), "TRANSIENT").message).toMatch(/blobstore down/);
      const stored = expectOk(await db.findOne<{ id: string; status: string }>(COLLECTION, {}));
      expect(stored?.status).toBe("failed");
      expect(expectOk(await media.get(stored!.id))).toBeNull();
      expect(expectOk(await media.read(stored!.id))).toBeNull();
      expect(expectOk(await media.list()).total).toBe(0);
      expect(expectOk(await media.byIds([stored!.id]))).toEqual([]);

      broken = false;
      const retried = expectOk(await media.upload({ ...png, filename: "shot.png" }));
      expect(retried.status).toBe("ready");
      expect(expectOk(await db.count(COLLECTION, {}))).toBe(1);
    });

    it("treats rows written before the status field as ready", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      expectOk(await db.ensureCollection(COLLECTION, { filename: "string", folder: "string", contentType: "string", size: "number", key: "string", createdAt: "number", updatedAt: "number", provenance: "json", width: "number", height: "number", alt: "json", title: "json", description: "json" }));
      const legacy = expectOk(await db.createOne(COLLECTION, { filename: "old.png", folder: "", contentType: "image/png", size: 3, key: "media/old.png", createdAt: 1, updatedAt: 1, provenance: null, width: null, height: null, alt: {}, title: {}, description: {} }));
      expectOk(await blobs.put("media/old.png", { data: png.data, contentType: "image/png" }));
      const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, blobs, db, noLogger, () => 7);
      expect(expectOk(await media.get(legacy.id))?.status).toBe("ready");
      expect(expectOk(await media.get(legacy.id))?.provenance).toEqual({ origin: "unknown" });
      expect(expectOk(await media.list()).total).toBe(1);
      expect(expectOk(await media.read(legacy.id))?.item.checksum).toBeNull();
    });
  });

  it("deletes the row before the blob and survives a failing blob delete", async () => {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    const errors: string[] = [];
    const logger: Logger = { step() {}, info() {}, error: (m) => errors.push(m) };
    const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, { ...blobs, async remove() { return err(failure("TRANSIENT", "blobstore down")); } }, db, logger, () => 7);
    const item = expectOk(await media.upload({ ...png, filename: "shot.png" }));
    expectOk(await media.remove(item.id));
    expect(expectOk(await db.count(COLLECTION, {}))).toBe(0);
    expect(blobs.blobs.has(item.key)).toBe(true);
    expect(errors.join("\n")).toMatch(/could not delete blob/);
  });

  it("moves the blob back when the row update after a rename fails", async () => {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    const failing: Persistence = { ...db, async updateOne<T extends Document>(collection: string, id: string, patch: Partial<Omit<T, "id">>) { if (collection === COLLECTION && (patch as Record<string, unknown>).key !== undefined) return err(failure("TRANSIENT", "row update failed")); return db.updateOne<T>(collection, id, patch); } };
    const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, blobs, failing, noLogger, () => 7);
    const item = expectOk(await media.upload({ ...png, filename: "shot.png" }));
    expect(expectErr(await media.update(item.id, { folder: "archive" }), "TRANSIENT").message).toMatch(/row update failed/);
    expect([...blobs.blobs.keys()]).toEqual([item.key]);
  });

  describe("reconcile", () => {
    it("reports blobs without a row and rows without a blob, and deletes only orphan blobs on request", async () => {
      const { media, blobs, db } = await make({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" });
      const kept = expectOk(await media.upload({ ...png, filename: "kept.png" }));
      const lost = expectOk(await media.upload({ ...png, filename: "lost.png" }));
      blobs.blobs.delete(lost.key);
      expectOk(await blobs.put("media/stray.png", { data: png.data, contentType: "image/png" }));
      expectOk(await blobs.put("media-variants/x/thumb.webp", { data: png.data, contentType: "image/webp" }));
      expectOk(await blobs.put("site/index.html", { data: png.data, contentType: "text/html" }));

      expect(expectOk(await media.reconcile())).toEqual({ blobsWithoutRow: ["media/stray.png"], rowsWithoutBlob: ["media/lost.png"] });
      expect(blobs.blobs.has("media/stray.png")).toBe(true);

      expect(expectOk(await media.reconcile({ delete: true }))).toEqual({ blobsWithoutRow: ["media/stray.png"], rowsWithoutBlob: ["media/lost.png"] });
      expect(blobs.blobs.has("media/stray.png")).toBe(false);
      expect(blobs.blobs.has("media-variants/x/thumb.webp")).toBe(true);
      expect(blobs.blobs.has("site/index.html")).toBe(true);
      expect(blobs.blobs.has(kept.key)).toBe(true);
      expect(expectOk(await db.count(COLLECTION, {}))).toBe(2);
    });
  });

  describe("on the filesystem blobstore", () => {
    const roots: string[] = [];
    afterAll(async () => {
      for (const root of roots) await rm(root, { recursive: true, force: true });
    });

    it("keeps the on-disk tree under <root>/media and prunes emptied directories", async () => {
      const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "media-fs-"));
      roots.push(root);
      const media = await createMediaDefault({ allowedTypes: ["image/*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, createBlobstoreFilesystem({ root }), createFakePersistence(), noLogger);
      const exists = async (...parts: string[]): Promise<boolean> => stat(join(root, ...parts)).then(() => true, () => false);

      const item = expectOk(await media.upload({ ...png, filename: "bild.png" }, "2026/presse"));
      expect(item.key).toBe("media/2026/presse/bild.png");
      expect(await exists("media", "2026", "presse", "bild.png")).toBe(true);

      expectOk(await media.update(item.id, { folder: "archiv/2026/presse", filename: "neu.png" }));
      expect(await exists("media", "archiv", "2026", "presse", "neu.png")).toBe(true);
      expect(await exists("media", "2026")).toBe(false);

      expectOk(await media.renameFolder("archiv", "alt"));
      expect(await exists("media", "alt", "2026", "presse", "neu.png")).toBe(true);
      expect(await exists("media", "archiv")).toBe(false);

      expect(expectOk(await media.removeFolder("alt"))).toEqual({ ok: true, removed: 1 });
      expect(await readdir(root)).toEqual([]);
    });
  });

  describe("exportTo", () => {
    const dirs: string[] = [];
    afterAll(async () => {
      for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    });
    const tempDir = async (): Promise<string> => {
      const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "media-export-"));
      dirs.push(dir);
      return dir;
    };

    it("writes items as <dir>/<folder>/<filename> with the blob bytes and updatedAt as mtime, then skips on re-export", async () => {
      const dir = await tempDir();
      const blobs = fakeBlobstore();
      let t = 0;
      const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, blobs, createFakePersistence(), noLogger, () => ++t);
      const item = expectOk(await media.upload({ ...png, filename: "alpha.png" }, "2026/press"));

      const first = expectOk(await media.exportTo(dir));
      expect(first).toEqual({ written: 1, skipped: 0, missing: 0, conflicts: 0 });
      const target = join(dir, "2026", "press", "alpha.png");
      expect(Array.from(await readFile(target))).toEqual(Array.from(png.data));
      expect((await stat(target)).mtimeMs).toBe(item.updatedAt);

      const second = expectOk(await media.exportTo(dir));
      expect(second).toEqual({ written: 0, skipped: 1, missing: 0, conflicts: 0 });
    });

    it("suffixes conflicting folder+filename pairs by creation order", async () => {
      const dir = await tempDir();
      const blobs = fakeBlobstore();
      let t = 0;
      const db = createFakePersistence();
      const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, blobs, db, noLogger, () => ++t);
      const first = expectOk(await media.upload({ ...png, filename: "shot.png", data: new Uint8Array([1]) }, "gallery"));
      const second = expectOk(await media.upload({ ...png, filename: "shot2.png", data: new Uint8Array([2, 2]) }, "gallery"));
      // bypass upload's per-folder filename uniqueness to exercise exportTo's own conflict-suffixing on export-target paths
      expectOk(await db.updateOne(COLLECTION, second.id, { filename: "shot.png" }));

      const result = expectOk(await media.exportTo(dir));
      expect(result).toEqual({ written: 2, skipped: 0, missing: 0, conflicts: 1 });
      expect(Array.from(await readFile(join(dir, "gallery", "shot.png")))).toEqual([1]);
      expect(Array.from(await readFile(join(dir, "gallery", "shot-2.png")))).toEqual([2, 2]);
      expect(first.id).not.toBe(second.id);
    });

    it("counts a missing blob and continues", async () => {
      const dir = await tempDir();
      const blobs = fakeBlobstore();
      let t = 0;
      const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, blobs, createFakePersistence(), noLogger, () => ++t);
      const item = expectOk(await media.upload({ ...png, filename: "orphan.png" }));
      blobs.blobs.delete(item.key);

      const result = expectOk(await media.exportTo(dir));
      expect(result).toEqual({ written: 0, skipped: 0, missing: 1, conflicts: 0 });
    });

    it("cannot escape the target directory", async () => {
      const dir = await tempDir();
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      const media = await createMediaDefault({ allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" }, blobs, db, noLogger, () => 1);
      const item = expectOk(await media.upload({ ...png, filename: "safe.png" }));
      expectOk(await db.updateOne(COLLECTION, item.id, { folder: "../../escape" }));

      await expect(media.exportTo(dir)).rejects.toThrow(/escapes/);
    });
  });
});
