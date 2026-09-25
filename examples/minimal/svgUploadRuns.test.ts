import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline, type Kestrel, type PipelineDefinition } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context, UploadedFile } from "@michaelthielemann/kestrel/context";
import type { KestrelConfigInput } from "@michaelthielemann/kestrel/defineConfig";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { err, isErr, ok } from "@michaelthielemann/kestrel/result";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { EVENTS } from "@michaelthielemann/kestrel-contracts/events";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import eventsDirect from "@michaelthielemann/kestrel-events-direct";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import eventsQueue from "@michaelthielemann/kestrel-events-queue";
import mediaModule from "@michaelthielemann/kestrel-media-default";
import type { Media, MediaItem } from "@michaelthielemann/kestrel-media-default/impl";
import sanitizeSvg from "@michaelthielemann/kestrel-sanitize-svg";

const http = { kind: "http", name: "test" } as const;
const DRAWING = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>';

interface Stored {
  data: Uint8Array;
  contentType: string;
}

interface Booted {
  kestrel: Kestrel;
  media: Media;
  blobs: Map<string, Stored>;
  hooks: { beforePut: (key: string) => Promise<Error | null> };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function svgFile(filename: string): UploadedFile {
  return { field: "file", filename, contentType: "image/svg+xml", data: new TextEncoder().encode(DRAWING) };
}

const blobstore = (blobs: Map<string, Stored>, hooks: Booted["hooks"]) =>
  defineModule({
    name: "blobstore/memory",
    provides: [BLOBSTORE],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup(): Promise<Blobstore> {
      return {
        async put(key, data, options) {
          const refused = await hooks.beforePut(key);
          if (refused !== null) return err(failure("TRANSIENT", refused.message));
          blobs.set(key, { data, contentType: options?.contentType ?? "application/octet-stream" });
          return ok();
        },
        async get(key) {
          return ok(blobs.get(key)?.data ?? null);
        },
        async remove(key) {
          blobs.delete(key);
          return ok();
        },
        async move(from, to) {
          const blob = blobs.get(from);
          if (blob === undefined) return err(failure("NOT_FOUND", `${from} not found`));
          blobs.set(to, blob);
          blobs.delete(from);
          return ok();
        },
        async list(prefix) {
          return ok([...blobs].filter(([key]) => key.startsWith(prefix)).map(([key, blob]) => ({ key, size: blob.data.byteLength })));
        },
      };
    },
  });

const persistence = defineModule({
  name: "persistence/fake",
  provides: [PERSISTENCE],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return createFakePersistence();
  },
});

const importer = defineModule({
  name: "probe/import",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({
    fileFromEvent: async (ctx: Context) => {
      const { svg, filename } = boundaryCast<{ svg: string; filename: string }>(ctx.payload, "json");
      return ok({ ...ctx, body: {}, files: [{ field: "file", filename, contentType: "image/svg+xml", data: new TextEncoder().encode(svg) }] });
    },
  }),
  describe: () => ({ fileFromEvent: { summary: "Turn the event's SVG into the uploaded file", reads: ["payload"], writes: ["files", "body"] } }),
});

