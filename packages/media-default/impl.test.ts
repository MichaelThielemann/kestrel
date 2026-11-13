import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { createBlobstoreFilesystem } from "@michaelthielemann/kestrel-blobstore-filesystem/impl";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Document, NewDocument, Persistence, Schema } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { EXTENSION_BY_TYPE } from "@michaelthielemann/kestrel-contracts/helpers/mediaType";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import type { Introspection, Manifest, RunObserver } from "@michaelthielemann/kestrel";
import { COLLECTION, FOLDERS, createMediaDefault, nameFor, parseProvenance, publicTreeOf, publishedFileOf, safeName, urlNameOf, type Config } from "./impl.ts";

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
const png = { filename: "../evil name.PNG", contentType: "image/png", data: new Uint8Array([1, 2, 3]) };
const noLogger: Logger = { step() {}, info() {}, error() {} };
const BASE_CONFIG: Config = { allowedTypes: ["image/*"], deniedTypes: ["image/svg+xml"], maxBytes: 10, locales: ["de", "en"], defaultLocale: "de", prefix: "media/", publicPath: "/media", uploadStaleAfterMs: 900000, anonymousList: "ids" };
const make = async (config: Config = BASE_CONFIG) => {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  const infos: string[] = [];
  const errors: string[] = [];
  const logger: Logger = { step() {}, info: (m) => infos.push(m), error: (m) => errors.push(m) };
  return { media: await createMediaDefault(config, blobs, db, logger, () => 7), blobs, db, infos, errors };
};
function manifestWithPipelines(names: Array<{ pipeline: string; module: string; step: string; writes?: string[] }>): Manifest {
  return {
    core: { version: "0.0.0" },
    contracts: [],
    modules: [],
    steps: [],
    pipelines: [...new Set(names.map((n) => n.pipeline))].map((pipeline) => ({
      name: pipeline,
      steps: names.filter((n) => n.pipeline === pipeline).map((n) => ({ spec: n.step, name: n.step, module: n.module, description: { summary: "", reads: [], writes: n.writes ?? [] } })),
    })),
    triggers: { http: [], events: [], crons: [] },
    warnings: [],
  };
}
function introspectionOf(manifest: Manifest, observers: RunObserver[] = []): Introspection {
  return {
    describe: () => manifest,
    observe: (observer) => {
      observers.push(observer);
      return () => observers.splice(observers.indexOf(observer), 1);
    },
    health: () => ({ ok: true, restartRequired: false, modules: [] }),
  };
}
function atUpload(observers: RunObserver[], runId: string, pipeline: string, step = "media.upload"): () => void {
  for (const observer of observers) observer.stepStart?.({ runId, pipeline, step, at: 1 });
  return () => {
    for (const observer of observers) observer.stepEnd?.({ runId, pipeline, step, at: 1, ms: 1, status: 200, outcome: "ok" });
  };
}
async function seedRow(db: Persistence, blobs: Blobstore, row: { id: string; key: string; contentType: string }): Promise<void> {
  const name = urlNameOf(row.key);
  expectOk(await db.createOne<Document>(COLLECTION, { filename: name, folder: "", location: name, size: 3, checksum: "x", status: "ready", createdAt: 1, updatedAt: 1, provenance: { origin: "unknown" }, width: null, height: null, alt: {}, title: {}, description: {}, ...row }));
  expectOk(await blobs.put(row.key, new Uint8Array([1, 2, 3]), { contentType: row.contentType }));
}

