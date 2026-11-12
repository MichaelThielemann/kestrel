import { describe, expect, it } from "vitest";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { type Context } from "@michaelthielemann/kestrel/context";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import module, { configSchema } from "./module.ts";
import type { Media } from "./impl.ts";

function memoryBlobs(): Blobstore {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    async put(key, data, options) { blobs.set(key, { data, contentType: options?.contentType ?? "application/octet-stream" }); return ok(); },
    async get(key) { return ok(blobs.get(key)?.data ?? null); },
    async remove(key) { blobs.delete(key); return ok(); },
    async move(from, to) { const b = blobs.get(from); if (!b) return err(failure("NOT_FOUND", `${from} not found`)); blobs.set(to, b); blobs.delete(from); return ok(); },
    async list(prefix) { return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.data.byteLength }))); },
  };
}

const DAY = 86_400_000;

async function instance(overrides: Record<string, unknown> = {}): Promise<Media> {
  const blobs = memoryBlobs();
  const db = createFakePersistence();
  const parsed = configSchema.parse({ allowedTypes: ["image/*"], publicCopy: { prefix: "site/" }, ...overrides });
  return boundaryCast<Media>(
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
}

async function put(media: Media, filename: string, folder = ""): Promise<string> {
  return expectOk(await media.upload({ filename, contentType: "image/png", data: new Uint8Array([filename.length, 1]) }, folder)).item.id;
}

function run(media: Media, steps: string[], input: Parameters<typeof runPipeline>[1] = {}, extra: Record<string, (ctx: Context) => Promise<ReturnType<typeof ok<Context>>>> = {}) {
  return runPipeline(definePipeline({ name: "test", steps }), input, { modules: [{ module, instance: media }], steps: extra });
}

const tooMany = Array.from({ length: 201 }, (_, i) => `id-${i}`);

describe("media/default configSchema: trashRetentionDays", () => {
  it("defaults to 30 and takes a whole number of at least one day", () => {
    expect(configSchema.parse({}).trashRetentionDays).toBe(30);
    expect(configSchema.parse({ trashRetentionDays: 1 }).trashRetentionDays).toBe(1);
    expect(configSchema.safeParse({ trashRetentionDays: 0 }).success).toBe(false);
    expect(configSchema.safeParse({ trashRetentionDays: 1.5 }).success).toBe(false);
  });
});

describe("media/default trash steps", () => {
  it("media.trash moves body.ids to the trash and answers per id", async () => {
    const media = await instance();
    const id = await put(media, "a.png");
    const res = await run(media, ["media.trash"], { body: { ids: [id, "no-such-id"] } });
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ ids: [id], unchanged: [], skipped: [{ id: "no-such-id", reason: "not_found" }], trashVersions: { [id]: 1 } });
    expect(expectOk(await media.get(id))).toBeNull();
    const again = await run(media, ["media.trash"], { body: { ids: [id] } });
    expect(again.result).toEqual({ ids: [id], unchanged: [id], skipped: [], trashVersions: { [id]: 1 } });
  });

  it("media.trash, media.restore, media.selectTrash and media.purge refuse more than 200 ids or none with 400", async () => {
    const media = await instance();
    for (const step of ["media.trash", "media.restore", "media.selectTrash", "media.purge"]) {
      expect((await run(media, [step], { body: { ids: tooMany } })).status, step).toBe(400);
      if (step !== "media.purge") expect((await run(media, [step], { body: { ids: [] } })).status, step).toBe(400);
    }
    expect((await run(media, ["media.purge"], {})).status).toBe(400);
  });

  it("media.trashFolder trashes a folder's subtree, and answers 404 for an unknown folder", async () => {
    const media = await instance();
    const a = await put(media, "a.png", "box");
    const b = await put(media, "b.png", "box/inner");
    const res = await run(media, ["media.trashFolder"], { params: { path: "box" } });
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ path: "box", ids: [a, b], unchanged: [], trashVersions: { [a]: 1, [b]: 1 } });
    expect((await run(media, ["media.trashFolder"], { params: { path: "nowhere" } })).status).toBe(404);
  });

  it("media.restore answers per id and names a renamed item", async () => {
    const media = await instance();
    const id = await put(media, "a.png");
    expectOk(await media.trash([id]));
    await put(media, "a.png");
    const res = await run(media, ["media.restore"], { body: { ids: [id] } });
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ ids: [id], unchanged: [], skipped: [], renamed: [{ id, from: "a.png", to: "a-2.png" }], trashVersions: { [id]: 2 } });
  });

  it("media.listTrash pages the trash with trashedAt and expiresAt and no public path", async () => {
    const media = await instance({ trashRetentionDays: 7 });
    const id = await put(media, "a.png", "box");
    await put(media, "b.png");
    expectOk(await media.trash([id]));
    const res = await run(media, ["media.listTrash"], { query: { limit: "10", offset: "0", q: "a" } });
    expect(res.status).toBe(200);
    const page = boundaryCast<{ total: number; items: Array<Record<string, unknown>> }>(res.result, "host");
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ id, filename: "a.png", folder: "box", path: null });
    expect(Number(page.items[0]!.expiresAt) - Number(page.items[0]!.trashedAt)).toBe(7 * DAY);
    for (const field of ["key", "checksum", "status", "location"]) expect(field in page.items[0]!).toBe(false);
  });
});

