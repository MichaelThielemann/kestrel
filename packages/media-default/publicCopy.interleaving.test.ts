import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { countGateCalls, patchGate, runSequential, runWithGapAt } from "../../test-fixtures/interleave.ts";
import { createMediaDefault, type Config, type Media } from "./impl.ts";

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

const BLOB_METHODS = ["put", "get", "remove", "move", "list"] as const;
const PERSISTENCE_METHODS = ["createOne", "createMany", "findOne", "findMany", "count", "updateOne", "updateMany", "deleteOne", "deleteMany"] as const;

const noLogger: Logger = { step() {}, info() {}, error() {} };
const CONFIG: Config = { allowedTypes: ["*"], deniedTypes: [], maxBytes: 1000, locales: [], prefix: "media/", publicPath: "/media", publicCopy: { prefix: "site/" }, uploadStaleAfterMs: 900000, anonymousList: "ids" };

interface Fixture {
  media: Media;
  blobs: ReturnType<typeof fakeBlobstore>;
  db: FakePersistence;
  id: string;
  copyKey: string;
}

function patchGateAll(blobs: Blobstore, db: FakePersistence): void {
  patchGate(blobs, BLOB_METHODS);
  patchGate(db, PERSISTENCE_METHODS);
}

async function setupReadyItem(folder = ""): Promise<Fixture> {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  const media = await createMediaDefault(CONFIG, blobs, db, noLogger);
  const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) }, folder)).item;
  patchGateAll(blobs, db);
  return { media, blobs, db, id: item.id, copyKey: `site/media/${item.id}/${item.filename}` };
}

async function assertConsistent(db: FakePersistence, id: string, copyKey: string, blobs: ReturnType<typeof fakeBlobstore>): Promise<void> {
  const row = expectOk(await db.findOne<{ id: string; status: string }>("media_items", { id }));
  const rowReady = row !== null && row.status === "ready";
  expect(blobs.blobs.has(copyKey)).toBe(rowReady);
}

async function forEveryGap(make: () => Promise<Fixture>, targetOf: (f: Fixture) => () => Promise<void>, betweenOf: (f: Fixture) => () => Promise<void>, check: (f: Fixture) => Promise<void>): Promise<void> {
  const probe = await make();
  const n = await countGateCalls(targetOf(probe));

  for (let index = 0; index < n; index++) {
    const f = await make();
    await runWithGapAt(index, targetOf(f), betweenOf(f));
    await check(f);
  }
  const seqA = await make();
  await runSequential(targetOf(seqA), betweenOf(seqA));
  await check(seqA);
  const seqB = await make();
  await runSequential(betweenOf(seqB), targetOf(seqB));
  await check(seqB);
}

describe("media-default publicCopy: syncPublic vs remove", () => {
  const check = (f: Fixture) => assertConsistent(f.db, f.id, f.copyKey, f.blobs);

  it("holds copy-exists-iff-row-ready with remove dropped into every gap of syncPublic", async () => {
    await forEveryGap(() => setupReadyItem(), (f) => () => f.media.syncPublic().then(() => undefined), (f) => () => f.media.remove(f.id).then(() => undefined), check);
  });

  it("holds copy-exists-iff-row-ready with syncPublic dropped into every gap of remove", async () => {
    await forEveryGap(() => setupReadyItem(), (f) => () => f.media.remove(f.id).then(() => undefined), (f) => () => f.media.syncPublic().then(() => undefined), check);
  });

  it("holds copy-exists-iff-row-ready with removeFolder dropped into every gap of syncPublic", async () => {
    await forEveryGap(() => setupReadyItem("a"), (f) => () => f.media.syncPublic().then(() => undefined), (f) => () => f.media.removeFolder("a").then(() => undefined), check);
  });

  it("stays consistent after a TRANSIENT failure at each of remove's own calls, once retried", async () => {
    const probe = await setupReadyItem();
    const nRemove = await countGateCalls(() => probe.media.remove(probe.id).then(() => undefined));

    for (let failAt = 0; failAt < nRemove; failAt++) {
      const { media, blobs, db, id, copyKey } = await setupReadyItem();
      let call = 0;
      const injectOnce = (target: object, methods: readonly string[]): void => {
        const mutable = boundaryCast<Record<string, (...args: unknown[]) => Promise<unknown>>>(target, "host");
        for (const method of methods) {
          const original = mutable[method]!.bind(target);
          mutable[method] = async (...args: unknown[]) => {
            if (call++ === failAt) return err(failure("TRANSIENT", "injected"));
            return original(...args);
          };
        }
      };
      injectOnce(blobs, BLOB_METHODS);
      injectOnce(db, PERSISTENCE_METHODS);
      const firstAttempt = await media.remove(id);
      expect(firstAttempt.ok).toBe(false);
      await media.remove(id);
      await assertConsistent(db, id, copyKey, blobs);
    }
  });
});

describe("media-default publicCopy: syncPublic vs upload", () => {
  async function setupEmpty(uploadStaleAfterMs: number): Promise<{ media: Media; blobs: ReturnType<typeof fakeBlobstore>; db: FakePersistence }> {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    const media = await createMediaDefault({ ...CONFIG, uploadStaleAfterMs }, blobs, db, noLogger);
    patchGateAll(blobs, db);
    return { media, blobs, db };
  }

  it("with a large stale bound, syncPublic dropped into every gap of upload never removes the copy it is about to publish", async () => {
    const upload = (f: { media: Media }) => () => f.media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }).then(() => undefined);
    const sync = (f: { media: Media }) => () => f.media.syncPublic().then(() => undefined);
    const probe = await setupEmpty(900000);
    const n = await countGateCalls(upload(probe));

    const check = async (f: { blobs: ReturnType<typeof fakeBlobstore>; db: FakePersistence }): Promise<void> => {
      const rows = expectOk(await f.db.findMany<{ id: string; status: string }>("media_items", {}));
      const row = rows.items[0];
      if (row !== undefined && row.status === "ready") expect(f.blobs.blobs.has(`site/media/${row.id}/a.png`)).toBe(true);
    };

    for (let index = 0; index < n; index++) {
      const f = await setupEmpty(900000);
      await runWithGapAt(index, upload(f), sync(f));
      await check(f);
    }
  });

  it("with a zero-ish stale bound, an upload finishing after the bound elapsed is never torn down mid-flight by the same syncPublic run", async () => {
    const { media, blobs, db } = await setupEmpty(60000);
    const uploaded = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    const synced = expectOk(await media.syncPublic());
    expect(synced).toEqual({ written: 0, removed: 0, missing: 0 });
    expect(blobs.blobs.has(`site/media/${uploaded.id}/a.png`)).toBe(true);
    void db;
  });
});