describe("media/default", () => {
  it("stores the blob under an id-based key and the metadata in its collection", async () => {
    const { media, blobs, db } = await make();
    const item = expectOk(await media.upload(png)).item;
    expect(item).toMatchObject({ filename: "evil-name.png", contentType: "image/png", size: 3, createdAt: 7 });
    expect(item.key).toBe(`media/${item.id}/evil-name.png`);
    expect(item.location).toBe("evil-name.png");
    expect(blobs.blobs.get(item.key)?.contentType).toBe("image/png");
    expect(expectOk(await db.count(COLLECTION, {}))).toBe(1);
  });

  it("rejects disallowed types as UNSUPPORTED and oversized files as PAYLOAD_TOO_LARGE", async () => {
    const { media } = await make();
    expect(expectErr(await media.upload({ ...png, contentType: "text/html" }), "UNSUPPORTED").message).toMatch(/not allowed/);
    expect(expectErr(await media.upload({ ...png, contentType: "image/svg+xml" }), "UNSUPPORTED").status).toBe(415);
    expect(expectErr(await media.upload({ ...png, data: new TextEncoder().encode("<svg/>") }), "UNSUPPORTED").message).toMatch(/image\/svg\+xml/);
    expect(expectErr(await media.upload({ ...png, data: new Uint8Array(11) }), "PAYLOAD_TOO_LARGE").status).toBe(413);
  });

  it("stores an image with the type its content has when the declared type differs", async () => {
    const { media, blobs } = await make();
    const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const item = expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: signature })).item;
    expect(item.contentType).toBe("image/png");
    expect(item.filename).toBe("photo.png");
    expect(blobs.blobs.get(item.key)?.contentType).toBe("image/png");
  });

  it("reads bytes back and removes blob and metadata together", async () => {
    const { media, blobs } = await make();
    const item = expectOk(await media.upload(png)).item;
    expect(Array.from(expectOk(await media.read(item.id))?.data ?? [])).toEqual([1, 2, 3]);
    expectOk(await media.remove(item.id));
    expect(blobs.blobs.size).toBe(0);
    expect(expectOk(await media.get(item.id))).toBeNull();
    expectOk(await media.remove(item.id));
  });

  it("toPublicItem projects the public shape and never exposes key, checksum, status or location", async () => {
    const { media } = await make();
    const item = expectOk(await media.upload(png)).item;
    const pub = media.toPublicItem(item);
    expect(pub).toEqual({ id: item.id, path: `/media/${item.id}/evil-name.png`, filename: "evil-name.png", folder: "", contentType: "image/png", size: 3, createdAt: 7, updatedAt: 7, provenance: { origin: "unknown" }, width: null, height: null, alt: null, title: null, description: null });
    expect(Object.keys(pub)).not.toEqual(expect.arrayContaining(["key", "checksum", "status", "location"]));
  });

  describe("nameFor", () => {
    it("replaces a known content type's extension, keeping the display stem", () => {
      expect(nameFor("Photo 1.JPG", "image/jpeg")).toBe("Photo-1.jpg");
      expect(nameFor("a.tif", "image/png")).toBe("a.png");
    });

    it("takes the extension from the stored type, never from the uploaded name, and gives an unknown type .bin", () => {
      expect(nameFor("x.html", "image/x-foo")).toBe("x-html.bin");
      expect(nameFor("weird.xyz", "application/x-unknown")).toBe("weird-xyz.bin");
      expect(nameFor("page.html", "text/html")).toBe("page-html.bin");
      expect(nameFor("app.js", "text/javascript")).toBe("app-js.bin");
      expect(nameFor("app.js", "application/javascript")).toBe("app-js.bin");
      expect(nameFor("x.svg", "image/png")).toBe("x.png");
      expect(nameFor("x.svg", "image/x-foo")).toBe("x-svg.bin");
    });

    it("leaves no second extension in the name", () => {
      expect(nameFor("x.html.png", "image/png")).toBe("x-html.png");
      expect(nameFor("a.png.html", "image/png")).toBe("a-png.png");
      expect(nameFor("a.png.html", "image/x-foo")).toBe("a-png-html.bin");
      expect(nameFor("archive.tar.gz", "application/gzip")).toBe("archive-tar-gz.bin");
      expect(nameFor("x.meta.name", "application/json")).toBe("x-meta.json");
      expect(nameFor("a.kestrel-tmp", "application/x-unknown")).toBe("a-kestrel-tmp.bin");
      for (const name of [nameFor("a.b.c.d", "image/png"), nameFor("...x", "text/html"), nameFor("x.", "image/x-foo")]) expect(name.split(".")).toHaveLength(2);
    });

    it("is not fooled by case in the uploaded extension or the declared type", () => {
      expect(nameFor("X.HTML", "image/x-foo")).toBe("X-HTML.bin");
      expect(nameFor("x.HtMl", "IMAGE/PNG")).toBe("x.png");
      expect(nameFor("drawing.SVG", "IMAGE/SVG+XML; charset=utf-8", true)).toBe("drawing.svg");
      expect(nameFor("x.svg", "Image/Svg")).toBe("x-svg.bin");
    });

    it("gives an SVG its own extension only when its bytes passed sanitize.svg", () => {
      expect(nameFor("logo.svg", "image/svg+xml", true)).toBe("logo.svg");
      expect(nameFor("logo.svg", "image/svg+xml")).toBe("logo-svg.bin");
      expect(nameFor("logo.svg", "image/svg+xml", false)).toBe("logo-svg.bin");
    });

    it("keeps the extension of a common document or archive type", () => {
      expect(nameFor("Report Q3.DOCX", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("Report-Q3.docx");
      expect(nameFor("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("sheet.xlsx");
      expect(nameFor("slides.odp", "application/vnd.oasis.opendocument.presentation")).toBe("slides.odp");
      expect(nameFor("bundle.zip", "application/x-zip-compressed")).toBe("bundle.zip");
    });

    it("never names a file like the variants directory or the download route next to it", () => {
      expect(nameFor("variants", "application/x-unknown")).toBe("variants.bin");
      expect(nameFor("file", "application/x-unknown")).toBe("file.bin");
      expect(nameFor("", "application/x-unknown")).toBe("file.bin");
      expect(nameFor("variants.png", "image/png")).toBe("variants.png");
      expect(nameFor("file", "image/png")).toBe("file.png");
    });

    it("still caps the result at 200 bytes", () => {
      expect(Buffer.byteLength(nameFor(`${"a".repeat(500)}.tif`, "image/png"))).toBe(200);
      expect(Buffer.byteLength(nameFor(`${"a".repeat(500)}.html`, "image/x-foo"))).toBe(200);
    });
  });

  describe("the public copy of a file whose type is not a known inert one", () => {
    const allowAll = { ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: ["image/svg+xml"], maxBytes: 100, publicCopy: { prefix: "site/" } };
    const cases: Array<[string, string, string, string]> = [
      ["x.html", "image/x-foo", "text/html", "x-html.bin"],
      ["x.html", "text/html", "text/html", "x-html.bin"],
      ["X.XHTML", "application/xhtml+xml", "application/xhtml+xml", "X-XHTML.bin"],
      ["app.js", "text/javascript", "text/javascript", "app-js.bin"],
      ["feed.xml", "application/xml", "application/xml", "feed-xml.bin"],
      ["x.svg.html", "text/html; charset=utf-8", "text/html; charset=utf-8", "x-svg-html.bin"],
    ];
    for (const [filename, contentType, stored, name] of cases) {
      it(`${filename} sent as ${contentType} is published as ${name}, application/octet-stream`, async () => {
        const { media, blobs } = await make(allowAll);
        const item = expectOk(await media.upload({ filename, contentType, data: new TextEncoder().encode("<script>alert(1)</script>") })).item;
        expect(media.toPublicItem(item).path).toBe(`/media/${item.id}/${name}`);
        expect(blobs.blobs.get(`site/media/${item.id}/${name}`)?.contentType).toBe("application/octet-stream");
        expect(item.contentType).toBe(stored);
        expect(blobs.blobs.get(item.key)?.contentType).toBe(stored);
        expect([...blobs.blobs.keys()].filter((key) => key.startsWith(`site/media/${item.id}/`))).toEqual([`site/media/${item.id}/${name}`]);
      });
    }

    it("a known inert type keeps its own type in the public copy, a text type its charset too, and no other parameter", async () => {
      const { media, blobs } = await make(allowAll);
      const cases: Array<[string, string, string, string]> = [
        ["notes.TXT", "Text/Plain; Charset=UTF-8; format=flowed", "text/plain; charset=utf-8", "notes.txt"],
        ["table.csv", 'text/csv; charset="utf-8"', "text/csv", "table.csv"],
        ["data.json", "application/json; charset=utf-8", "application/json", "data.json"],
      ];
      for (const [filename, contentType, published, name] of cases) {
        const item = expectOk(await media.upload({ filename, contentType, data: new Uint8Array([1]) })).item;
        expect(item.contentType).toBe(published);
        expect(blobs.blobs.get(item.key)?.contentType).toBe(published);
        expect(blobs.blobs.get(`site/media/${item.id}/${name}`)?.contentType).toBe(published);
      }
    });

    it("syncPublic rewrites such a copy with the neutral type too", async () => {
      const { media, blobs } = await make(allowAll);
      const item = expectOk(await media.upload({ filename: "x.html", contentType: "image/x-foo", data: new Uint8Array([1, 2]) })).item;
      blobs.blobs.delete(`site/media/${item.id}/x-html.bin`);
      expectOk(await media.syncPublic());
      expect(blobs.blobs.get(`site/media/${item.id}/x-html.bin`)?.contentType).toBe("application/octet-stream");
    });
  });

  describe("a declared type that is not exactly one media type", () => {
    const withCopy = { ...BASE_CONFIG, maxBytes: 100, publicCopy: { prefix: "site/" } };

    for (const contentType of ["image/png; x=1, text/html", "image/x-foo, text/html", ""]) {
      it(`an upload declared as ${JSON.stringify(contentType)} is refused as UNSUPPORTED and stores nothing`, async () => {
        const { media, blobs, db } = await make({ ...withCopy, allowedTypes: ["*"] });
        expect(expectErr(await media.upload({ filename: "a.png", contentType, data: new Uint8Array([1]) }), "UNSUPPORTED").status).toBe(415);
        expect(expectOk(await db.count(COLLECTION, {}))).toBe(0);
        expect(blobs.blobs.size).toBe(0);
      });
    }

    it("an upload stores and publishes only the lower-cased type/subtype, whatever its case or parameters", async () => {
      const { media, blobs } = await make(withCopy);
      for (const [filename, contentType] of [["upper.png", "IMAGE/PNG"], ["params.png", "image/png; x=1"]] as const) {
        const item = expectOk(await media.upload({ filename, contentType, data: new Uint8Array([1]) })).item;
        expect(item.contentType).toBe("image/png");
        expect(blobs.blobs.get(item.key)?.contentType).toBe("image/png");
        expect(blobs.blobs.get(`site/media/${item.id}/${filename}`)?.contentType).toBe("image/png");
      }
    });

    const stored: Array<[string, string, string]> = [
      ["image/png; x=1, text/html", "a-png.bin", "application/octet-stream"],
      ["image/x-foo, text/html", "a-png.bin", "application/octet-stream"],
      ["", "a-png.bin", "application/octet-stream"],
      ["IMAGE/PNG", "a.png", "image/png"],
      ["image/png; x=1", "a.png", "image/png"],
    ];
    for (const [contentType, name, published] of stored) {
      it(`a row already stored as ${JSON.stringify(contentType)} is published as ${name}, ${published}`, async () => {
        const blobs = fakeBlobstore();
        const db = createFakePersistence();
        const media = await createMediaDefault(withCopy, blobs, db, noLogger, () => 7);
        await seedRow(db, blobs, { id: "r1", key: "media/r1/a.png", contentType });
        if (name !== "a.png") expectOk(await blobs.put("site/media/r1/a.png", new Uint8Array([1, 2, 3]), { contentType }));
        expectOk(await media.syncPublic());
        expect([...blobs.blobs.keys()].filter((key) => key.startsWith("site/"))).toEqual([`site/media/r1/${name}`]);
        expect(blobs.blobs.get(`site/media/r1/${name}`)?.contentType).toBe(published);
        const item = expectOk(await media.get("r1"));
        expect(item === null ? null : media.toPublicItem(item).path).toBe(`/media/r1/${name}`);
        expect(expectOk(await media.serveFile("r1", name))).not.toBeNull();
      });
    }
  });

  describe("a stored public name", () => {
    const withCopy: Config = { ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, publicCopy: { prefix: "site/" } };
    const copies = (blobs: ReturnType<typeof fakeBlobstore>): string[] => [...blobs.blobs.keys()].filter((key) => key.startsWith("site/"));

    it("stored as .bin while its type was not listed, keeps that name and application/octet-stream once the list holds the type", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      const media = await createMediaDefault(withCopy, blobs, db, noLogger, () => 7);
      await seedRow(db, blobs, { id: "a1", key: "media/a1/archive-7z.bin", contentType: "application/x-7z-compressed" });
      expectOk(await blobs.put("site/media/a1/archive-7z.bin", new Uint8Array([1, 2, 3]), { contentType: "application/octet-stream" }));
      expect(expectOk(await media.syncPublic())).toEqual({ written: 0, removed: 0, missing: 0 });
      expect(copies(blobs)).toEqual(["site/media/a1/archive-7z.bin"]);
      expect(blobs.blobs.get("site/media/a1/archive-7z.bin")?.contentType).toBe("application/octet-stream");
      const item = expectOk(await media.get("a1"));
      expect(item === null ? null : publishedFileOf(item)).toEqual({ name: "archive-7z.bin", contentType: "application/octet-stream" });
      expect(item === null ? null : media.toPublicItem(item).path).toBe("/media/a1/archive-7z.bin");
      expect(expectOk(await media.serveFile("a1", "archive-7z.bin"))).not.toBeNull();
      expect(expectOk(await media.serveFile("a1", "archive-7z-bin.7z"))).toBeNull();
    });

    it("uploaded under an unlisted type, keeps its name, type and copy when the list learns the type later", async () => {
      const list = boundaryCast<Record<string, string>>(EXTENSION_BY_TYPE, "host");
      const { media, blobs } = await make(withCopy);
      const item = expectOk(await media.upload({ filename: "scene.kst", contentType: "application/x-kestrel-scene", data: new Uint8Array([1, 2]) })).item;
      expect(copies(blobs)).toEqual([`site/media/${item.id}/scene-kst.bin`]);
      list["application/x-kestrel-scene"] = "kst";
      try {
        expect(expectOk(await media.syncPublic())).toEqual({ written: 0, removed: 0, missing: 0 });
        expect(copies(blobs)).toEqual([`site/media/${item.id}/scene-kst.bin`]);
        expect(blobs.blobs.get(`site/media/${item.id}/scene-kst.bin`)?.contentType).toBe("application/octet-stream");
        expect(media.toPublicItem(item).path).toBe(`/media/${item.id}/scene-kst.bin`);
        expect(publishedFileOf(item)).toEqual({ name: "scene-kst.bin", contentType: "application/octet-stream" });
      } finally {
        delete list["application/x-kestrel-scene"];
      }
    });

    it("is demoted to .bin only when its extension is not the one its type may be published with", () => {
      expect(publishedFileOf({ key: "media/a/logo.svg", contentType: "image/svg+xml", svgSanitized: true })).toEqual({ name: "logo.svg", contentType: "image/svg+xml" });
      expect(publishedFileOf({ key: "media/a/logo.svg", contentType: "image/svg+xml", svgSanitized: false })).toEqual({ name: "logo-svg.bin", contentType: "application/octet-stream" });
      expect(publishedFileOf({ key: "media/a/a.png", contentType: "image/png; x=1, text/html" })).toEqual({ name: "a-png.bin", contentType: "application/octet-stream" });
      expect(publishedFileOf({ key: "media/a/notes.txt", contentType: "text/plain; charset=utf-8" })).toEqual({ name: "notes.txt", contentType: "text/plain; charset=utf-8" });
      expect(publishedFileOf({ key: "media/a/page-html.bin", contentType: "text/html" })).toEqual({ name: "page-html.bin", contentType: "application/octet-stream" });
    });
  });

  describe("an SVG's public copy", () => {
    const svgAllowed: Config = { ...BASE_CONFIG, allowedTypes: ["image/*"], deniedTypes: [], maxBytes: 1000 };
    const svg = { filename: "logo.svg", contentType: "image/svg+xml", data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>') };
    const serve = { pipeline: "serveMediaFile", module: "media/default", step: "media.serve" };
    const sanitize = { pipeline: "uploadMedia", module: "sanitize/svg", step: "sanitize.svg", writes: ["files"] };
    const upload = { pipeline: "uploadMedia", module: "media/default", step: "media.upload" };
    const warningsInto = (warnings: Array<{ message: string; data: unknown }>): Logger => ({ step() {}, info() {}, warn: (message, data) => warnings.push({ message, data }), error() {} });

    it("uploaded while publicCopy was off and unsanitised, it is published as .bin and application/octet-stream once publicCopy and sanitize.svg are on", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      const before = await createMediaDefault(svgAllowed, blobs, db, noLogger, () => 7);
      const observers: RunObserver[] = [];
      before.attach(introspectionOf(manifestWithPipelines([{ pipeline: "importMedia", module: "media/default", step: "media.upload" }]), observers));
      const leave = atUpload(observers, "run-1", "importMedia");
      const item = expectOk(await before.upload(svg, "", undefined, before.sanitizesSvg("run-1"))).item;
      leave();
      expect(item.svgSanitized).toBe(false);
      const warnings: Array<{ message: string; data: unknown }> = [];
      const after = await createMediaDefault({ ...svgAllowed, publicCopy: { prefix: "site/" } }, blobs, db, warningsInto(warnings), () => 8);
      after.attach(introspectionOf(manifestWithPipelines([serve, sanitize, upload])));
      expectOk(await after.syncPublic());
      expect([...blobs.blobs.keys()].filter((key) => key.startsWith("site/"))).toEqual([`site/media/${item.id}/logo-svg.bin`]);
      expect(blobs.blobs.get(`site/media/${item.id}/logo-svg.bin`)?.contentType).toBe("application/octet-stream");
      expect(after.toPublicItem(item).path).toBe(`/media/${item.id}/logo-svg.bin`);
      expect(warnings).toEqual([{ message: expect.stringContaining(item.id) as unknown, data: { id: item.id } }]);
    });

    it("a row that does not record sanitize.svg is published as .bin, and its raw .svg copy is removed", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      const warnings: Array<{ message: string; data: unknown }> = [];
      const media = await createMediaDefault({ ...svgAllowed, publicCopy: { prefix: "site/" } }, blobs, db, warningsInto(warnings), () => 7);
      media.attach(introspectionOf(manifestWithPipelines([serve, sanitize, upload])));
      await seedRow(db, blobs, { id: "s1", key: "media/s1/logo.svg", contentType: "image/svg+xml" });
      expectOk(await blobs.put("site/media/s1/logo.svg", new Uint8Array([1, 2, 3]), { contentType: "image/svg+xml" }));
      expectOk(await media.syncPublic());
      expect([...blobs.blobs.keys()].filter((key) => key.startsWith("site/"))).toEqual(["site/media/s1/logo-svg.bin"]);
      expect(blobs.blobs.get("site/media/s1/logo-svg.bin")?.contentType).toBe("application/octet-stream");
      expect(expectOk(await media.serveFile("s1", "logo.svg"))).toBeNull();
      expect(expectOk(await media.serveFile("s1", "logo-svg.bin"))).not.toBeNull();
      expect(warnings.map((w) => w.data)).toEqual([{ id: "s1" }]);
    });

    it("uploaded through a pipeline that runs sanitize.svg before media.upload, it is published as image/svg+xml", async () => {
      const { media, blobs } = await make({ ...svgAllowed, publicCopy: { prefix: "site/" } });
      const observers: RunObserver[] = [];
      media.attach(introspectionOf(manifestWithPipelines([serve, sanitize, upload]), observers));
      const leave = atUpload(observers, "run-1", "uploadMedia");
      expect(media.sanitizesSvg("run-1")).toBe(true);
      const item = expectOk(await media.upload(svg, "", undefined, media.sanitizesSvg("run-1"))).item;
      leave();
      expect(media.sanitizesSvg("run-1")).toBe(false);
      expect(item.svgSanitized).toBe(true);
      expect(media.toPublicItem(item).path).toBe(`/media/${item.id}/logo.svg`);
      expect(blobs.blobs.get(`site/media/${item.id}/logo.svg`)?.contentType).toBe("image/svg+xml");
      blobs.blobs.delete(`site/media/${item.id}/logo.svg`);
      expectOk(await media.syncPublic());
      expect(blobs.blobs.get(`site/media/${item.id}/logo.svg`)?.contentType).toBe("image/svg+xml");
    });

    it("counts a run as sanitising only at media.upload of a pipeline whose sanitize.svg no later step overwrites the files after", async () => {
      const { media } = await make(svgAllowed);
      const observers: RunObserver[] = [];
      const rewrite = { pipeline: "rewriteMedia", module: "probe/files", step: "probe.rename", writes: ["files"] };
      media.attach(introspectionOf(manifestWithPipelines([
        sanitize, upload,
        { pipeline: "importMedia", module: "media/default", step: "media.upload" },
        { ...sanitize, pipeline: "rewriteMedia" }, rewrite, { ...upload, pipeline: "rewriteMedia" },
        { ...sanitize, pipeline: "reportMedia" }, { pipeline: "reportMedia", module: "probe/files", step: "probe.count", writes: ["result"] }, { ...upload, pipeline: "reportMedia" },
      ]), observers));
      atUpload(observers, "a", "uploadMedia");
      atUpload(observers, "b", "importMedia");
      atUpload(observers, "c", "rewriteMedia");
      atUpload(observers, "d", "reportMedia");
      atUpload(observers, "e", "uploadMedia", "sanitize.svg");
      expect(["a", "b", "c", "d", "e"].map((runId) => media.sanitizesSvg(runId))).toEqual([true, false, false, true, false]);
      const png = expectOk(await media.upload({ filename: "x.png", contentType: "image/png", data: new Uint8Array([1]) }, "", undefined, true)).item;
      expect(png.svgSanitized).toBe(false);
    });
  });

  it("reads */* like *: as allowedTypes it accepts any upload, as deniedTypes it refuses every one and counts as denying SVG at boot", async () => {
    const anything = await make({ ...BASE_CONFIG, allowedTypes: ["*/*"], deniedTypes: [] });
    expect(expectOk(await anything.media.upload({ ...png, filename: "notes.txt", contentType: "text/plain" })).item.contentType).toBe("text/plain");
    expectOk(await anything.media.upload(png));
    const nothing = await make({ ...BASE_CONFIG, allowedTypes: ["image/*"], deniedTypes: ["*/*"], publicCopy: { prefix: "site/" } });
    expect(expectErr(await nothing.media.upload(png), "UNSUPPORTED").status).toBe(415);
    const serve = { pipeline: "serveMediaFile", module: "media/default", step: "media.serve" };
    const upload = { pipeline: "importMedia", module: "media/default", step: "media.upload" };
    expect(() => nothing.media.attach(introspectionOf(manifestWithPipelines([serve, upload])))).not.toThrow();
    const svgAllowed = await make({ ...BASE_CONFIG, allowedTypes: ["*/*"], deniedTypes: [], publicCopy: { prefix: "site/" } });
    expect(() => svgAllowed.media.attach(introspectionOf(manifestWithPipelines([serve, upload])))).toThrow(/pipeline "importMedia" runs media\.upload without sanitize\.svg before it/);
  });

  it("matches allowed and denied types on the media type alone, whatever its parameters or case", async () => {
    const { media } = await make();
    expect(expectErr(await media.upload({ ...png, contentType: "image/svg+xml; charset=utf-8" }), "UNSUPPORTED").status).toBe(415);
    expect(expectErr(await media.upload({ ...png, contentType: "IMAGE/SVG+XML" }), "UNSUPPORTED").status).toBe(415);
    expectOk(await media.upload({ ...png, contentType: "image/png; x=1" }));
    const { media: exact } = await make({ ...BASE_CONFIG, allowedTypes: ["application/pdf"], deniedTypes: [] });
    expectOk(await exact.upload({ ...png, filename: "a.pdf", contentType: "Application/PDF; version=1.7" }));
  });

  describe("an upload abandoned while it stalls", () => {
    it("without publicCopy, a later upload of the same name releases an upload stuck longer than uploadStaleAfterMs", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      let clock = 0;
      const media = await createMediaDefault({ ...BASE_CONFIG, uploadStaleAfterMs: 60000 }, blobs, db, noLogger, () => clock);
      const put = blobs.put.bind(blobs);
      blobs.put = async () => {
        throw new Error("disk gone");
      };
      await expect(media.upload(png)).rejects.toThrow("disk gone");
      blobs.put = put;
      const stuck = expectOk(await db.findMany<{ id: string; status: string }>(COLLECTION, {})).items;
      expect(stuck.map((row) => row.status)).toEqual(["uploading"]);
      clock = 30000;
      expectErr(await media.upload(png), "CONFLICT");
      clock = 61000;
      const item = expectOk(await media.upload(png)).item;
      expect(item.status).toBe("ready");
      expect(expectOk(await db.findMany<{ id: string; status: string }>(COLLECTION, {})).items.map((row) => row.status)).toEqual(["ready"]);
    });

    it("answers TRANSIENT and leaves neither a ready row nor its files when syncPublic abandoned it meanwhile", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      let clock = 0;
      const media = await createMediaDefault({ ...BASE_CONFIG, publicCopy: { prefix: "site/" }, uploadStaleAfterMs: 60000 }, blobs, db, noLogger, () => clock);
      const put = blobs.put.bind(blobs);
      let release: () => void = () => {};
      const stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached: () => void = () => {};
      const atCopy = new Promise<void>((resolve) => {
        reached = resolve;
      });
      blobs.put = async (key, data, options) => {
        if (key.startsWith("site/")) {
          reached();
          await stalled;
        }
        return put(key, data, options);
      };
      const uploading = media.upload(png);
      await atCopy;
      clock = 61000;
      expectOk(await media.syncPublic());
      release();
      expectErr(await uploading, "TRANSIENT");
      const rows = expectOk(await db.findMany<{ status: string; key: string; id: string }>(COLLECTION, {})).items;
      expect(rows.map((row) => row.status)).toEqual(["failed"]);
      expect([...blobs.blobs.keys()]).toEqual([]);
      blobs.put = put;
      clock = 62000;
      const retried = expectOk(await media.upload(png)).item;
      expect(retried.status).toBe("ready");
      expect(expectOk(await db.count(COLLECTION, {}))).toBe(1);
    });

    it("a syncPublic that finds a stale upload finished meanwhile keeps it ready with its copy and blob", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      const media = await createMediaDefault({ ...BASE_CONFIG, publicCopy: { prefix: "site/" }, uploadStaleAfterMs: 60000 }, blobs, db, noLogger, () => 61000);
      const row = expectOk(await db.createOne<Document>(COLLECTION, { filename: "a.png", folder: "", location: "a.png", contentType: "image/png", size: 3, key: "media/u1/a.png", checksum: "x", status: "uploading", createdAt: 0, updatedAt: 0, provenance: { origin: "unknown" }, width: null, height: null, alt: {}, title: {}, description: {}, id: "u1" }));
      expectOk(await blobs.put("media/u1/a.png", new Uint8Array([1, 2, 3]), { contentType: "image/png" }));
      expectOk(await blobs.put("site/media/u1/a.png", new Uint8Array([1, 2, 3]), { contentType: "image/png" }));
      const updateMany = db.updateMany.bind(db);
      let finished = false;
      db.updateMany = async (collection, filter, patch) => {
        if (!finished && collection === COLLECTION && (patch as { status?: string }).status === "failed") {
          finished = true;
          expect(expectOk(await updateMany(COLLECTION, { id: row.id, status: "uploading" }, { status: "ready" }))).toBe(1);
        }
        return updateMany(collection, filter, patch);
      };
      expectOk(await media.syncPublic());
      expect(finished).toBe(true);
      const after = expectOk(await db.findOne<{ id: string; status: string }>(COLLECTION, { id: row.id }));
      expect(after?.status).toBe("ready");
      expect(blobs.blobs.has("media/u1/a.png")).toBe(true);
      expect(blobs.blobs.has("site/media/u1/a.png")).toBe(true);
    });
  });

  it("urlNameOf reads the last path segment of a key", () => {
    expect(urlNameOf("media/id-1/photo.jpg")).toBe("photo.jpg");
    expect(urlNameOf("photo.jpg")).toBe("photo.jpg");
  });

  it("publicTreeOf combines the copy prefix and publicPath", () => {
    expect(publicTreeOf({ publicPath: "/media", publicCopy: { prefix: "site/" } })).toBe("site/media/");
    expect(publicTreeOf({ publicPath: "/media", publicCopy: undefined })).toBe("media/");
  });

  it("renaming and moving change metadata only: the key, path and blob are untouched (zero blob calls)", async () => {
    const blobs = fakeBlobstore();
    let calls = 0;
    const countingBlobs: Blobstore = { ...blobs, put: (...a) => { calls += 1; return blobs.put(...a); }, remove: (...a) => { calls += 1; return blobs.remove(...a); }, move: (...a) => { calls += 1; return blobs.move(...a); } };
    const media = await createMediaDefault(BASE_CONFIG, countingBlobs, createFakePersistence(), noLogger, () => 7);
    const item = expectOk(await media.upload(png, "2026/press")).item;
    expect(item.folder).toBe("2026/press");
    calls = 0;
    const moved = expectOk(await media.update(item.id, { filename: "Hero Image.png", folder: "/archive/" }));
    expect(moved).toMatchObject({ filename: "Hero-Image.png", folder: "archive", key: item.key, location: "archive/Hero-Image.png" });
    expect(calls).toBe(0);
    expect(blobs.blobs.size).toBe(1);
    expect(blobs.blobs.has(item.key)).toBe(true);
    expect(expectOk(await media.list({ folder: "archive" })).total).toBe(1);
    expect(expectOk(await media.list({ folder: "2026/press" })).total).toBe(0);
    expect(expectErr(await media.update(item.id, { folder: "../x" }), "VALIDATION").message).toMatch(/invalid folder/);
    expect(expectOk(await media.update("missing", { filename: "x" }))).toBeNull();
  });

  it("defaults provenance to unknown and accepts origin strings or objects", async () => {
    const { media } = await make();
    expect(expectOk(await media.upload(png)).item.provenance).toEqual({ origin: "unknown" });
    expect(expectOk(await media.upload({ ...png, filename: "human.png" }, "", "human")).item.provenance).toEqual({ origin: "human" });
    expect(expectOk(await media.upload({ ...png, filename: "ai.png" }, "", "ai")).item.provenance).toEqual({ origin: "ai" });
    expect(expectOk(await media.upload({ ...png, filename: "mixed.png" }, "", '{"origin":"mixed","tool":"editor","model":"x-1","at":5}')).item.provenance).toEqual({ origin: "mixed", tool: "editor", model: "x-1", at: 5 });
    expect(expectErr(await media.upload({ ...png, filename: "robot.png" }, "", "robot"), "VALIDATION").message).toMatch(/origin must be/);
    expect(expectOk(parseProvenance({ origin: "ai", tool: "" }))).toEqual({ origin: "ai" });
    const item = expectOk(await media.upload({ ...png, filename: "plain.png" })).item;
    expect(expectOk(await media.update(item.id, { provenance: { origin: "ai", model: "m" } }))?.provenance).toEqual({ origin: "ai", model: "m" });
    expect(expectOk(await media.list()).items.every((i) => i.provenance.origin !== undefined)).toBe(true);
  });

  it("searches, sorts, filters folders recursively and lists folders", async () => {
    const blobs = fakeBlobstore();
    let t = 0;
    const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], defaultLocale: undefined }, blobs, createFakePersistence(), noLogger, () => ++t);
    const a = expectOk(await media.upload({ ...png, filename: "alpha.png" }, "2026/press")).item;
    const b = expectOk(await media.upload({ ...png, filename: "beta.png", data: new Uint8Array(10) }, "2026")).item;
    const c = expectOk(await media.upload({ ...png, filename: "gamma.png" }, "archive")).item;
    expect(expectOk(await media.list({ q: "ALPH" })).items.map((i) => i.id)).toEqual([a.id]);
    expect(expectOk(await media.list({ q: "alph" })).items.map((i) => i.id)).toEqual([a.id]);
    expect(expectOk(await media.list({ folder: "2026", recursive: true, q: "ALPH" })).items.map((i) => i.id)).toEqual([a.id]);
    expect(expectOk(await media.list({ folder: "2026", recursive: true, q: "alph" })).items.map((i) => i.id)).toEqual([a.id]);
    expect(expectOk(await media.list({ sortBy: "filename" })).items.map((i) => i.filename)).toEqual(["alpha.png", "beta.png", "gamma.png"]);
    expect(expectOk(await media.list({ sortBy: "size", direction: "desc" })).items[0]?.id).toBe(b.id);
    expect(expectOk(await media.list({ folder: "2026" })).items.map((i) => i.id)).toEqual([b.id]);
    expect(expectOk(await media.list({ folder: "2026", recursive: true })).items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect(expectOk(await media.folders())).toEqual([{ folder: "2026", count: 1 }, { folder: "2026/press", count: 1 }, { folder: "archive", count: 1 }]);
    expect(expectOk(await media.byIds([c.id, "missing", a.id])).map((i) => i.id)).toEqual([c.id, a.id]);
    expect(expectOk(await media.byIds([]))).toEqual([]);
  });

  it("filters by canonical media kind, in the plain list, combined with a text query, and in a recursive folder listing", async () => {
    const blobs = fakeBlobstore();
    let t = 0;
    const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], defaultLocale: undefined }, blobs, createFakePersistence(), noLogger, () => ++t);
    const photo = expectOk(await media.upload({ filename: "photo.png", contentType: "image/png", data: new Uint8Array([1]) }, "2026")).item;
    const clip = expectOk(await media.upload({ filename: "clip.mp4", contentType: "video/mp4", data: new Uint8Array([1]) }, "2026")).item;
    const clip2 = expectOk(await media.upload({ filename: "clip2.mp4", contentType: "video/mp4", data: new Uint8Array([1]) }, "2026")).item;
    const sheet = expectOk(await media.upload({ filename: "sheet.pdf", contentType: "application/pdf", data: new Uint8Array([1]) })).item;
    const readme = expectOk(await media.upload({ filename: "readme.txt", contentType: "text/plain", data: new Uint8Array([1]) })).item;

    expect(expectOk(await media.list({ mediaKind: "image" })).items.map((i) => i.id)).toEqual([photo.id]);
    expect(expectOk(await media.list({ mediaKind: "video" })).items.map((i) => i.id).sort()).toEqual([clip.id, clip2.id].sort());
    expect(expectOk(await media.list({ mediaKind: "other" })).items.map((i) => i.id).sort()).toEqual([sheet.id, readme.id].sort());

    expect(expectOk(await media.list({ mediaKind: "image", q: "clip" })).items).toEqual([]);
    expect(expectOk(await media.list({ mediaKind: "video", q: "clip2" })).items.map((i) => i.id)).toEqual([clip2.id]);

    expect(expectOk(await media.list({ folder: "2026", recursive: true, mediaKind: "video" })).items.map((i) => i.id).sort()).toEqual([clip.id, clip2.id].sort());
    const recursivePage = expectOk(await media.list({ folder: "2026", recursive: true, mediaKind: "video", limit: 1, offset: 0 }));
    expect(recursivePage.total).toBe(2);
    expect(recursivePage.items).toHaveLength(1);

    const otherPage = expectOk(await media.list({ mediaKind: "other", limit: 1, offset: 0 }));
    expect(otherPage.total).toBe(2);
    expect(otherPage.items).toHaveLength(1);
  });

  it("an other filter counts and pages correctly past several scan batches, not just the first one", async () => {
    const blobs = fakeBlobstore();
    const persistence = createFakePersistence();
    let declared: Schema | undefined;
    const seeding: Persistence = {
      ...persistence,
      ensureCollection: (name, schema) => {
        if (name !== COLLECTION) return persistence.ensureCollection(name, schema);
        declared = schema;
        return persistence.ensureCollection(name, Object.fromEntries(Object.entries(schema).map(([field, raw]) => [field, typeof raw === "string" ? raw : raw.type])));
      },
    };
    const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], defaultLocale: undefined }, blobs, seeding, noLogger, () => 0);
    const total = 5200;
    const rows: NewDocument<Document>[] = Array.from({ length: total }, (_, i) => ({
      id: `other-${String(i).padStart(5, "0")}`,
      filename: `file-${i}.pdf`,
      folder: "",
      location: `/file-${i}.pdf`,
      contentType: "application/pdf",
      size: 10,
      key: `key-${i}`,
      checksum: `sum-${i}`,
      status: "ready",
      createdAt: i,
      updatedAt: i,
    }));
    expectOk(await persistence.createMany(COLLECTION, rows));
    expectOk(await persistence.ensureCollection(COLLECTION, declared!));

    const page = expectOk(await media.list({ mediaKind: "other", limit: 10, offset: 0 }));
    expect(page.total).toBe(total);
    expect(page.items).toHaveLength(10);

    const lastPage = expectOk(await media.list({ mediaKind: "other", limit: 10, offset: total - 5 }));
    expect(lastPage.items).toHaveLength(5);
  });

  it("recursive list matches the exact subtree, not a LIKE prefix or byte range", async () => {
    const blobs = fakeBlobstore();
    let t = 0;
    const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], defaultLocale: undefined }, blobs, createFakePersistence(), noLogger, () => ++t);
    const a = expectOk(await media.upload({ ...png, filename: "a.png" }, "2026")).item;
    const b = expectOk(await media.upload({ ...png, filename: "b.png" }, "2026/presse")).item;
    expectOk(await media.upload({ ...png, filename: "c.png" }, "2026x"));
    expectOk(await media.upload({ ...png, filename: "d.png" }, "2026-alt"));
    const found = expectOk(await media.list({ folder: "2026", recursive: true }));
    expect(found.items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect(found.total).toBe(2);
  });

  it("stores localized texts, resolves them per locale and bumps updatedAt", async () => {
    const { media } = await make();
    const item = expectOk(await media.upload(png)).item;
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
  });

  it("takes the texts as plain text: markup stays intact, control characters and overlong values are rejected", async () => {
    const { media } = await make();
    const item = expectOk(await media.upload(png)).item;
    const kept = expectOk(await media.update(item.id, { alt: "5 < 6 & 7 > 6", description: "Zeile 1\nZeile 2\tEnde" }));
    expect(kept).toMatchObject({ alt: "5 < 6 & 7 > 6", description: "Zeile 1\nZeile 2\tEnde" });
    for (const field of ["alt", "title", "description"] as const) {
      expect(expectErr(await media.update(item.id, { [field]: "a\u0000b" }), "VALIDATION").message).toMatch(new RegExp(`${field} must be plain text \\(max 2000 chars\\)`));
    }
  });

  it("reads image dimensions from the file header", async () => {
    const { media } = await make({ ...BASE_CONFIG, allowedTypes: ["image/*"], deniedTypes: [], maxBytes: 1000, locales: [] });
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x01, 0x40, 0, 0, 0, 0xf0]);
    expect(expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: pngHeader })).item).toMatchObject({ width: 320, height: 240 });
  });

  it("lists newest first", async () => {
    const blobs = fakeBlobstore();
    let t = 0;
    const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], defaultLocale: undefined }, blobs, createFakePersistence(), noLogger, () => ++t);
    expectOk(await media.upload({ ...png, filename: "a.png" }));
    expectOk(await media.upload({ ...png, filename: "b.png" }));
    expect(expectOk(await media.list()).items.map((i) => i.filename)).toEqual(["b.png", "a.png"]);
  });

  it("location is <folder>/<name> and filenames are unique per folder via location, not the blob key", async () => {
    const { media, blobs } = await make();
    const a = expectOk(await media.upload(png, "2026/presse")).item;
    expect(a.location).toBe("2026/presse/evil-name.png");
    expect(a.key).toBe(`media/${a.id}/evil-name.png`);
    expect(blobs.blobs.has(a.key)).toBe(true);
    expect(expectErr(await media.upload({ ...png, data: new Uint8Array([9]) }, "2026/presse"), "CONFLICT").message).toMatch(/already exists/);
    const b = expectOk(await media.upload({ ...png, filename: "other.png" }, "2026/presse")).item;
    expectErr(await media.update(b.id, { filename: a.filename }), "CONFLICT");
  });

  describe("unique locations and idempotent re-upload", () => {
    it("declares media_items.location unique, so a second row with the same location is a CONFLICT naming the field", async () => {
      const { media, db } = await make();
      const a = expectOk(await media.upload(png)).item;
      const clash = expectErr(await db.createOne(COLLECTION, { filename: a.filename, folder: "", location: a.location, contentType: "image/png", size: 3, key: "media/other-id/evil-name.png", checksum: "other", status: "ready", createdAt: 1, updatedAt: 1, provenance: { origin: "unknown" }, width: null, height: null, alt: {}, title: {}, description: {} }), "CONFLICT");
      expect(clash.details).toMatchObject({ field: "location" });
      expect(expectOk(await db.count(COLLECTION, {}))).toBe(1);
    });

    it("returns the stored item for the same folder, filename and bytes, without a second row or blob write", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      let writes = 0;
      const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], defaultLocale: undefined }, { ...blobs, async put(key, data, options) { writes += 1; return blobs.put(key, data, options); } }, db, noLogger, () => 7);
      const first = expectOk(await media.upload(png, "presse"));
      expect(first.created).toBe(true);
      const again = expectOk(await media.upload(png, "presse"));
      expect(again.created).toBe(false);
      expect(again.item.id).toBe(first.item.id);
      expect(again.item.createdAt).toBe(first.item.createdAt);
      expect(writes).toBe(1);
      expect(expectOk(await db.count(COLLECTION, {}))).toBe(1);
      expect(blobs.blobs.size).toBe(1);
    });

    it("the same name with other bytes stays a CONFLICT, and so does a name still being uploaded", async () => {
      const { media, db } = await make();
      const a = expectOk(await media.upload(png)).item;
      expect(expectErr(await media.upload({ ...png, data: new Uint8Array([4, 5, 6]) }), "CONFLICT").status).toBe(409);
      expectOk(await db.updateOne(COLLECTION, a.id, { status: "uploading" }));
      expectErr(await media.upload(png), "CONFLICT");
    });
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

  it("renames a folder with its subtree, touching no blob, only folder and location", async () => {
    const blobs = fakeBlobstore();
    let calls = 0;
    const countingBlobs: Blobstore = { ...blobs, put: (...a) => { calls += 1; return blobs.put(...a); }, remove: (...a) => { calls += 1; return blobs.remove(...a); }, move: (...a) => { calls += 1; return blobs.move(...a); } };
    const db = createFakePersistence();
    const media = await createMediaDefault(BASE_CONFIG, countingBlobs, db, noLogger, () => 7);
    const a = expectOk(await media.upload(png, "alt")).item;
    const b = expectOk(await media.upload({ ...png, filename: "b.png" }, "alt/sub")).item;
    expectOk(await media.createFolder("alt/leer"));
    calls = 0;
    expect(expectOk(await media.renameFolder("alt", "neu/name"))).toEqual({ folder: "neu/name", moved: 2 });
    expect(calls).toBe(0);
    expect(expectOk(await media.get(a.id))?.key).toBe(a.key);
    expect(expectOk(await media.get(a.id))?.location).toBe("neu/name/evil-name.png");
    expect(expectOk(await media.get(b.id))?.folder).toBe("neu/name/sub");
    expect([...blobs.blobs.keys()].sort()).toEqual([a.key, b.key].sort());
    expect(expectOk(await db.findMany(FOLDERS, {})).items.map((r) => r.path).sort()).toEqual(["neu/name", "neu/name/leer", "neu/name/sub"]);
    expect(expectOk(await media.renameFolder("gibt-es-nicht", "x"))).toBeNull();
    expectOk(await media.createFolder("belegt"));
    expectErr(await media.renameFolder("neu", "belegt"), "CONFLICT");
  });

  it("rename pre-checks location conflicts before touching anything", async () => {
    const { media, blobs } = await make();
    const a = expectOk(await media.upload(png, "a")).item;
    const b = expectOk(await media.upload(png, "b")).item;
    expectErr(await media.renameFolder("a", "b"), "CONFLICT");
    expect([...blobs.blobs.keys()].sort()).toEqual([a.key, b.key].sort());
  });

  it("folderItems and removeFolder respect emptiness and recursion, and removeFolder returns ids", async () => {
    const { media, blobs, db } = await make();
    const a = expectOk(await media.upload(png, "x/y")).item;
    expectOk(await media.createFolder("x/z"));
    expect(expectOk(await media.folderItems("nope", false))).toBeNull();
    expect(expectErr(await media.folderItems("x", false), "CONFLICT").message).toMatch(/not empty/);
    expect(expectOk(await media.folderItems("x/z", false))).toEqual({ path: "x/z", ids: [] });
    expect(expectOk(await media.folderItems("x", true))).toEqual({ path: "x", ids: [a.id] });
    expect(expectOk(await media.removeFolder("x"))).toEqual({ ok: true, removed: 1, ids: [a.id] });
    expect(blobs.blobs.size).toBe(0);
    expect(expectOk(await db.count(COLLECTION, {}))).toBe(0);
    expect(expectOk(await db.count(FOLDERS, {}))).toBe(0);
    expect(expectOk(await media.removeFolder("x"))).toBeNull();
  });

  it("update() validates every field before touching the row", async () => {
    const { media, blobs } = await make();
    const item = expectOk(await media.upload(png, "a")).item;
    const patch: { filename?: string; alt?: string | null } = { filename: "b.png" };
    Object.assign(patch, { alt: 123 });
    expect(expectErr(await media.update(item.id, patch), "VALIDATION").message).toMatch(/must be a string/);
    expect(blobs.blobs.has(item.key)).toBe(true);
    expect(expectOk(await media.read(item.id))?.item.key).toBe(item.key);
  });

  it("neutralises a .meta.json suffix on upload so it cannot collide with a metadata sidecar", async () => {
    const { media } = await make();
    const item = expectOk(await media.upload({ ...png, filename: "evil.meta.json" })).item;
    expect(item.filename).toBe("evil-meta.png");
    expect(item.key).toBe(`media/${item.id}/evil-meta.png`);
    for (const name of ["x.meta.json", "x.META.JSON"]) expect(safeName(name).toLowerCase().endsWith(".meta.json")).toBe(false);
  });

  it("subtree operations match folder boundaries exactly, not SQL LIKE wildcards", async () => {
    const { media, blobs } = await make();
    const a = expectOk(await media.upload(png, "bilder_2026")).item;
    const b = expectOk(await media.upload({ ...png, filename: "b.png" }, "bilder_2026/presse")).item;
    expect(expectOk(await media.renameFolder("bilder_2026", "neu"))).toEqual({ folder: "neu", moved: 2 });
    expect(expectOk(await media.get(a.id))?.folder).toBe("neu");
    expect(expectOk(await media.get(b.id))?.folder).toBe("neu/presse");

    const c = expectOk(await media.upload({ ...png, filename: "c.png" }, "ab/x")).item;
    expect(expectOk(await media.folderItems("a_b", false))).toBeNull();
    expect(expectOk(await media.removeFolder("a_b"))).toBeNull();
    expect(expectOk(await media.renameFolder("a_b", "z"))).toBeNull();
    expect(expectOk(await media.get(c.id))?.folder).toBe("ab/x");
    expect(blobs.blobs.has(c.key)).toBe(true);
  });

  it("caps sanitised filenames at 200 bytes, keeping the extension", async () => {
    const long = safeName(`${"a".repeat(500)}.png`);
    expect(Buffer.byteLength(long)).toBe(200);
    expect(long.endsWith(".png")).toBe(true);
    const { media } = await make();
    expect(expectOk(await media.upload({ ...png, filename: `${"b".repeat(500)}.png` })).item.filename.length).toBe(200);
  });

  describe("two-phase upload", () => {
    it("records a sha256 checksum and a ready status, writing the row before the blob", async () => {
      const blobs = fakeBlobstore();
      const order: string[] = [];
      const db = createFakePersistence();
      const observed: Persistence = { ...db, async createOne<T extends Document>(collection: string, data: NewDocument<T>) { if (collection === COLLECTION) order.push(`row:${String(data.status)}`); return db.createOne<T>(collection, data); } };
      const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], defaultLocale: undefined }, { ...blobs, async put(key, data, options) { order.push("blob"); return blobs.put(key, data, options); } }, observed, noLogger, () => 7);
      const item = expectOk(await media.upload({ ...png, filename: "shot.png" })).item;
      expect(order).toEqual(["row:uploading", "blob"]);
      expect(item.status).toBe("ready");
      expect(item.checksum).toBe(createHash("sha256").update(png.data).digest("hex"));
    });

    it("marks the row failed when the blob write fails, hides it and frees the name again", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      let broken = true;
      const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], defaultLocale: undefined }, { ...blobs, async put(key, data, options) { if (broken) return err(failure("TRANSIENT", "blobstore down")); return blobs.put(key, data, options); } }, db, noLogger, () => 7);
      expect(expectErr(await media.upload({ ...png, filename: "shot.png" }), "TRANSIENT").message).toMatch(/blobstore down/);
      const stored = expectOk(await db.findOne<{ id: string; status: string }>(COLLECTION, {}));
      expect(stored?.status).toBe("failed");
      expect(expectOk(await media.get(stored!.id))).toBeNull();
      expect(expectOk(await media.read(stored!.id))).toBeNull();
      expect(expectOk(await media.list()).total).toBe(0);

      broken = false;
      const retried = expectOk(await media.upload({ ...png, filename: "shot.png" })).item;
      expect(retried.status).toBe("ready");
      expect(expectOk(await db.count(COLLECTION, {}))).toBe(1);
    });

    it("with publicCopy: writes the copy too, and a failed copy fails the upload, removing the private blob and freeing the name", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      let breakCopy = false;
      const wrapped: Blobstore = { ...blobs, async put(key, data, options) { if (breakCopy && key.startsWith("site/media/")) return err(failure("TRANSIENT", "copy store down")); return blobs.put(key, data, options); } };
      const media = await createMediaDefault({ ...BASE_CONFIG, publicCopy: { prefix: "site/" } }, wrapped, db, noLogger, () => 7);
      const ok1 = expectOk(await media.upload({ ...png, filename: "shot.png" })).item;
      expect(blobs.blobs.has(`site/media/${ok1.id}/shot.png`)).toBe(true);
      expect(blobs.blobs.get(`site/media/${ok1.id}/shot.png`)?.contentType).toBe("image/png");

      breakCopy = true;
      expect(expectErr(await media.upload({ ...png, filename: "other.png" }), "TRANSIENT").message).toMatch(/copy store down/);
      const failedRow = expectOk(await db.findOne<{ id: string; status: string; key: string }>(COLLECTION, { filename: "other.png" }));
      expect(failedRow?.status).toBe("failed");
      expect(blobs.blobs.has(failedRow!.key)).toBe(false);
      breakCopy = false;
      const retried = expectOk(await media.upload({ ...png, filename: "other.png" })).item;
      expect(retried.status).toBe("ready");
    });
  });

  it("remove: copy, then blob, then row, then a sweep; a retry after a partial failure completes", async () => {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    const media = await createMediaDefault({ ...BASE_CONFIG, publicCopy: { prefix: "site/" } }, blobs, db, noLogger, () => 7);
    const item = expectOk(await media.upload({ ...png, filename: "shot.png" })).item;
    const copyKey = `site/media/${item.id}/shot.png`;
    expect(blobs.blobs.has(item.key)).toBe(true);
    expect(blobs.blobs.has(copyKey)).toBe(true);
    expectOk(await blobs.put(`site/media/${item.id}/stray.png`, new Uint8Array([9]), { contentType: "image/png" }));
    expectOk(await media.remove(item.id));
    expect(blobs.blobs.has(item.key)).toBe(false);
    expect(blobs.blobs.has(copyKey)).toBe(false);
    expect(blobs.blobs.has(`site/media/${item.id}/stray.png`)).toBe(false);
    expect(expectOk(await db.count(COLLECTION, {}))).toBe(0);
    expectOk(await media.remove(item.id));
  });

  it("remove survives a failing blob delete and stops before deleting the row", async () => {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    const errors: string[] = [];
    const logger: Logger = { step() {}, info() {}, error: (m) => errors.push(m) };
    const media = await createMediaDefault(BASE_CONFIG, { ...blobs, async remove() { return err(failure("TRANSIENT", "blobstore down")); } }, db, logger, () => 7);
    const item = expectOk(await media.upload({ ...png, filename: "shot.png" })).item;
    expectErr(await media.remove(item.id), "TRANSIENT");
    expect(expectOk(await db.count(COLLECTION, {}))).toBe(1);
    expect(blobs.blobs.has(item.key)).toBe(true);
    expect(expectOk(await media.get(item.id))).toBeNull();
    expect(expectOk(await media.list())).toEqual({ items: [], total: 0 });
  });

  describe("public copy and reconciliation", () => {
    const withCopy = (): Promise<{ media: Awaited<ReturnType<typeof createMediaDefault>>; blobs: ReturnType<typeof fakeBlobstore>; db: ReturnType<typeof createFakePersistence>; time: { now: number } }> => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      const time = { now: 1000 };
      return createMediaDefault({ ...BASE_CONFIG, publicCopy: { prefix: "site/" }, uploadStaleAfterMs: 60000 }, blobs, db, noLogger, () => time.now).then((media) => ({ media, blobs, db, time }));
    };

    it("syncPublic writes a missing copy, rewrites a mismatched one, and never touches a deeper key", async () => {
      const { media, blobs, db, time } = await withCopy();
      const item = expectOk(await media.upload({ ...png, filename: "shot.png" })).item;
      const copyKey = `site/media/${item.id}/shot.png`;
      blobs.blobs.delete(copyKey);
      expectOk(await blobs.put(`site/media/${item.id}/variants/x`, new Uint8Array([1]), { contentType: "image/webp" }));
      expectOk(await blobs.put(`site/media/${item.id}/a/b`, new Uint8Array([1]), { contentType: "text/plain" }));
      const first = expectOk(await media.syncPublic());
      expect(first).toEqual({ written: 1, removed: 0, missing: 0 });
      expect(blobs.blobs.get(copyKey)?.data).toEqual(png.data);
      expect(blobs.blobs.has(`site/media/${item.id}/variants/x`)).toBe(true);
      expect(blobs.blobs.has(`site/media/${item.id}/a/b`)).toBe(true);

      blobs.blobs.set(copyKey, { data: new Uint8Array([9, 9]), contentType: "image/png" });
      const second = expectOk(await media.syncPublic());
      expect(second.written).toBe(1);
      expect(blobs.blobs.get(copyKey)?.data).toEqual(png.data);
      void db;
      void time;
    });

    it("removes a foreign depth-1 file and a copy whose item is gone", async () => {
      const { media, blobs, db } = await withCopy();
      const item = expectOk(await media.upload({ ...png, filename: "shot.png" })).item;
      expectOk(await blobs.put(`site/media/${item.id}/other.png`, new Uint8Array([1]), { contentType: "image/png" }));
      expectOk(await blobs.put("site/media/ghost-id/gone.png", new Uint8Array([1]), { contentType: "image/png" }));
      const synced = expectOk(await media.syncPublic());
      expect(synced.removed).toBe(2);
      expect(blobs.blobs.has(`site/media/${item.id}/other.png`)).toBe(false);
      expect(blobs.blobs.has("site/media/ghost-id/gone.png")).toBe(false);
      expect(blobs.blobs.has(`site/media/${item.id}/shot.png`)).toBe(true);
      void db;
    });

    it("leaves a young uploading row alone and fails an old one, removing its copy and blob", async () => {
      const { media, blobs, db, time } = await withCopy();
      const item = expectOk(await media.upload({ ...png, filename: "shot.png" })).item;
      expectOk(await db.updateOne(COLLECTION, item.id, { status: "uploading" }));
      const soon = expectOk(await media.syncPublic());
      expect(soon).toEqual({ written: 0, removed: 0, missing: 0 });
      expect(blobs.blobs.has(item.key)).toBe(true);

      time.now += 61000;
      const later = expectOk(await media.syncPublic());
      expect(later.removed).toBe(1);
      expect(blobs.blobs.has(item.key)).toBe(false);
      expect(expectOk(await db.findOne<{ id: string; status: string }>(COLLECTION, { id: item.id }))?.status).toBe("failed");
    });

    it("reports a missing original blob", async () => {
      const { media, blobs } = await withCopy();
      const item = expectOk(await media.upload({ ...png, filename: "shot.png" })).item;
      blobs.blobs.delete(item.key);
      blobs.blobs.delete(`site/media/${item.id}/shot.png`);
      const synced = expectOk(await media.syncPublic());
      expect(synced.missing).toBe(1);
    });

    it("without publicCopy, syncPublic is a no-op", async () => {
      const { media } = await make();
      expect(expectOk(await media.syncPublic())).toEqual({ written: 0, removed: 0, missing: 0 });
    });
  });

  describe("serveFile", () => {
    it("serves the file only under the name it was uploaded with, and only when ready", async () => {
      const { media } = await make();
      const item = expectOk(await media.upload(png)).item;
      const served = expectOk(await media.serveFile(item.id, "evil-name.png"));
      expect(Array.from(served?.data ?? [])).toEqual([1, 2, 3]);
      expect(expectOk(await media.serveFile(item.id, "other.png"))).toBeNull();
      expect(expectOk(await media.serveFile("missing", "evil-name.png"))).toBeNull();
    });
  });

  describe("boot rules", () => {
    it("throws when the copy tree and the store prefix overlap", async () => {
      await expect(createMediaDefault({ ...BASE_CONFIG, prefix: "media/", publicPath: "/media", publicCopy: { prefix: "" } }, fakeBlobstore(), createFakePersistence(), noLogger)).rejects.toThrow(/publicCopy tree "media\/" and prefix "media\/" overlap/);
    });

    it("throws when a stored item's key does not match <prefix><id>/<name>", async () => {
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      await createMediaDefault(BASE_CONFIG, blobs, db, noLogger);
      expectOk(await db.createOne(COLLECTION, { filename: "a.png", folder: "", location: "a.png", contentType: "image/png", size: 1, key: "media/legacy/a.png", checksum: null, status: "ready", createdAt: 1, updatedAt: 1, provenance: { origin: "unknown" }, width: null, height: null, alt: {}, title: {}, description: {} }));
      await expect(createMediaDefault(BASE_CONFIG, blobs, db, noLogger)).rejects.toThrow(/1 stored item\(s\) use a blob key other than "media\/<id>\/<name>"/);
    });

    it("attach throws when publicCopy is set but no pipeline runs media.serve", async () => {
      const { media } = await make({ ...BASE_CONFIG, publicCopy: { prefix: "site/" } });
      expect(() => media.attach(introspectionOf(manifestWithPipelines([{ pipeline: "getMedia", module: "media/default", step: "media.get" }])))).toThrow(/no pipeline runs media\.serve/);
      expect(() => media.attach(introspectionOf(manifestWithPipelines([{ pipeline: "serveMediaFile", module: "media/default", step: "media.serve" }])))).not.toThrow();
    });

    it("attach throws when publicCopy is set, SVG uploads are allowed and an upload pipeline does not sanitise SVG first", async () => {
      const serve = { pipeline: "serveMediaFile", module: "media/default", step: "media.serve" };
      const upload = { pipeline: "uploadMedia", module: "media/default", step: "media.upload" };
      const sanitize = { pipeline: "uploadMedia", module: "sanitize/svg", step: "sanitize.svg" };
      const { media } = await make({ ...BASE_CONFIG, allowedTypes: ["image/*"], deniedTypes: [], publicCopy: { prefix: "site/" } });
      expect(() => media.attach(introspectionOf(manifestWithPipelines([serve, upload])))).toThrow('media/default: publicCopy is set and SVG uploads are allowed, but pipeline "uploadMedia" runs media.upload without sanitize.svg before it – an unsanitised SVG would be published; run sanitize.svg before media.upload or deny image/svg+xml');
      expect(() => media.attach(introspectionOf(manifestWithPipelines([serve, upload, sanitize])))).toThrow(/pipeline "uploadMedia" runs media\.upload without sanitize\.svg before it/);
      expect(() => media.attach(introspectionOf(manifestWithPipelines([serve, sanitize, upload])))).not.toThrow();
      const denied = await make({ ...BASE_CONFIG, allowedTypes: ["image/*"], deniedTypes: ["IMAGE/SVG+XML"], publicCopy: { prefix: "site/" } });
      expect(() => denied.media.attach(introspectionOf(manifestWithPipelines([serve, upload])))).not.toThrow();
      const pngOnly = await make({ ...BASE_CONFIG, allowedTypes: ["image/png"], deniedTypes: [], publicCopy: { prefix: "site/" } });
      expect(() => pngOnly.media.attach(introspectionOf(manifestWithPipelines([serve, upload])))).not.toThrow();
      const noCopy = await make({ ...BASE_CONFIG, allowedTypes: ["image/*"], deniedTypes: [] });
      expect(() => noCopy.media.attach(introspectionOf(manifestWithPipelines([upload])))).not.toThrow();
    });

    it("attach throws when publicCopy is set, SVG uploads are allowed and a step between sanitize.svg and media.upload writes the files", async () => {
      const serve = { pipeline: "serveMediaFile", module: "media/default", step: "media.serve" };
      const sanitize = { pipeline: "uploadMedia", module: "sanitize/svg", step: "sanitize.svg", writes: ["files"] };
      const upload = { pipeline: "uploadMedia", module: "media/default", step: "media.upload" };
      const { media } = await make({ ...BASE_CONFIG, allowedTypes: ["image/*"], deniedTypes: [], publicCopy: { prefix: "site/" } });
      const writer = (writes: string[]) => ({ pipeline: "uploadMedia", module: "probe/files", step: "probe.rename", writes });
      expect(() => media.attach(introspectionOf(manifestWithPipelines([serve, sanitize, writer(["files"]), upload])))).toThrow('media/default: publicCopy is set and SVG uploads are allowed, but pipeline "uploadMedia" runs probe.rename between sanitize.svg and media.upload, which writes the uploaded files again – an unsanitised SVG would be published; run sanitize.svg before media.upload or deny image/svg+xml');
      for (const writes of [["files.0?"], ["files?"], ["files?.0"], ["result", "files?.0.data"]]) {
        expect(() => media.attach(introspectionOf(manifestWithPipelines([serve, sanitize, writer(writes), upload])))).toThrow(/runs probe\.rename between sanitize\.svg and media\.upload/);
      }
      expect(() => media.attach(introspectionOf(manifestWithPipelines([serve, sanitize, upload, writer(["files"]), { ...upload, step: "media.upload" }])))).toThrow(/runs probe\.rename between sanitize\.svg and media\.upload/);
      expect(() => media.attach(introspectionOf(manifestWithPipelines([serve, sanitize, writer(["result", "filesSeen"]), upload])))).not.toThrow();
      expect(() => media.attach(introspectionOf(manifestWithPipelines([serve, sanitize, writer(["files"]), { ...sanitize }, upload])))).not.toThrow();
    });

    it("attach throws when a pipeline runs media.syncPublic without publicCopy", async () => {
      const { media } = await make();
      expect(() => media.attach(introspectionOf(manifestWithPipelines([{ pipeline: "repairPublicMedia", module: "media/default", step: "media.syncPublic" }])))).toThrow(/pipeline "repairPublicMedia" runs media\.syncPublic, but publicCopy is not set/);
      expect(() => media.attach(introspectionOf(manifestWithPipelines([])))).not.toThrow();
    });
  });

  describe("reconcile", () => {
    it("reports blobs without a row and rows without a blob, and deletes only orphan blobs on request", async () => {
      const { media, blobs, db } = await make({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [] });
      const kept = expectOk(await media.upload({ ...png, filename: "kept.png" })).item;
      const lost = expectOk(await media.upload({ ...png, filename: "lost.png" })).item;
      blobs.blobs.delete(lost.key);
      expectOk(await blobs.put("media/stray-id/stray.png", png.data, { contentType: "image/png" }));
      expectOk(await blobs.put("media-variants/x/thumb.webp", png.data, { contentType: "image/webp" }));

      expect(expectOk(await media.reconcile())).toEqual({ blobsWithoutRow: ["media/stray-id/stray.png"], rowsWithoutBlob: [lost.key] });
      expect(blobs.blobs.has("media/stray-id/stray.png")).toBe(true);

      expect(expectOk(await media.reconcile({ delete: true }))).toEqual({ blobsWithoutRow: ["media/stray-id/stray.png"], rowsWithoutBlob: [lost.key] });
      expect(blobs.blobs.has("media/stray-id/stray.png")).toBe(false);
      expect(blobs.blobs.has("media-variants/x/thumb.webp")).toBe(true);
      expect(blobs.blobs.has(kept.key)).toBe(true);
      expect(expectOk(await db.count(COLLECTION, {}))).toBe(2);
    });

    it("counts a key as orphaned only when it has its own <prefix><id>/<name> shape and no item has that id, so another module's files survive a deleting reconcile", async () => {
      const { media, blobs } = await make({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], prefix: "media/" });
      const kept = expectOk(await media.upload({ ...png, filename: "kept.png" })).item;
      const nested = [`media/variants/${kept.id}/thumb.webp`, `media/variants/${kept.id}/hero.jpg`, "media/variants/gone-id/thumb.webp", "media/loose.png", `media/${kept.id}/deeper/file.png`];
      for (const key of nested) expectOk(await blobs.put(key, png.data, { contentType: "image/webp" }));
      expectOk(await blobs.put("media/orphan-id/orphan.png", png.data, { contentType: "image/png" }));

      expectOk(await blobs.put(`media/${kept.id}/thumb.webp`, png.data, { contentType: "image/webp" }));
      expect(expectOk(await media.reconcile({ delete: true }))).toEqual({ blobsWithoutRow: ["media/orphan-id/orphan.png"], rowsWithoutBlob: [] });
      for (const key of nested) expect(blobs.blobs.has(key), key).toBe(true);
      expect(blobs.blobs.has(`media/${kept.id}/thumb.webp`)).toBe(true);
      expect(blobs.blobs.has(kept.key)).toBe(true);
      expect(blobs.blobs.has("media/orphan-id/orphan.png")).toBe(false);
    });
  });

  describe("on the filesystem blobstore", () => {
    const roots: string[] = [];
    afterAll(async () => {
      for (const root of roots) await rm(root, { recursive: true, force: true });
    });

    it("keeps the on-disk tree under <root>/media by id and prunes emptied directories on delete", async () => {
      const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "media-fs-"));
      roots.push(root);
      const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["image/*"], deniedTypes: [] }, createBlobstoreFilesystem({ root }), createFakePersistence(), noLogger);
      const exists = async (...parts: string[]): Promise<boolean> => stat(join(root, ...parts)).then(() => true, () => false);

      const item = expectOk(await media.upload({ ...png, filename: "bild.png" }, "2026/presse")).item;
      expect(await exists("media", item.id, "bild.png")).toBe(true);

      expectOk(await media.update(item.id, { folder: "archiv/2026/presse", filename: "neu.png" }));
      expect(await exists("media", item.id, "bild.png")).toBe(true);

      expect(expectOk(await media.removeFolder("archiv"))).toEqual({ ok: true, removed: 1, ids: [item.id] });
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
      const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], defaultLocale: undefined }, blobs, createFakePersistence(), noLogger, () => ++t);
      const item = expectOk(await media.upload({ ...png, filename: "alpha.png" }, "2026/press")).item;

      const first = expectOk(await media.exportTo(dir));
      expect(first).toEqual({ written: 1, skipped: 0, missing: 0, conflicts: 0 });
      const target = join(dir, "2026", "press", "alpha.png");
      expect(Array.from(await readFile(target))).toEqual(Array.from(png.data));
      expect((await stat(target)).mtimeMs).toBe(item.updatedAt);

      const second = expectOk(await media.exportTo(dir));
      expect(second).toEqual({ written: 0, skipped: 1, missing: 0, conflicts: 0 });
    });

    it("counts a missing blob and continues", async () => {
      const dir = await tempDir();
      const blobs = fakeBlobstore();
      let t = 0;
      const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], defaultLocale: undefined }, blobs, createFakePersistence(), noLogger, () => ++t);
      const item = expectOk(await media.upload({ ...png, filename: "orphan.png" })).item;
      blobs.blobs.delete(item.key);

      const result = expectOk(await media.exportTo(dir));
      expect(result).toEqual({ written: 0, skipped: 0, missing: 1, conflicts: 0 });
    });

    it("cannot escape the target directory", async () => {
      const dir = await tempDir();
      const blobs = fakeBlobstore();
      const db = createFakePersistence();
      const media = await createMediaDefault({ ...BASE_CONFIG, allowedTypes: ["*"], deniedTypes: [], maxBytes: 100, locales: [], defaultLocale: undefined }, blobs, db, noLogger, () => 1);
      const item = expectOk(await media.upload({ ...png, filename: "safe.png" })).item;
      expectOk(await db.updateOne(COLLECTION, item.id, { folder: "../../escape" }));

      await expect(media.exportTo(dir)).rejects.toThrow(/escapes/);
    });
  });
});