describe("media/default purge steps", () => {
  it("media.selectTrash keeps the trashed ids of body.ids, and media.purge removes them", async () => {
    const media = await instance();
    const gone = await put(media, "gone.png");
    const live = await put(media, "live.png");
    expectOk(await media.trash([gone]));
    const selected = await run(media, ["media.selectTrash"], { body: { ids: [gone, live] } });
    expect(selected.result).toEqual({ ids: [gone], skipped: [{ id: live, reason: "not_trashed" }] });
    const purged = await run(media, ["media.selectTrash", "media.purge"], { body: { ids: [gone, live] } });
    expect(purged.status).toBe(200);
    expect(purged.result).toEqual({ ids: [gone], skipped: [{ id: live, reason: "not_trashed" }] });
    expect(expectOk(await media.file(gone))).toBeNull();
    expect(expectOk(await media.file(live))).not.toBeNull();
  });

  it("media.purge works on body.ids alone", async () => {
    const media = await instance();
    const gone = await put(media, "gone.png");
    expectOk(await media.trash([gone]));
    const purged = await run(media, ["media.purge"], { body: { ids: [gone] } });
    expect(purged.result).toEqual({ ids: [gone], skipped: [] });
  });

  it("media.purge takes result.ids from an earlier step, keeps the ids it dropped as skipped, and has no 200 cap there", async () => {
    const media = await instance();
    const gone = await put(media, "gone.png");
    const kept = await put(media, "kept.png");
    expectOk(await media.trash([gone, kept]));
    const filtered = { "filter.drop": async (ctx: Context) => ok({ ...ctx, result: { ids: [gone, ...tooMany], skipped: [{ id: kept, reason: "referenced" }] } }) };
    const purged = await run(media, ["filter.drop", "media.purge"], {}, filtered);
    expect(purged.status).toBe(200);
    const result = boundaryCast<{ ids: string[]; skipped: Array<{ id: string; reason: string }> }>(purged.result, "host");
    expect(result.ids).toEqual([gone]);
    expect(result.skipped[0]).toEqual({ id: kept, reason: "referenced" });
    expect(result.skipped).toHaveLength(202);
    expect(expectOk(await media.file(kept))).not.toBeNull();
  });

  it("media.selectAllTrash and media.selectExpiredTrash select the whole trash or the part past its retention", async () => {
    const media = await instance({ trashRetentionDays: 1 });
    const gone = await put(media, "gone.png");
    expectOk(await media.trash([gone]));
    expect((await run(media, ["media.selectAllTrash"])).result).toEqual({ ids: [gone], skipped: [] });
    expect((await run(media, ["media.selectExpiredTrash"])).result).toEqual({ ids: [], skipped: [] });
    const purged = await run(media, ["media.selectAllTrash", "media.purge"]);
    expect(purged.result).toEqual({ ids: [gone], skipped: [] });
  });
});

describe("media/default describe: remove stays the final delete", () => {
  it("keeps the summaries of remove and removeFolder", () => {
    const described = module.describe!({ publicCopyEnabled: () => false, listLimits: () => ({ max: 200, fallback: 200 }) });
    expect(described.remove?.summary).toBe("Delete file and metadata: end the item's readiness, then remove copy, blob and row, then a final sweep");
    expect(described.removeFolder?.summary).toBe("Delete a folder and everything in it (each item as media.remove)");
  });
});
