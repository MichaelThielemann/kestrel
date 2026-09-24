import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { observeReads } from "@michaelthielemann/kestrel/reads";
import { ok } from "@michaelthielemann/kestrel/result";
import { createMediaDefault, type Config } from "./impl.ts";

function memoryBlobs(): Blobstore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(key, data) { blobs.set(key, data); return ok(); },
    async get(key) { return ok(blobs.get(key) ?? null); },
    async remove(key) { blobs.delete(key); return ok(); },
    async move(from, to) { const b = blobs.get(from); if (b) blobs.set(to, b); blobs.delete(from); return ok(); },
    async list(prefix) { return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.byteLength }))); },
  };
}

const quiet: Logger = { step() {}, info() {}, error() {} };
const config: Config = { allowedTypes: ["image/*"], deniedTypes: [], maxBytes: 100, locales: ["de", "en"], defaultLocale: "de", prefix: "media/", publicPath: "/media", uploadStaleAfterMs: 900000, anonymousList: "ids" };

async function seeded() {
  const media = await createMediaDefault(config, memoryBlobs(), createFakePersistence(), quiet, () => 7);
  const first = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) })).item;
  const second = expectOk(await media.upload({ filename: "b.png", contentType: "image/png", data: new Uint8Array([4, 5, 6]) })).item;
  return { media, first, second };
}

describe("media/default notes what it answers inside a read scope", () => {
  it("get notes the item, also when there is none", async () => {
    const { media, first } = await seeded();
    const { reads } = await observeReads(async () => {
      expectOk(await media.get(first.id, "en"));
      expect(expectOk(await media.get("missing"))).toBeNull();
    });
    expect(reads).toEqual([
      { kind: "document", type: "media", id: first.id },
      { kind: "document", type: "media", id: "missing" },
    ]);
  });

  it("byIds notes one document per asked id", async () => {
    const { media, first, second } = await seeded();
    const { reads } = await observeReads(async () => {
      expectOk(await media.byIds([first.id, second.id, "missing"]));
    });
    expect(reads).toEqual([
      { kind: "document", type: "media", id: first.id },
      { kind: "document", type: "media", id: second.id },
      { kind: "document", type: "media", id: "missing" },
    ]);
  });

  it("a list notes the whole media type", async () => {
    const { media } = await seeded();
    const { reads } = await observeReads(async () => {
      expectOk(await media.list({ limit: 10 }));
    });
    expect(reads).toEqual([{ kind: "type", type: "media" }]);
  });

  it("reading an item's bytes notes the item, also when there is none", async () => {
    const { media, first } = await seeded();
    const { reads } = await observeReads(async () => {
      expect(expectOk(await media.read(first.id))).not.toBeNull();
      expect(expectOk(await media.serveFile("missing", "a.png"))).toBeNull();
    });
    expect(reads).toEqual([
      { kind: "document", type: "media", id: first.id },
      { kind: "document", type: "media", id: "missing" },
    ]);
  });

  it("keeps the read type internal", async () => {
    const impl = await import("./impl.ts");
    expect(Reflect.has(impl, "MEDIA_READ_TYPE")).toBe(false);
  });

  it("an update notes nothing", async () => {
    const { media, first } = await seeded();
    const { reads } = await observeReads(async () => {
      expectOk(await media.update(first.id, { alt: "Stage" }, "de"));
    });
    expect(reads).toEqual([]);
  });
});
