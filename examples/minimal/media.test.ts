import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline } from "@michaelthielemann/kestrel";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context } from "@michaelthielemann/kestrel/context";
import type { KestrelConfigInput } from "@michaelthielemann/kestrel/defineConfig";
import { loadConfig, loadModules, loadPipelines } from "@michaelthielemann/kestrel/load";
import { ok } from "@michaelthielemann/kestrel/result";

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
  noteMediaDeleted?: boolean;
  extraRoles?: Record<string, string[]>;
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
    if (m.use === "@michaelthielemann/kestrel-authz-roles" && options.extraRoles !== undefined) {
      const authz = boundaryCast<{ roles: Record<string, string[]> }>(m.config, "host");
      return { ...m, config: { ...authz, roles: { ...authz.roles, ...options.extraRoles } } };
    }
    if (queue && m.use === "@michaelthielemann/kestrel-events-direct") return { use: "@michaelthielemann/kestrel-events-queue", config: { pollMs: 10, maxAttempts: 1, relayMs: 5000, relayPipelines: ["publishPage", "unpublishPage"], lanes: options.lanes } };
    return m;
  });
  const loaded = await loadModules(root, { ...configInput, modules: modulesConfig });
  const hold = options.holdVariantWrites;
  const modules = loaded.map((mod) => {
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
  if (options.noteMediaDeleted === true) {
    triggers.push({ event: "media.deleted", pipeline: "noteMediaDeleted" });
    pipelines.push(definePipeline({ name: "noteMediaDeleted", steps: ["probe.note"] }));
  }
  const config: KestrelConfigInput = { ...configInput, http: null, modules: [...modulesConfig, ...(options.noteMediaDeleted === true ? [{ use: "probe/events", config: {} }] : [])], triggers };
  const kestrel = await boot({ config, modules: options.noteMediaDeleted === true ? [...modules, probe] : modules, pipelines, root, validateOutput: true });
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

async function getItem(example: Example, id: string): Promise<Item> {
  const got = await example.kestrel.run("getMedia", { trigger, params: { id } });
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

describe("examples/minimal media: a published page and the public copies", () => {
  it("a page publish writes the media URLs verbatim, and the original and every variant are in the static prefix next to it", async () => {
    const example = await bootExample();
    try {
      const token = await adminToken(example);
      const item = await upload(example, token, "photo.jpg", "image/jpeg", TEST_JPEG);
      const listed = await getItem(example, item.id);
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

  it("a signed-in caller whose roles lack media.read gets the public file and its variants like an anonymous one", async () => {
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
      const listed = await getItem(example, item.id);
      for (const variant of listed.variants) expect((await serveVariant(example, item.id, fileOf(variant.path), bearer(viewer))).status).toBe(200);
      const read = await example.kestrel.run("downloadMedia", { trigger, headers: bearer(viewer), params: { id: item.id } });
      expect(read.status).toBe(403);
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
      await pollUntil(async () => (await getItem(example, item.id)).available);
      const placed = await getItem(example, item.id);
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
      await pollUntil(async () => (await getItem(example, item.id)).variants.every((variant) => variant.state === "error"));
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
    const example = await bootExample({ noteMediaDeleted: true });
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

describe("examples/minimal media: placing and rendering in separate lanes of events-queue", { timeout: 60_000 }, () => {
  it("each of twenty uploads in a row becomes available after its own plan job while every render waits in the variants lane", async () => {
    const hold = gate();
    const example = await bootExample({ lanes: { variants: ["generateImageVariants"] }, holdVariantWrites: hold });
    try {
      const token = await adminToken(example);
      const items: Item[] = [];
      for (let i = 0; i < 20; i++) {
        const item = await upload(example, token, `p${i}.jpg`, "image/jpeg", TEST_JPEG);
        await pollUntil(async () => (await getItem(example, item.id)).available);
        if (i === 0) await hold.reached;
        items.push(item);
      }
      expect(filesUnder(join(example.blobRoot, "media-variants"))).toEqual([]);
      for (const item of items) {
        const listed = await getItem(example, item.id);
        expect(listed.variants.map((variant) => variant.state)).toEqual(["pending", "pending", "pending", "pending", "pending"]);
        expect((await serveVariant(example, item.id, fileOf(listed.variants[0]!.path))).headers["x-kestrel-variant"]).toBe("original");
      }

      hold.open();
      await pollUntil(async () => {
        for (const item of items) if ((await getItem(example, item.id)).variantCounts.done !== 5) return false;
        return true;
      }, 30_000);
      for (const item of items) {
        const listed = await getItem(example, item.id);
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
      await pollUntil(async () => (await getItem(example, first.id)).available);
      await hold.reached;
      const second = await upload(example, token, "p1.jpg", "image/jpeg", TEST_JPEG);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await getItem(example, second.id)).available).toBe(false);
      hold.open();
      await pollUntil(async () => (await getItem(example, second.id)).available, 10_000);
    } finally {
      await example.dispose();
    }
  });
});
