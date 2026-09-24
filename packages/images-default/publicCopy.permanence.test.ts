import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Introspection, Manifest } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext, type Step } from "@michaelthielemann/kestrel/context";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { createMediaDefault, type Config as MediaConfig, type Media } from "../media-default/impl.ts";
import module from "./module.ts";
import { DEFAULT_RENDER_TIMEOUT_MS, VARIANTS, createImages, whenIdle, type Config, type Images, type Variant } from "./impl.ts";
import type { Renderer } from "./generate.ts";
import type { Size } from "./sizes.ts";

type MemoryBlobstore = Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> };

function memoryBlobstore(): MemoryBlobstore {
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

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BLOB_METHODS = ["put", "get", "remove", "list"] as const;
const PERSISTENCE_METHODS = ["createOne", "createMany", "findOne", "findMany", "count", "updateOne", "updateMany", "deleteOne", "deleteMany"] as const;
const noLogger: Logger = { step() {}, info() {}, error() {} };
const MEDIA_CONFIG: MediaConfig = { allowedTypes: ["*"], deniedTypes: [], maxBytes: 1_000_000, locales: [], prefix: "media/", publicPath: "/media", publicCopy: { prefix: "site/" }, uploadStaleAfterMs: 900000, anonymousList: "ids" };
const IMAGES_CONFIG: Config = { prefix: "media-variants/", publicPath: "/media", publicCopy: { prefix: "site/" }, media: { collection: "media_items" }, chunk: 3, staleAfterMs: 60000, maxAttempts: 2, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS };
const SIZE_NAMES = ["thumb", "small", "hero", "wide"];

function manifestServingVariants(): Manifest {
  return {
    core: { version: "0.0.0" },
    contracts: [],
    modules: [],
    steps: [],
    pipelines: [{ name: "serveImageVariant", steps: [{ spec: "images.serve", name: "images.serve", module: "images/default", description: { summary: "", reads: [], writes: [] } }] }],
    triggers: { http: [], events: [], crons: [] },
    warnings: [],
  };
}
const introspection: Introspection = { describe: () => manifestServingVariants(), observe: () => () => {}, health: () => ({ ok: true, restartRequired: false, modules: [] }) };

interface Listed {
  available: boolean;
  variants: Array<{ path: string; width: number; height: number }>;
}

class Run {
  readonly blobs = memoryBlobstore();
  readonly db: FakePersistence = createFakePersistence();
  readonly log: string[] = [];
  media!: Media;
  images!: Images;
  sizes: Size[] = [
    { name: "thumb", width: 24, fit: "inside", format: "webp", quality: 82 },
    { name: "hero", width: 40, fit: "inside", format: "original", quality: 82 },
  ];
  live = new Map<string, { name: string; contentType: string }>();
  deleted = new Set<string>();
  everListed = new Map<string, Set<string>>();
  renderFails = false;

  constructor(readonly next: () => number) {}

  readonly renderer: Renderer = async (_data, size, planned) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (this.renderFails) throw new Error("render failed");
    return { data: new Uint8Array([5, size.name.length, planned.width, planned.height]), width: planned.width, height: planned.height, format: planned.format, ext: planned.format, contentType: `image/${planned.format}` };
  };

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  async start(): Promise<void> {
    this.media = await createMediaDefault(MEDIA_CONFIG, this.blobs, this.db, noLogger);
    await this.deploy();
  }

  async deploy(): Promise<void> {
    if (this.images !== undefined) await this.images.close();
    this.images = await createImages({ ...IMAGES_CONFIG, sizes: this.sizes.map((size) => ({ ...size })) }, { blobs: this.blobs, db: this.db, logger: noLogger, render: this.renderer }, () => 1000);
    this.images.attach(introspection);
  }

  liveIds(): string[] {
    return [...this.live.keys()];
  }

  withFailure<T>(failAt: number, run: () => Promise<T>, onlyCopies = false): Promise<T> {
    let call = 0;
    const restore: Array<() => void> = [];
    const targets: Array<[object, readonly string[]]> = onlyCopies ? [[this.blobs, ["put"]]] : [[this.blobs, BLOB_METHODS], [this.db, PERSISTENCE_METHODS]];
    for (const [object, methods] of targets) {
      const mutable = boundaryCast<Record<string, (...args: unknown[]) => Promise<unknown>>>(object, "host");
      for (const method of methods) {
        const original = mutable[method]!;
        mutable[method] = async (...args: unknown[]) => {
          const copyPut = method === "put" && typeof args[0] === "string" && args[0].includes("/variants/");
          if ((!onlyCopies || copyPut) && call++ === failAt) return err(failure("TRANSIENT", "injected"));
          return original.apply(object, args);
        };
        restore.push(() => {
          mutable[method] = original;
        });
      }
    }
    return run().finally(() => {
      for (const undo of restore) undo();
    });
  }

  async upload(): Promise<void> {
    const kind = this.pick(["jpeg", "jpeg", "jpeg", "undecodable", "pdf"] as const);
    let data: Uint8Array;
    let contentType = "image/jpeg";
    if (kind === "jpeg") {
      const [width, height] = this.pick([[64, 48], [30, 90], [120, 20]] as const);
      data = await sharp({ create: { width, height, channels: 3, background: "#446688" } }).jpeg().toBuffer();
    } else if (kind === "undecodable") {
      data = new Uint8Array([1, 2, 3, 4]);
    } else {
      data = new TextEncoder().encode("%PDF-1.4 minimal");
      contentType = "application/pdf";
    }
    const item = expectOk(await this.media.upload({ filename: `file-${this.live.size + this.deleted.size}.bin`, contentType, data })).item;
    this.live.set(item.id, { name: item.key.slice(item.key.lastIndexOf("/") + 1), contentType });
    if (this.next() < 0.5) {
      this.log.push(`upload ${kind} ${item.id.slice(0, 8)}, plan`);
      expectOk(await this.images.plan([item.id]));
    } else {
      this.log.push(`upload ${kind} ${item.id.slice(0, 8)}, inline generate`);
      expectOk(await this.images.generate(item.id));
    }
  }

  async step(): Promise<void> {
    const ids = this.liveIds();
    const roll = this.next();
    if (ids.length === 0 || roll < 0.18) return this.upload();
    const id = this.pick(ids);
    const short = id.slice(0, 8);
    const choice = this.pick(["render", "renderFailure", "placeholderFailure", "specChange", "formatChange", "newSize", "prune", "mediaSync", "imagesSync", "repair", "transient", "delete"] as const);
    this.log.push(`${choice} ${short}`);
    switch (choice) {
      case "render":
        await this.images.generate(id);
        return;
      case "renderFailure":
        this.renderFails = true;
        try {
          await this.images.generate(id);
        } finally {
          this.renderFails = false;
        }
        return;
      case "placeholderFailure": {
        const op = this.pick(["plan", "generate", "sync"] as const);
        await this.withFailure(0, async () => {
          if (op === "plan") await this.images.plan([id]);
          else if (op === "generate") await this.images.generate(id);
          else await this.images.syncPublic();
        }, true);
        return;
      }
      case "specChange": {
        const size = this.pick(this.sizes);
        size.width = size.width === 24 ? 28 : size.width + 2;
        return this.deploy();
      }
      case "formatChange": {
        const size = this.pick(this.sizes);
        size.format = size.format === "webp" ? "original" : "webp";
        return this.deploy();
      }
      case "newSize": {
        const unused = SIZE_NAMES.filter((name) => !this.sizes.some((size) => size.name === name));
        if (unused.length === 0) return;
        this.sizes.push({ name: this.pick(unused), width: 32, fit: "inside", format: this.pick(["webp", "original"] as const), quality: 82 });
        return this.deploy();
      }
      case "prune": {
        if (this.sizes.length < 2) return;
        const size = this.pick(this.sizes);
        this.sizes = this.sizes.filter((s) => s.name !== size.name);
        await this.deploy();
        if (expectOk(await this.db.count(VARIANTS, { size: size.name })) > 0) expectOk(await this.images.prune([size.name]));
        return;
      }
      case "mediaSync":
        expectOk(await this.media.syncPublic());
        return;
      case "imagesSync":
        expectOk(await this.images.syncPublic());
        return;
      case "repair":
        expectOk(await this.images.resume());
        return;
      case "transient": {
        const op = this.pick(["plan", "generate", "sync", "repair"] as const);
        const failAt = Math.floor(this.next() * 24);
        this.log.push(`  failing call ${failAt} of ${op}`);
        await this.withFailure(failAt, async () => {
          if (op === "plan") await this.images.plan([id]);
          else if (op === "generate") await this.images.generate(id);
          else if (op === "sync") await this.images.syncPublic();
          else await this.images.resume();
        });
        return;
      }
      case "delete": {
        const failAt = this.next() < 0.5 ? Math.floor(this.next() * 16) : -1;
        await this.withFailure(failAt, async () => {
          await this.media.remove(id);
          await this.images.remove(id);
        });
        expectOk(await this.media.remove(id));
        expectOk(await this.images.remove(id));
        this.live.delete(id);
        this.deleted.add(id);
        return;
      }
    }
  }

  async output(id: string, contentType: string): Promise<Listed> {
    const steps = boundaryCast<{ attach: Step }>(module.steps!(this.images), "host");
    const ctx = expectOk(await steps.attach({ ...createContext({ trigger: { kind: "http", name: "t" } }), result: { id, contentType } }));
    return boundaryCast<Listed>(ctx.result, "host");
  }

  async check(): Promise<string[]> {
    await whenIdle(this.images);
    const problems: string[] = [];
    for (const [id, item] of this.live) {
      if (!this.blobs.blobs.has(`site/media/${id}/${item.name}`)) problems.push(`original ${id} has no copy`);
      if (expectOk(await this.media.serveFile(id, item.name)) === null) problems.push(`original ${id} does not answer on Node`);
      const listed = await this.output(id, item.contentType);
      const eligibleImage = item.contentType === "image/jpeg";
      if (!eligibleImage && !listed.available) problems.push(`${id} is not an image and still unavailable`);
      if (eligibleImage && listed.available && listed.variants.length === 0) problems.push(`${id} is available without any variant`);
      const rows = expectOk(await this.db.findMany<Variant>(VARIANTS, { mediaId: id })).items;
      if (listed.available && rows.some((row) => row.state === "planned")) problems.push(`${id} is available with a planned row`);
      const seen = this.everListed.get(id) ?? new Set<string>();
      for (const variant of listed.variants) seen.add(variant.path.slice(variant.path.lastIndexOf("/") + 1));
      this.everListed.set(id, seen);
      for (const file of seen) {
        if (!this.blobs.blobs.has(`site/media/${id}/variants/${file}`)) problems.push(`listed ${id}/variants/${file} has no copy`);
        if (expectOk(await this.images.read(id, file)) === null) problems.push(`listed ${id}/variants/${file} does not answer on Node`);
      }
    }
    for (const id of this.deleted) {
      const left = [...this.blobs.blobs.keys()].filter((key) => key.startsWith(`site/media/${id}/`) || key.startsWith(`media-variants/${id}/`));
      if (left.length > 0) problems.push(`deleted ${id} left ${left.join(", ")}`);
    }
    return problems;
  }
}

describe("images/default publicCopy: a listed path answers until its item is deleted", { timeout: 60_000 }, () => {
  const SEEDS = 40;
  const STEPS = 60;
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`holds for the random operation sequence with seed ${seed}`, async () => {
      const run = new Run(random(seed * 7919));
      await run.start();
      for (let i = 0; i < STEPS; i++) {
        await run.step();
        const problems = await run.check();
        expect(problems, `after step ${i}: ${run.log.slice(-6).join(" | ")}`).toEqual([]);
      }
      for (const id of run.liveIds()) {
        expectOk(await run.media.remove(id));
        expectOk(await run.images.remove(id));
        run.live.delete(id);
        run.deleted.add(id);
      }
      expect(await run.check()).toEqual([]);
      expect([...run.blobs.blobs.keys()].filter((key) => key.startsWith("site/") || key.startsWith("media-variants/"))).toEqual([]);
      await run.images.close();
    });
  }
});
