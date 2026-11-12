import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline } from "@michaelthielemann/kestrel";
import { assertAnonymousAccess } from "@michaelthielemann/kestrel-authz-roles/impl";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context } from "@michaelthielemann/kestrel/context";
import type { KestrelConfigInput } from "@michaelthielemann/kestrel/defineConfig";
import { loadConfig, loadModules, loadPipelines } from "@michaelthielemann/kestrel/load";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";

const root = dirname(fileURLToPath(import.meta.url));
const trigger = { kind: "http", name: "test" } as const;
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const TEST_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64",
);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function pngWithTruncatedPixels(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let i = 0; i < raw.length; i++) raw[i] = i % stride === 0 ? 0 : (i * 7919) % 251;
  const compressed = deflateSync(raw);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", compressed.subarray(0, Math.floor(compressed.length / 2))), pngChunk("IEND", Buffer.alloc(0))]);
}

interface Gate {
  closed: boolean;
  wait: Promise<void>;
  open(): void;
  reached: Promise<void>;
  arrive(): void;
}

function gate(): Gate {
  let open: () => void = () => {};
  let arrive: () => void = () => {};
  const g: Gate = {
    closed: true,
    wait: new Promise<void>((resolve) => {
      open = resolve;
    }),
    open: () => {
      g.closed = false;
      open();
    },
    reached: new Promise<void>((resolve) => {
      arrive = resolve;
    }),
    arrive: () => arrive(),
  };
  return g;
}

interface Options {
  lanes?: Record<string, string[]>;
  holdVariantWrites?: Gate;
  noteEvents?: string[];
  extraRoles?: Record<string, string[]>;
  anonymous?: string[];
  storeFault?: StoreFault;
}

interface StoreFault {
  method: "createOne" | "deleteMany";
  collection: string;
  armed: boolean;
}

function failingOnce(real: object, fault: StoreFault): object {
  return new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const method = boundaryCast<(...args: unknown[]) => unknown>(value, "host").bind(target);
      if (prop !== fault.method) return method;
      return async (collection: unknown, ...rest: unknown[]) => {
        if (fault.armed && collection === fault.collection) {
          fault.armed = false;
          return err(failure("TRANSIENT", "store busy"));
        }
        return method(collection, ...rest);
      };
    },
  });
}

interface Example {
  kestrel: Awaited<ReturnType<typeof boot>>;
  blobRoot: string;
  notes: Array<Record<string, unknown>>;
  dispose: () => Promise<void>;
}