async function bootMedia(options: { delivery: "direct" | "queue"; publicCopy: boolean; pipelines: PipelineDefinition[]; triggers?: KestrelConfigInput["triggers"] }): Promise<Booted> {
  const blobs = new Map<string, Stored>();
  const hooks: Booted["hooks"] = { beforePut: async () => null };
  let captured: Media | undefined;
  const media = defineModule({
    ...mediaModule,
    async setup(config, deps) {
      const instance = await mediaModule.setup(config, deps);
      captured = boundaryCast<Media>(instance, "host");
      return instance;
    },
  });
  const delivery = options.delivery === "direct" ? { use: "@michaelthielemann/kestrel-events-direct", config: {} } : { use: "@michaelthielemann/kestrel-events-queue", config: { pollMs: 5, relayMs: 0 } };
  const kestrel = await boot({
    config: {
      modules: [
        { use: "./persistence.ts", config: {} },
        { use: "./blobstore.ts", config: {} },
        { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
        delivery,
        { use: "@michaelthielemann/kestrel-sanitize-svg", config: {} },
        { use: "@michaelthielemann/kestrel-media-default", config: { allowedTypes: ["image/*"], deniedTypes: [], ...(options.publicCopy ? { publicCopy: { prefix: "site/" } } : {}) } },
        { use: "./importer.ts", config: {} },
      ],
      triggers: options.triggers ?? [],
      http: null,
    },
    modules: [persistence, blobstore(blobs, hooks), eventsInmemory, options.delivery === "direct" ? eventsDirect : eventsQueue, sanitizeSvg, media, importer],
    pipelines: options.pipelines,
    logger: silentLogger,
  });
  if (captured === undefined) throw new Error("media/default was not set up");
  return { kestrel, media: captured, blobs, hooks };
}

function pathsOf(result: unknown): string[] {
  const shaped = boundaryCast<{ path?: string; items?: Array<{ path: string }> }>(result, "json");
  return shaped.items === undefined ? [shaped.path ?? ""] : shaped.items.map((item) => item.path);
}

function namesOf(result: unknown): string[] {
  return pathsOf(result).map((path) => path.slice(path.lastIndexOf("/") + 1));
}

async function onlyItem(media: Media): Promise<MediaItem | null> {
  const listed = await media.list();
  if (isErr(listed)) throw new Error(listed.error.message);
  return listed.value.items[0] ?? null;
}

async function pollFor<T>(read: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await read();
    if (found !== null) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("pollFor: timed out");
}

const uploadMedia = definePipeline({ name: "uploadMedia", steps: ["sanitize.svg", "media.upload"] });
const importMedia = definePipeline({ name: "importMedia", steps: ["media.upload"] });

describe("media.upload marks an SVG as sanitised for its own run only", () => {
  it("forgets a run once its media.upload ends, whether it succeeds, answers an Err, throws or has its input refused", async () => {
    const { kestrel, media, hooks } = await bootMedia({ delivery: "direct", publicCopy: false, pipelines: [uploadMedia] });
    const started: string[] = [];
    kestrel.observe({
      stepStart: (event) => {
        if (event.step === "media.upload") started.push(event.runId);
      },
    });
    const markedInsideTheStep: boolean[] = [];
    hooks.beforePut = async (key) => {
      markedInsideTheStep.push(media.sanitizesSvg(started.at(-1) ?? ""));
      if (key.includes("/refused")) return new Error("store busy");
      if (key.includes("/throws")) throw new Error("disk gone");
      return null;
    };
    const runs = [
      await kestrel.run("uploadMedia", { trigger: http, files: [svgFile("fine.svg")] }),
      await kestrel.run("uploadMedia", { trigger: http, files: [svgFile("refused.svg")] }),
      await kestrel.run("uploadMedia", { trigger: http, files: [svgFile("throws.svg")] }),
      await kestrel.run("uploadMedia", { trigger: http, body: { nope: 1 }, files: [svgFile("rejected.svg")] }),
    ];
    expect(runs.map((run) => run.status)).toEqual([200, 503, 500, 400]);
    expect(started).toEqual(runs.map((run) => run.runId));
    expect(markedInsideTheStep).toEqual([true, true, true]);
    expect(runs.map((run) => media.sanitizesSvg(run.runId))).toEqual([false, false, false, false]);
    await kestrel.stop();
  });

  for (const delivery of ["direct", "queue"] as const) {
    it(`marks an SVG uploaded by a pipeline an event starts through events-${delivery}, and publishes it as image/svg+xml`, async () => {
      const importOnEvent = definePipeline({ name: "importOnEvent", steps: ["probe.fileFromEvent", "sanitize.svg", "media.upload"] });
      const serve = definePipeline({ name: "serveMediaFile", steps: ["media.serve"] });
      const { kestrel, media, blobs } = await bootMedia({ delivery, publicCopy: true, pipelines: [importOnEvent, serve], triggers: [{ event: "svg.import.requested", pipeline: "importOnEvent" }] });
      await kestrel.start();
      const triggers: string[] = [];
      kestrel.observe({
        runStart: (event) => {
          if (event.pipeline === "importOnEvent") triggers.push(event.trigger.kind);
        },
      });
      await kestrel.contracts.get(EVENTS).emit("svg.import.requested", { svg: DRAWING, filename: "logo.svg" });
      const item = await pollFor(() => onlyItem(media));
      expect(triggers).toEqual(["event"]);
      expect(item.svgSanitized).toBe(true);
      expect(media.toPublicItem(item).path).toBe(`/media/${item.id}/logo.svg`);
      const copy = blobs.get(`site/media/${item.id}/logo.svg`);
      expect(copy?.contentType).toBe("image/svg+xml");
      expect(new TextDecoder().decode(copy?.data)).not.toContain("onload");
      await kestrel.stop();
    });
  }

  it("keeps a sanitising and a non-sanitising upload running at the same time apart, in both orders", async () => {
    const { kestrel, hooks } = await bootMedia({ delivery: "direct", publicCopy: false, pipelines: [uploadMedia, importMedia] });
    const gates = new Map<string, { reached: Deferred; open: Deferred }>();
    const gate = (marker: string): { reached: Deferred; open: Deferred } => {
      const created = { reached: deferred(), open: deferred() };
      gates.set(marker, created);
      return created;
    };
    hooks.beforePut = async (key) => {
      for (const [marker, held] of gates) {
        if (!key.includes(marker)) continue;
        held.reached.resolve();
        await held.open.promise;
      }
      return null;
    };

    const plainHeld = gate("/held-plain-1");
    const cleanHeld = gate("/held-clean-1");
    const plain = kestrel.run("importMedia", { trigger: http, files: [svgFile("held-plain-1.svg"), svgFile("plain-2.svg")] });
    await plainHeld.reached.promise;
    const clean = kestrel.run("uploadMedia", { trigger: http, files: [svgFile("held-clean-1.svg")] });
    await cleanHeld.reached.promise;
    plainHeld.open.resolve();
    const plainDone = await plain;
    cleanHeld.open.resolve();
    const cleanDone = await clean;
    expect(namesOf(plainDone.result)).toEqual(["held-plain-1-svg.bin", "plain-2-svg.bin"]);
    expect(namesOf(cleanDone.result)).toEqual(["held-clean-1.svg"]);

    const cleanFirst = gate("/held-clean-2");
    const clean2 = kestrel.run("uploadMedia", { trigger: http, files: [svgFile("held-clean-2.svg"), svgFile("clean-3.svg")] });
    await cleanFirst.reached.promise;
    const plain2Done = await kestrel.run("importMedia", { trigger: http, files: [svgFile("plain-4.svg")] });
    cleanFirst.open.resolve();
    const clean2Done = await clean2;
    expect(namesOf(plain2Done.result)).toEqual(["plain-4-svg.bin"]);
    expect(namesOf(clean2Done.result)).toEqual(["held-clean-2.svg", "clean-3.svg"]);
    await kestrel.stop();
  });
});