async function bootExample(options: Options = {}): Promise<Example> {
  const configInput = await loadConfig(join(root, "kestrel.config.ts"));
  const dataDir = mkdtempSync(join(tmpdir(), "kestrel-minimal-media-"));
  const queue = options.lanes !== undefined;
  const modulesConfig = configInput.modules.map((m) => {
    if (m.use === "@michaelthielemann/kestrel-persistence-sqlite") return { ...m, config: { ...(m.config as object), file: ":memory:" } };
    if (m.use === "@michaelthielemann/kestrel-replication-sqlite") return { ...m, config: { ...(m.config as object), file: join(dataDir, "replication.db") } };
    if (m.use === "@michaelthielemann/kestrel-blobstore-filesystem") return { ...m, config: { ...(m.config as object), root: join(dataDir, "blobs") } };
    if (m.use === "@michaelthielemann/kestrel-authz-roles" && (options.extraRoles !== undefined || options.anonymous !== undefined)) {
      const authz = boundaryCast<{ roles: Record<string, string[]>; anonymous: string[] }>(m.config, "host");
      return { ...m, config: { ...authz, roles: { ...authz.roles, ...options.extraRoles }, anonymous: options.anonymous ?? authz.anonymous } };
    }
    if (queue && m.use === "@michaelthielemann/kestrel-events-direct") return { use: "@michaelthielemann/kestrel-events-queue", config: { pollMs: 10, maxAttempts: 1, relayMs: 5000, relayPipelines: ["publishPage", "unpublishPage"], lanes: options.lanes } };
    return m;
  });
  const loaded = await loadModules(root, { ...configInput, modules: modulesConfig });
  const hold = options.holdVariantWrites;
  const fault = options.storeFault;
  const modules = loaded.map((mod) => {
    if (fault !== undefined && mod.name === "persistence/sqlite") {
      return defineModule({
        ...mod,
        async setup(config, deps) {
          return failingOnce(boundaryCast<object>(await mod.setup(config, deps), "host"), fault);
        },
      });
    }
    if (hold === undefined || mod.name !== "blobstore/filesystem") return mod;
    return defineModule({
      ...mod,
      async setup(config, deps) {
        const real = boundaryCast<Blobstore>(await mod.setup(config, deps), "host");
        return {
          ...real,
          async put(key: string, data: Uint8Array, putOptions?: { contentType?: string }) {
            if (hold.closed && key.startsWith("media-variants/")) {
              hold.arrive();
              await hold.wait;
            }
            return real.put(key, data, putOptions);
          },
        };
      },
    });
  });
  const notes: Array<Record<string, unknown>> = [];
  const probe = defineModule({
    name: "probe/events",
    provides: [],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return {};
    },
    steps: () => ({
      note: async (ctx: Context) => {
        notes.push(ctx.payload);
        return ok(ctx);
      },
    }),
    describe: () => ({ note: { summary: "Record the event payload", reads: [], writes: [] } }),
  });
  let triggers = [...configInput.triggers];
  const pipelines = await loadPipelines(root, "pipelines");
  if (queue) {
    triggers = triggers.filter((t) => !("event" in t && t.event === "media.uploaded"));
    triggers.push({ event: "media.uploaded", pipeline: "planImageVariants" }, { event: "images.planned", pipeline: "generateImageVariants" });
    pipelines.push(definePipeline({ name: "planImageVariants", steps: ["images.plan", "events.emit:images.planned"] }), definePipeline({ name: "queueStatus", steps: ["events.readQueueStatus"] }));
  }
  const noting = (options.noteEvents ?? []).length > 0;
  if (noting) {
    for (const event of options.noteEvents ?? []) triggers.push({ event, pipeline: "noteEvent" });
    pipelines.push(definePipeline({ name: "noteEvent", steps: ["probe.note"] }));
  }
  const config: KestrelConfigInput = { ...configInput, http: null, modules: [...modulesConfig, ...(noting ? [{ use: "probe/events", config: {} }] : [])], triggers };
  const kestrel = await boot({ config, modules: noting ? [...modules, probe] : modules, pipelines, root, validateOutput: true });
  await kestrel.start();
  return {
    kestrel,
    blobRoot: join(dataDir, "blobs"),
    notes,
    dispose: async () => {
      hold?.open();
      await kestrel.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function pollUntil(check: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("pollUntil: timed out waiting for the condition");
}

async function adminToken(example: Example): Promise<string> {
  const session = await example.kestrel.run("login", { trigger, payload: { username: "admin", password: "kestrel-demo" } });
  expect(session.status).toBe(200);
  return boundaryCast<{ token: string }>(session.result, "json").token;
}

interface Item {
  id: string;
  path: string;
  available: boolean;
  variants: Array<{ size: string; path: string; state: string }>;
  variantCounts: { done: number; pending: number; error: number; failed: number };
}

async function upload(example: Example, token: string, filename: string, contentType: string, data: Uint8Array, folder?: string): Promise<Item> {
  const uploaded = await example.kestrel.run("uploadMedia", { trigger, headers: bearer(token), ...(folder === undefined ? {} : { payload: { folder } }), files: [{ field: "file", filename, contentType, data }] });
  expect(uploaded.status).toBe(200);
  return boundaryCast<Item>(uploaded.result, "json");
}

async function getItem(example: Example, id: string, token: string): Promise<Item> {
  const got = await example.kestrel.run("getMedia", { trigger, headers: bearer(token), params: { id } });
  expect(got.status).toBe(200);
  return boundaryCast<Item>(got.result, "json");
}

interface Served {
  status: number;
  contentType: string | undefined;
  headers: Record<string, string>;
  data: Uint8Array | undefined;
}

async function serveVariant(example: Example, id: string, file: string, headers: Record<string, string> = {}): Promise<Served> {
  const served = await example.kestrel.run("serveImageVariant", { trigger, headers, params: { id, file } });
  const result = boundaryCast<{ contentType?: string; headers?: Record<string, string>; data?: Uint8Array } | undefined>(served.result, "json");
  return { status: served.status, contentType: result?.contentType, headers: result?.headers ?? {}, data: result?.data };
}

function fileOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

describe("examples/minimal media: a published page and the public copies", { timeout: 30_000 }, () => {
  it("a page publish writes the media URLs verbatim, and the original and every variant are in the static prefix next to it", async () => {
    const example = await bootExample();
    try {
      const token = await adminToken(example);
      const item = await upload(example, token, "photo.jpg", "image/jpeg", TEST_JPEG);
      const listed = await getItem(example, item.id, token);
      expect(listed.available).toBe(true);
      const thumb = listed.variants.find((variant) => variant.size === "thumb")!;
      const fields = { slug: "gallery", title: "Gallery", status: "published", hero: item.id, body: [{ type: "image", props: { image: thumb.path } }] };
      const created = await example.kestrel.run("createPage", { trigger, headers: bearer(token), payload: fields, body: fields });
      expect(created.status).toBe(200);

      const pages = filesUnder(join(example.blobRoot, "site")).filter((file) => file.endsWith("index.html"));
      const page = pages.map((file) => readFileSync(file, "utf8")).find((html) => html.includes("Gallery"));
      expect(page).toBeDefined();
      expect(page).toContain(thumb.path);

      expect(existsSync(join(example.blobRoot, "site", "media", item.id, fileOf(item.path)))).toBe(true);
      for (const variant of listed.variants) {
        expect(existsSync(join(example.blobRoot, "site", "media", item.id, "variants", fileOf(variant.path))), variant.path).toBe(true);
      }
    } finally {
      await example.dispose();
    }
  });

  it("a signed-in caller whose roles lack media.read, which anonymous callers have, gets the public file and its variants", async () => {
    const example = await bootExample({ extraRoles: { viewer: ["pages.read"] } });
    try {
      const token = await adminToken(example);
      const item = await upload(example, token, "photo.jpg", "image/jpeg", TEST_JPEG);
      const created = await example.kestrel.run("createUser", { trigger, headers: bearer(token), payload: { username: "vera", password: "long-enough", roles: ["viewer"] } });
      expect(created.status).toBe(200);
      const session = await example.kestrel.run("login", { trigger, payload: { username: "vera", password: "long-enough" } });
      const viewer = boundaryCast<{ token: string }>(session.result, "json").token;
      const original = await example.kestrel.run("serveMediaFile", { trigger, headers: bearer(viewer), params: { id: item.id, name: fileOf(item.path) } });
      expect(original.status).toBe(200);
      const listed = await getItem(example, item.id, token);
      for (const variant of listed.variants) expect((await serveVariant(example, item.id, fileOf(variant.path), bearer(viewer))).status).toBe(200);
      const read = await example.kestrel.run("downloadMedia", { trigger, headers: bearer(viewer), params: { id: item.id } });
      expect(read.status).toBe(200);
      const write = await example.kestrel.run("updateMedia", { trigger, headers: bearer(viewer), params: { id: item.id }, payload: { alt: "x" }, body: { alt: "x" } });
      expect(write.status).toBe(403);
    } finally {
      await example.dispose();
    }
  });
});

describe("examples/minimal media: public copies need anonymous read", () => {
  it("does not boot when anonymous callers may not read media, naming the serve pipeline", async () => {
    await expect(bootExample({ anonymous: [] })).rejects.toThrow(/pipeline "serve(MediaFile|ImageVariant)" runs (media|images)\.serve.*anonymous callers lack "media.read"/);
  });

  it("each of the two public serve pipelines on its own fails that check without anonymous media.read", async () => {
    const example = await bootExample();
    try {
      const pipelines = example.kestrel.describe().pipelines;
      for (const [name, step] of [["serveMediaFile", "media.serve"], ["serveImageVariant", "images.serve"]] as const) {
        const only = { pipelines: pipelines.filter((pipeline) => pipeline.name === name) };
        expect(only.pipelines).toHaveLength(1);
        expect(() => assertAnonymousAccess({ roles: {}, roleClaim: "roles", anonymous: [] }, only)).toThrow(`pipeline "${name}" runs ${step}, whose output is also published without an access check, but anonymous callers lack "media.read"`);
        expect(() => assertAnonymousAccess({ roles: {}, roleClaim: "roles", anonymous: ["media.read"] }, only)).not.toThrow();
      }
    } finally {
      await example.dispose();
    }
  });
});

describe("examples/minimal media: nothing active reaches the public copy", () => {
  it("an HTML file sent as an image type is refused as HTML and leaves no public copy", async () => {
    const example = await bootExample();
    try {
      const token = await adminToken(example);
      const refused = await example.kestrel.run("uploadMedia", { trigger, headers: bearer(token), files: [{ field: "file", filename: "Invite.HTML", contentType: "image/x-foo", data: new TextEncoder().encode("<html><script>alert(1)</script></html>") }] });
      expect(refused.status).toBe(415);
      expect(refused.error).toMatch(/text\/html/);
      expect(existsSync(join(example.blobRoot, "site", "media"))).toBe(false);
    } finally {
      await example.dispose();
    }
  });

  it("an SVG with a script is sanitised before its public copy is written", async () => {
    const example = await bootExample();
    try {
      const token = await adminToken(example);
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="1" height="1"/></svg>';
      const item = await upload(example, token, "logo.SVG.html", "image/svg+xml", new TextEncoder().encode(svg));
      expect(fileOf(item.path)).toBe("logo-SVG.svg");
      const copy = readFileSync(join(example.blobRoot, "site", "media", item.id, "logo-SVG.svg"), "utf8");
      expect(copy).toContain("<rect");
      expect(copy).not.toMatch(/script|onload/i);
    } finally {
      await example.dispose();
    }
  });
});

describe("examples/minimal media: an image whose render fails", () => {
  it("is placed right after the upload with the original at every variant path, and a later failed render keeps that placeholder", async () => {
    const example = await bootExample();
    try {
      const token = await adminToken(example);
      const png = pngWithTruncatedPixels(16, 12);
      const item = await upload(example, token, "broken.png", "image/png", png);
      await pollUntil(async () => (await getItem(example, item.id, token)).available);
      const placed = await getItem(example, item.id, token);
      expect(placed.variants.length).toBe(5);
      for (const variant of placed.variants) {
        expect(variant.state).toBe("pending");
        const file = fileOf(variant.path);
        const served = await serveVariant(example, item.id, file);
        expect(served.status).toBe(200);
        expect(served.contentType).toBe("image/png");
        expect(served.headers["x-kestrel-variant"]).toBe("original");
        expect(Buffer.compare(readFileSync(join(example.blobRoot, "site", "media", item.id, "variants", file)), png)).toBe(0);
      }

      const synced = await example.kestrel.run("syncImages", { trigger, headers: bearer(token) });
      expect(synced.status).toBe(200);
      await pollUntil(async () => (await getItem(example, item.id, token)).variants.every((variant) => variant.state === "error"));
      for (const variant of placed.variants) {
        const file = fileOf(variant.path);
        expect(Buffer.compare(readFileSync(join(example.blobRoot, "site", "media", item.id, "variants", file)), png)).toBe(0);
        expect((await serveVariant(example, item.id, file)).status).toBe(200);
      }
      expect(filesUnder(join(example.blobRoot, "media-variants", item.id))).toEqual([]);
    } finally {
      await example.dispose();
    }
  });
});

describe("examples/minimal media: deleting a folder", () => {
  it("raises media.deleted once with id null and the ids of both items it removed, and leaves none of their files", async () => {
    const example = await bootExample({ noteEvents: ["media.deleted"] });
    try {
      const token = await adminToken(example);
      const first = await upload(example, token, "a.jpg", "image/jpeg", TEST_JPEG, "shoot");
      const second = await upload(example, token, "b.jpg", "image/jpeg", TEST_JPEG, "shoot");
      const kept = await upload(example, token, "c.jpg", "image/jpeg", TEST_JPEG);
      const deleted = await example.kestrel.run("deleteMediaFolder", { trigger, headers: bearer(token), params: { path: "shoot" }, payload: { recursive: "true" } });
      expect(deleted.status).toBe(200);
      expect(example.notes).toHaveLength(1);
      expect(example.notes[0]).toMatchObject({ id: null });
      expect(boundaryCast<{ ids: string[] }>(example.notes[0], "host").ids.sort()).toEqual([first.id, second.id].sort());
      for (const id of [first.id, second.id]) {
        expect(existsSync(join(example.blobRoot, "site", "media", id))).toBe(false);
        expect(existsSync(join(example.blobRoot, "media", id))).toBe(false);
        expect(existsSync(join(example.blobRoot, "media-variants", id))).toBe(false);
      }
      expect(existsSync(join(example.blobRoot, "site", "media", kept.id, "c.jpg"))).toBe(true);
    } finally {
      await example.dispose();
    }
  });
});

function noted(example: Example, event: string): string[][] {
  return example.notes.filter((note) => note.event === event).map((note) => boundaryCast<{ ids: string[] }>(note, "host").ids);
}

async function run(example: Example, pipeline: string, token: string, input: { payload?: Record<string, unknown>; params?: Record<string, string> } = {}): Promise<{ status: number; result: unknown }> {
  const ran = await example.kestrel.run(pipeline, { trigger, headers: bearer(token), ...input });
  const result = typeof ran.result === "object" && ran.result !== null && !Array.isArray(ran.result) ? Object.fromEntries(Object.entries(ran.result).filter(([key]) => key !== "_events")) : ran.result;
  return { status: ran.status, result };
}

describe("examples/minimal media: the trash", { timeout: 30_000 }, () => {
  it("withdraws a trashed item from the library and the public tree, frees its name, and restore brings it back under a new name when the name was taken", async () => {
    const example = await bootExample({ noteEvents: ["media.trashed", "media.restored"] });
    try {
      const token = await adminToken(example);
      const item = await upload(example, token, "photo.jpg", "image/jpeg", TEST_JPEG, "shoot");
      await pollUntil(async () => (await getItem(example, item.id, token)).variantCounts.done === 5);
      const variants = (await getItem(example, item.id, token)).variants;
      const publicDir = join(example.blobRoot, "site", "media", item.id);

      const trashed = await run(example, "trashMedia", token, { payload: { ids: [item.id, "missing"] } });
      expect(trashed).toEqual({ status: 200, result: { ids: [item.id], unchanged: [], skipped: [{ id: "missing", reason: "not_found" }] } });
      expect(noted(example, "media.trashed")).toEqual([[item.id]]);
      expect((await example.kestrel.run("getMedia", { trigger, headers: bearer(token), params: { id: item.id } })).status).toBe(404);
      expect(boundaryCast<{ items: Item[] }>((await run(example, "listMedia", token)).result, "json").items).toEqual([]);
      expect((await serveVariant(example, item.id, fileOf(variants[0]!.path))).status).toBe(404);
      expect((await example.kestrel.run("serveMediaFile", { trigger, params: { id: item.id, name: "photo.jpg" } })).status).toBe(404);
      expect(filesUnder(publicDir)).toEqual([]);
      expect(filesUnder(join(example.blobRoot, "media-variants", item.id))).toHaveLength(5);

      const listed = boundaryCast<{ items: Array<Record<string, unknown>>; total: number }>((await run(example, "listMediaTrash", token)).result, "json");
      expect(listed.total).toBe(1);
      expect(listed.items[0]).toMatchObject({ id: item.id, filename: "photo.jpg", folder: "shoot", path: null });
      expect(boundaryCast<number>(listed.items[0]!.expiresAt, "json") - boundaryCast<number>(listed.items[0]!.trashedAt, "json")).toBe(30 * 86_400_000);

      const again = await upload(example, token, "photo.jpg", "image/jpeg", TEST_JPEG, "shoot");
      expect(again.id).not.toBe(item.id);

      const restored = await run(example, "restoreMedia", token, { payload: { ids: [item.id] } });
      expect(restored).toEqual({ status: 200, result: { ids: [item.id], unchanged: [], skipped: [], renamed: [{ id: item.id, from: "photo.jpg", to: "photo-2.jpg" }] } });
      expect(noted(example, "media.restored")).toEqual([[item.id]]);
      const back = await getItem(example, item.id, token);
      expect(back.path).toBe(item.path);
      expect(back.variants.map((variant) => variant.path)).toEqual(variants.map((variant) => variant.path));
      for (const variant of back.variants) expect((await serveVariant(example, item.id, fileOf(variant.path))).status).toBe(200);
      expect(filesUnder(publicDir)).toHaveLength(6);
    } finally {
      await example.dispose();
    }
  });

  it("a trash repeated after images.hideMany failed withdraws the variants and raises media.trashed", async () => {
    const fault: StoreFault = { method: "createOne", collection: "images_hidden", armed: false };
    const example = await bootExample({ noteEvents: ["media.trashed"], storeFault: fault });
    try {
      const token = await adminToken(example);
      const item = await upload(example, token, "photo.jpg", "image/jpeg", TEST_JPEG);
      await pollUntil(async () => (await getItem(example, item.id, token)).variantCounts.done === 5);
      const variant = fileOf((await getItem(example, item.id, token)).variants[0]!.path);
      fault.armed = true;
      expect((await run(example, "trashMedia", token, { payload: { ids: [item.id] } })).status).toBe(503);
      expect((await serveVariant(example, item.id, variant)).status).toBe(200);
      expect(noted(example, "media.trashed")).toEqual([]);

      const again = await run(example, "trashMedia", token, { payload: { ids: [item.id] } });
      expect(again).toEqual({ status: 200, result: { ids: [item.id], unchanged: [item.id], skipped: [] } });
      expect((await serveVariant(example, item.id, variant)).status).toBe(404);
      expect(filesUnder(join(example.blobRoot, "site", "media", item.id))).toEqual([]);
      expect(noted(example, "media.trashed")).toEqual([[item.id]]);
    } finally {
      await example.dispose();
    }
  });

  it("a restore repeated after images.showMany failed serves the variants again", async () => {
    const fault: StoreFault = { method: "deleteMany", collection: "images_hidden", armed: false };
    const example = await bootExample({ storeFault: fault });
    try {
      const token = await adminToken(example);
      const item = await upload(example, token, "photo.jpg", "image/jpeg", TEST_JPEG);
      await pollUntil(async () => (await getItem(example, item.id, token)).variantCounts.done === 5);
      const variant = fileOf((await getItem(example, item.id, token)).variants[0]!.path);
      expect((await run(example, "trashMedia", token, { payload: { ids: [item.id] } })).status).toBe(200);
      fault.armed = true;
      expect((await run(example, "restoreMedia", token, { payload: { ids: [item.id] } })).status).toBe(503);
      expect((await serveVariant(example, item.id, variant)).status).toBe(404);

      const again = await run(example, "restoreMedia", token, { payload: { ids: [item.id] } });
      expect(again).toEqual({ status: 200, result: { ids: [item.id], unchanged: [item.id], skipped: [], renamed: [] } });
      expect((await serveVariant(example, item.id, variant)).status).toBe(200);
      expect((await getItem(example, item.id, token)).available).toBe(true);
    } finally {
      await example.dispose();
    }
  });

  it("trashes a whole folder and restores its items into it", async () => {
    const example = await bootExample();
    try {
      const token = await adminToken(example);
      const first = await upload(example, token, "a.jpg", "image/jpeg", TEST_JPEG, "shoot/day-1");
      const second = await upload(example, token, "b.jpg", "image/jpeg", TEST_JPEG, "shoot");
      const trashed = await run(example, "trashMediaFolder", token, { params: { path: "shoot" } });
      expect(trashed.status).toBe(200);
      expect(boundaryCast<{ ids: string[] }>(trashed.result, "json").ids.sort()).toEqual([first.id, second.id].sort());
      const folders = (await run(example, "listMediaFolders", token)).result;
      expect(JSON.stringify(folders)).not.toContain("shoot");

      expect((await run(example, "restoreMedia", token, { payload: { ids: [first.id, second.id] } })).status).toBe(200);
      expect(JSON.stringify((await run(example, "listMediaFolders", token)).result)).toContain("shoot/day-1");
      expect((await getItem(example, first.id, token)).path).toBe(first.path);
    } finally {
      await example.dispose();
    }
  });

  it("purging leaves an item a page still references in the trash, reports it, and deletes the others with all their files", async () => {
    const example = await bootExample({ noteEvents: ["media.deleted"] });
    try {
      const token = await adminToken(example);
      const used = await upload(example, token, "used.jpg", "image/jpeg", TEST_JPEG);
      const unused = await upload(example, token, "unused.jpg", "image/jpeg", TEST_JPEG);
      const live = await upload(example, token, "live.jpg", "image/jpeg", TEST_JPEG);
      await pollUntil(async () => (await getItem(example, unused.id, token)).variantCounts.done === 5);
      const fields = { slug: "about", title: "About", status: "published", hero: used.id };
      expect((await example.kestrel.run("createPage", { trigger, headers: bearer(token), payload: fields, body: fields })).status).toBe(200);
      expect((await run(example, "trashMedia", token, { payload: { ids: [used.id, unused.id] } })).status).toBe(200);

      const purged = await run(example, "purgeMedia", token, { payload: { ids: [used.id, unused.id, live.id] } });
      expect(purged).toEqual({ status: 200, result: { ids: [unused.id], skipped: [{ id: live.id, reason: "not_trashed" }, { id: used.id, reason: "referenced" }] } });
      expect(noted(example, "media.deleted")).toEqual([[unused.id]]);
      for (const dir of ["media", "media-variants", join("site", "media")]) expect(existsSync(join(example.blobRoot, dir, unused.id)), dir).toBe(false);
      expect(boundaryCast<{ items: Array<{ id: string }> }>((await run(example, "listMediaTrash", token)).result, "json").items.map((entry) => entry.id)).toEqual([used.id]);

      expect((await run(example, "emptyMediaTrash", token)).result).toEqual({ ids: [], skipped: [{ id: used.id, reason: "referenced" }] });
      expect((await example.kestrel.run("purgeExpiredMedia", { trigger: { kind: "cron", name: "0 4 * * *" } })).result).toEqual({ ids: [], skipped: [] });
      expect((await example.kestrel.run("deleteMedia", { trigger, headers: bearer(token), params: { id: used.id } })).status).toBe(409);
      expect(filesUnder(join(example.blobRoot, "media", used.id))).toHaveLength(1);
    } finally {
      await example.dispose();
    }
  });
});

describe("examples/minimal media: placing and rendering in separate lanes of events-queue", { timeout: 60_000 }, () => {
  it("each of twenty uploads in a row becomes available after its own plan job while every render waits in the variants lane", async () => {
    const hold = gate();
    const example = await bootExample({ lanes: { variants: ["generateImageVariants"] }, holdVariantWrites: hold });
    try {
      const token = await adminToken(example);
      const items: Item[] = [];
      for (let i = 0; i < 20; i++) {
        const item = await upload(example, token, `p${i}.jpg`, "image/jpeg", TEST_JPEG);
        await pollUntil(async () => (await getItem(example, item.id, token)).available);
        if (i === 0) await hold.reached;
        items.push(item);
      }
      expect(filesUnder(join(example.blobRoot, "media-variants"))).toEqual([]);
      for (const item of items) {
        const listed = await getItem(example, item.id, token);
        expect(listed.variants.map((variant) => variant.state)).toEqual(["pending", "pending", "pending", "pending", "pending"]);
        expect((await serveVariant(example, item.id, fileOf(listed.variants[0]!.path))).headers["x-kestrel-variant"]).toBe("original");
      }

      hold.open();
      await pollUntil(async () => {
        for (const item of items) if ((await getItem(example, item.id, token)).variantCounts.done !== 5) return false;
        return true;
      }, 30_000);
      for (const item of items) {
        const listed = await getItem(example, item.id, token);
        for (const variant of listed.variants) {
          const served = await serveVariant(example, item.id, fileOf(variant.path));
          expect(served.status).toBe(200);
          expect(served.contentType).toBe("image/webp");
          expect(served.headers["x-kestrel-variant"]).toBeUndefined();
        }
      }
    } finally {
      await example.dispose();
    }
  });

  it("with the renders in the main lane, a second upload stays unavailable until the first one's renders finish", async () => {
    const hold = gate();
    const example = await bootExample({ lanes: {}, holdVariantWrites: hold });
    try {
      const token = await adminToken(example);
      const first = await upload(example, token, "p0.jpg", "image/jpeg", TEST_JPEG);
      await pollUntil(async () => (await getItem(example, first.id, token)).available);
      await hold.reached;
      const second = await upload(example, token, "p1.jpg", "image/jpeg", TEST_JPEG);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await getItem(example, second.id, token)).available).toBe(false);
      hold.open();
      await pollUntil(async () => (await getItem(example, second.id, token)).available, 10_000);
    } finally {
      await example.dispose();
    }
  });
});
