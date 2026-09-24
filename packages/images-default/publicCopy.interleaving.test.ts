import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
import { err, ok, type Result } from "@michaelthielemann/kestrel/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { countGateCalls, patchGate, runSequential, runWithGapAt } from "../../test-fixtures/interleave.ts";
import { createMediaDefault, type Config as MediaConfig, type Media } from "../media-default/impl.ts";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_RENDER_TIMEOUT_MS, RETIRED, VARIANTS, createImages, whenIdle, type Config, type Images, type Retired, type Variant } from "./impl.ts";
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

const BLOB_METHODS = ["put", "get", "remove", "move", "list"] as const;
const PERSISTENCE_METHODS = ["createOne", "createMany", "findOne", "findMany", "count", "updateOne", "updateMany", "deleteOne", "deleteMany"] as const;

const noLogger: Logger = { step() {}, info() {}, error() {} };
const THUMB: Size = { name: "thumb", width: 32, fit: "inside", format: "webp", quality: 82 };
const HERO: Size = { name: "hero", width: 48, fit: "inside", format: "original", quality: 82 };
const MEDIA_CONFIG: MediaConfig = { allowedTypes: ["*"], deniedTypes: [], maxBytes: 1_000_000, locales: [], prefix: "media/", publicPath: "/media", publicCopy: { prefix: "site/" }, uploadStaleAfterMs: 900000, anonymousList: "ids" };
const IMAGES_CONFIG: Config = { prefix: "media-variants/", publicPath: "/media", publicCopy: { prefix: "site/" }, media: { collection: "media_items" }, chunk: 20, staleAfterMs: 60000, maxAttempts: DEFAULT_MAX_ATTEMPTS, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS, sizes: [THUMB, HERO] };
const renderer: Renderer = async (_data, size, planned) => ({ data: new Uint8Array([7, size.name.length, planned.width]), width: planned.width, height: planned.height, format: planned.format, ext: planned.format, contentType: `image/${planned.format}` });

let photo: Uint8Array | null = null;
async function photoBytes(): Promise<Uint8Array> {
  photo ??= await sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  return photo;
}

interface World {
  blobs: MemoryBlobstore;
  db: FakePersistence;
  media: Media;
  writer: Images;
  deleter: Images;
  id: string;
}

type Op = (w: World) => Promise<void>;

async function openWorld(sizes: Size[] = [THUMB, HERO]): Promise<World> {
  const blobs = memoryBlobstore();
  const db = createFakePersistence();
  const media = await createMediaDefault(MEDIA_CONFIG, blobs, db, noLogger);
  const open = (): Promise<Images> => createImages({ ...IMAGES_CONFIG, sizes }, { blobs, db, logger: noLogger, render: renderer }, () => 1000);
  return { blobs, db, media, writer: await open(), deleter: await open(), id: "" };
}

async function upload(w: World, name = "photo.jpg"): Promise<string> {
  return expectOk(await w.media.upload({ filename: name, contentType: "image/jpeg", data: await photoBytes() })).item.id;
}

async function withInstances(w: World, sizes: Size[]): Promise<World> {
  const open = (): Promise<Images> => createImages({ ...IMAGES_CONFIG, sizes }, { blobs: w.blobs, db: w.db, logger: noLogger, render: renderer }, () => 1000);
  return { ...w, writer: await open(), deleter: await open() };
}

function gated(w: World): World {
  patchGate(w.blobs, BLOB_METHODS);
  patchGate(w.db, PERSISTENCE_METHODS);
  return w;
}

async function uploaded(): Promise<World> {
  const w = await openWorld();
  w.id = await upload(w);
  return gated(w);
}

async function placed(): Promise<World> {
  const w = await openWorld();
  w.id = await upload(w);
  expectOk(await w.writer.plan([w.id]));
  return gated(w);
}

const deleteItem: Op = async (w) => {
  expectOk(await w.media.remove(w.id));
  expectOk(await w.deleter.remove(w.id));
};
const deleteVariantsFirst: Op = async (w) => {
  expectOk(await w.deleter.remove(w.id));
  expectOk(await w.media.remove(w.id));
};
function okOrDeletedMeanwhile(outcome: Result<unknown, KestrelError>): void {
  if (outcome.ok) return;
  expect(outcome.error.code).toBe("INTERNAL");
  expect(outcome.error.message).toMatch(/is missing from the blob store/);
}
const planByWriter: Op = async (w) => {
  okOrDeletedMeanwhile(await w.writer.plan([w.id]));
};
const planByOther: Op = async (w) => {
  expectOk(await w.deleter.plan([w.id]));
};
const generateByWriter: Op = async (w) => {
  okOrDeletedMeanwhile(await w.writer.generate(w.id));
};
const generateByOther: Op = async (w) => {
  expectOk(await w.deleter.generate(w.id));
};
const syncByWriter: Op = async (w) => {
  expectOk(await w.writer.syncPublic());
};

function nameOf(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

async function settle(w: World): Promise<void> {
  await whenIdle(w.writer);
  await whenIdle(w.deleter);
}

async function violations(w: World): Promise<string[]> {
  await settle(w);
  const found: string[] = [];
  const mediaRows = new Map(expectOk(await w.db.findMany<{ id: string; status: string; key: string }>("media_items", {})).items.map((row) => [row.id, row]));
  const variants = expectOk(await w.db.findMany<Variant>(VARIANTS, {})).items;
  const retired = expectOk(await w.db.findMany<Retired>(RETIRED, {})).items;
  const live = (id: string): boolean => mediaRows.get(id)?.status === "ready";
  for (const key of w.blobs.blobs.keys()) {
    if (key.startsWith("site/media/")) {
      const parts = key.slice("site/media/".length).split("/");
      const id = parts[0]!;
      if (!live(id)) found.push(`copy of a deleted item: ${key}`);
      else if (parts.length === 2 && parts[1] !== nameOf(mediaRows.get(id)!.key)) found.push(`foreign original copy: ${key}`);
      else if (parts.length === 3 && !variants.some((v) => v.mediaId === id && nameOf(v.key) === parts[2]) && !retired.some((r) => r.mediaId === id && r.file === parts[2])) found.push(`variant copy without owner: ${key}`);
    }
    if (key.startsWith("media-variants/") && !live(key.split("/")[1]!)) found.push(`private variant of a deleted item: ${key}`);
  }
  for (const row of variants) {
    if (!live(row.mediaId)) found.push(`variant row of a deleted item: ${row.mediaId}/${row.size}`);
    else if (row.state !== "planned" && !w.blobs.blobs.has(`site/media/${row.mediaId}/variants/${nameOf(row.key)}`)) found.push(`listed variant without copy: ${row.mediaId}/${nameOf(row.key)}`);
  }
  for (const row of retired) {
    if (!live(row.mediaId)) found.push(`retired row of a deleted item: ${row.mediaId}/${row.file}`);
    else if (!w.blobs.blobs.has(`site/media/${row.mediaId}/variants/${row.file}`)) found.push(`retired path without copy: ${row.mediaId}/${row.file}`);
  }
  const perSlot = new Map<string, number>();
  for (const row of variants) perSlot.set(`${row.mediaId}/${row.size}`, (perSlot.get(`${row.mediaId}/${row.size}`) ?? 0) + 1);
  for (const [slot, n] of perSlot) if (n > 1) found.push(`${n} rows for ${slot}`);
  return found;
}

async function copiesMatchTheContentRule(w: World): Promise<string[]> {
  const found: string[] = [];
  const mediaRows = new Map(expectOk(await w.db.findMany<{ id: string; key: string }>("media_items", {})).items.map((row) => [row.id, row]));
  for (const row of expectOk(await w.db.findMany<Variant>(VARIANTS, {})).items) {
    if (row.state === "planned") continue;
    const copy = w.blobs.blobs.get(`site/media/${row.mediaId}/variants/${nameOf(row.key)}`)?.data;
    const expected = w.blobs.blobs.get(row.key)?.data ?? w.blobs.blobs.get(mediaRows.get(row.mediaId)?.key ?? "")?.data;
    if (copy === undefined || expected === undefined || Buffer.compare(Buffer.from(copy), Buffer.from(expected)) !== 0) found.push(`${row.mediaId}/${nameOf(row.key)} (${row.state}) does not hold its content`);
  }
  return found;
}

async function forEveryGap(make: () => Promise<World>, target: Op, between: Op, check: (w: World, label: string) => Promise<void>): Promise<void> {
  const probe = await make();
  const n = await countGateCalls(() => target(probe));
  expect(n).toBeGreaterThan(0);
  for (let index = 0; index < n; index++) {
    const w = await make();
    await runWithGapAt(index, () => target(w), () => between(w));
    await check(w, `gap ${index} of ${n}`);
  }
  const forward = await make();
  await runSequential(() => target(forward), () => between(forward));
  await check(forward, "target, then the other");
  const backward = await make();
  await runSequential(() => between(backward), () => target(backward));
  await check(backward, "the other, then target");
}

const holdsCopyTree = async (w: World, label: string): Promise<void> => {
  expect(await violations(w), label).toEqual([]);
};

const holdsCopyTreeAndContent = async (w: World, label: string): Promise<void> => {
  expect(await violations(w), label).toEqual([]);
  expect(await copiesMatchTheContentRule(w), label).toEqual([]);
};

describe("images/default publicCopy: a variant writer against deleting its item (media.remove, then images.remove)", { timeout: 60_000 }, () => {
  it("a render in one process leaves no copy of a deleted item whichever gap of it the delete lands in", async () => {
    await forEveryGap(placed, generateByWriter, deleteItem, holdsCopyTree);
  });

  it("an inline render that creates its rows leaves no copy of a deleted item whichever gap of it the delete lands in", async () => {
    await forEveryGap(uploaded, generateByWriter, deleteItem, holdsCopyTree);
  });

  it("a delete leaves no copy behind whichever gap of it a render in another process lands in", async () => {
    await forEveryGap(placed, deleteItem, generateByWriter, holdsCopyTree);
  });

  it("a plan leaves no copy or row of a deleted item whichever gap of it the delete lands in", async () => {
    await forEveryGap(uploaded, planByWriter, deleteItem, holdsCopyTree);
  });

  it("a delete leaves no copy behind whichever gap of it a plan in another process lands in", async () => {
    await forEveryGap(uploaded, deleteItem, planByWriter, holdsCopyTree);
  });

  it("deleting the variants before the media row lets a plan publish a copy of a deleted item", async () => {
    const probe = await uploaded();
    const n = await countGateCalls(() => deleteVariantsFirst(probe));
    let violated = 0;
    for (let index = 0; index < n; index++) {
      const w = await uploaded();
      await runWithGapAt(index, () => deleteVariantsFirst(w), () => planByWriter(w));
      if ((await violations(w)).length > 0) violated += 1;
    }
    expect(violated).toBeGreaterThan(0);
  });
});

describe("images/default publicCopy: two writers of one item", { timeout: 60_000 }, () => {
  it("two planners in different processes leave one row per size, each with the original at its path", async () => {
    await forEveryGap(uploaded, planByWriter, planByOther, holdsCopyTreeAndContent);
  });

  it("a plan never leaves its placeholder over a render of another process, whichever gap of the plan the render lands in", async () => {
    await forEveryGap(uploaded, planByWriter, generateByOther, holdsCopyTreeAndContent);
  });

  it("a render is never left under a placeholder of another process, whichever gap of the render the plan lands in", async () => {
    await forEveryGap(uploaded, generateByWriter, planByOther, holdsCopyTreeAndContent);
  });
});

describe("images/default publicCopy: images.syncPublic against the lifecycle", { timeout: 60_000 }, () => {
  async function renderedWithMissingCopies(): Promise<World> {
    const w = await openWorld();
    w.id = await upload(w);
    expectOk(await w.writer.plan([w.id]));
    expectOk(await w.writer.generate(w.id));
    w.blobs.blobs.delete(`site/media/${w.id}/variants/thumb.webp`);
    w.blobs.blobs.set(`site/media/${w.id}/variants/hero.jpg`, { data: new Uint8Array([1]), contentType: "image/jpeg" });
    return gated(w);
  }

  it("never leaves a copy of a deleted item whichever gap of the sync the delete lands in", async () => {
    await forEveryGap(renderedWithMissingCopies, syncByWriter, deleteItem, holdsCopyTree);
  });

  it("a delete leaves no copy behind whichever gap of it the sync lands in", async () => {
    await forEveryGap(renderedWithMissingCopies, deleteItem, syncByWriter, holdsCopyTree);
  });

  async function prunable(): Promise<World> {
    const w = await openWorld();
    w.id = await upload(w);
    expectOk(await w.writer.plan([w.id]));
    expectOk(await w.writer.generate(w.id));
    w.blobs.blobs.delete(`site/media/${w.id}/variants/thumb.webp`);
    return gated(await withInstances(w, [THUMB]));
  }
  const prune: Op = async (w) => {
    expectOk(await w.deleter.prune(["hero"]));
  };
  const answersEveryPath = async (w: World, label: string): Promise<void> => {
    await holdsCopyTree(w, label);
    for (const file of ["thumb.webp", "hero.jpg"]) {
      expect(w.blobs.blobs.has(`site/media/${w.id}/variants/${file}`), `${label}: ${file}`).toBe(true);
      expect(expectOk(await w.writer.read(w.id, file)), `${label}: ${file}`).not.toBeNull();
    }
  };

  it("a prune keeps every listed path answering whichever gap of the sync it lands in", async () => {
    await forEveryGap(prunable, syncByWriter, prune, answersEveryPath);
  });

  it("a sync keeps every listed path answering whichever gap of a prune it lands in", async () => {
    await forEveryGap(prunable, prune, syncByWriter, answersEveryPath);
  });

  async function reformattable(): Promise<World> {
    const w = await openWorld();
    w.id = await upload(w);
    expectOk(await w.writer.plan([w.id]));
    expectOk(await w.writer.generate(w.id));
    w.blobs.blobs.delete(`site/media/${w.id}/variants/thumb.webp`);
    return gated(await withInstances(w, [THUMB, { ...HERO, format: "webp" }]));
  }
  const answersOldAndNewPaths = async (w: World, label: string): Promise<void> => {
    await holdsCopyTree(w, label);
    for (const file of ["thumb.webp", "hero.jpg"]) {
      expect(w.blobs.blobs.has(`site/media/${w.id}/variants/${file}`), `${label}: ${file}`).toBe(true);
      expect(expectOk(await w.writer.read(w.id, file)), `${label}: ${file}`).not.toBeNull();
    }
    const hero = expectOk(await w.db.findMany<Variant>(VARIANTS, { mediaId: w.id, size: "hero" })).items;
    expect(hero.map((row) => nameOf(row.key)), label).toEqual(["hero.webp"]);
  };

  it("a format change keeps the old path answering whichever gap of the sync it lands in", async () => {
    await forEveryGap(reformattable, syncByWriter, planByOther, answersOldAndNewPaths);
  });

  it("a sync keeps the old path answering whichever gap of a format change it lands in", async () => {
    await forEveryGap(reformattable, planByOther, syncByWriter, answersOldAndNewPaths);
  });

  async function oneItemRendered(): Promise<World> {
    const w = await openWorld();
    w.id = await upload(w);
    expectOk(await w.writer.plan([w.id]));
    expectOk(await w.writer.generate(w.id));
    return gated(w);
  }
  let fresh = "";
  const uploadAndPlanElsewhere: Op = async (w) => {
    fresh = await upload(w, "fresh.jpg");
    expectOk(await w.deleter.plan([fresh]));
  };
  const freshItemIsPlaced = async (w: World, label: string): Promise<void> => {
    await holdsCopyTree(w, label);
    const rows = expectOk(await w.db.findMany<Variant>(VARIANTS, { mediaId: fresh })).items;
    expect(rows.map((row) => row.size).sort(), label).toEqual(["hero", "thumb"]);
    for (const row of rows) expect(row.state, label).not.toBe("planned");
  };

  it("keeps the rows and copies of an item uploaded and placed in another process whichever gap of the sync it lands in", async () => {
    await forEveryGap(oneItemRendered, syncByWriter, uploadAndPlanElsewhere, freshItemIsPlaced);
  });

  it("an upload and its plan keep their rows and copies whichever gap of them the sync lands in", async () => {
    await forEveryGap(oneItemRendered, uploadAndPlanElsewhere, syncByWriter, freshItemIsPlaced);
  });
});

describe("images/default publicCopy: images.syncPublic over more than one page", { timeout: 60_000 }, () => {
  const ITEMS = 101;
  async function library(): Promise<World & { ids: string[] }> {
    const w = await openWorld([THUMB, HERO, { name: "small", width: 40, fit: "inside", format: "webp", quality: 82 }, { name: "medium", width: 44, fit: "inside", format: "webp", quality: 82 }, { name: "large", width: 46, fit: "inside", format: "webp", quality: 82 }]);
    for (let i = 0; i < 5; i++) {
      expectOk(await w.db.createOne(VARIANTS, { mediaId: "gone", size: `s${i}`, slot: `gone/s${i}`, spec: "x", width: 1, height: 1, format: "webp", key: `media-variants/gone/s${i}.webp`, bytes: 0, state: "pending", error: null, attempts: 0, updatedAt: 1 }));
    }
    const ids: string[] = [];
    for (let i = 0; i < ITEMS; i++) {
      const id = await upload(w, `p${i}.jpg`);
      ids.push(id);
      expectOk(await w.writer.plan([id]));
    }
    w.id = ids[0]!;
    w.blobs.blobs.delete(`site/media/${ids[ITEMS - 1]!}/variants/thumb.webp`);
    patchGate(w.db, ["findMany"]);
    return { ...w, ids };
  }

  it("keeps every live copy and writes the missing one whichever page read a delete lands before", async () => {
    const probe = await library();
    const n = await countGateCalls(() => syncByWriter(probe));
    expect(n).toBeGreaterThan(4);
    for (let index = 0; index < n; index++) {
      const w = await library();
      await runWithGapAt(index, () => syncByWriter(w), () => deleteItem(w));
      const label = `page read ${index} of ${n}`;
      expect(await violations(w), label).toEqual([]);
      for (const id of w.ids.slice(1)) expect(w.blobs.blobs.has(`site/media/${id}/variants/thumb.webp`), `${label}: ${id}`).toBe(true);
      expect(expectOk(await w.db.count(VARIANTS, { mediaId: "gone" })), label).toBe(0);
    }
  });
});

describe("images/default publicCopy: a TRANSIENT failure at each call of a deleting operation, then a retry", { timeout: 60_000 }, () => {
  type Methods = Record<string, (...args: unknown[]) => Promise<unknown>>;
  function intercept(w: World, onCall: (index: number) => boolean): () => void {
    let call = 0;
    const restore: Array<() => void> = [];
    for (const [object, methods] of [[w.blobs, BLOB_METHODS], [w.db, PERSISTENCE_METHODS]] as const) {
      const mutable = boundaryCast<Methods>(object, "host");
      for (const method of methods) {
        const original = mutable[method]!;
        mutable[method] = async (...args: unknown[]) => (onCall(call++) ? err(failure("TRANSIENT", "injected")) : original.apply(object, args));
        restore.push(() => {
          mutable[method] = original;
        });
      }
    }
    return () => {
      for (const undo of restore) undo();
    };
  }

  async function failEachCallThenRetry(make: () => Promise<World>, op: (w: World) => Promise<Result<unknown, unknown>>, retry: (w: World) => Promise<void>, check: (w: World, label: string) => Promise<void>): Promise<void> {
    const probe = await make();
    let n = 0;
    const stopCounting = intercept(probe, () => {
      n += 1;
      return false;
    });
    expect((await op(probe)).ok).toBe(true);
    stopCounting();
    for (let failAt = 0; failAt < n; failAt++) {
      const w = await make();
      const stopFailing = intercept(w, (index) => index === failAt);
      const first = await op(w);
      stopFailing();
      expect(first.ok, `failure injected at call ${failAt}`).toBe(false);
      await retry(w);
      await check(w, `failure at call ${failAt} of ${n}, then a retry`);
    }
  }

  async function renderedPlain(folder = ""): Promise<World> {
    const w = await openWorld();
    w.id = expectOk(await w.media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: await photoBytes() }, folder)).item.id;
    expectOk(await w.writer.plan([w.id]));
    expectOk(await w.writer.generate(w.id));
    return w;
  }

  it("images.remove after media.remove leaves nothing of the item once retried", async () => {
    await failEachCallThenRetry(
      async () => {
        const w = await renderedPlain();
        expectOk(await w.media.remove(w.id));
        return w;
      },
      (w) => w.deleter.remove(w.id),
      async (w) => {
        expectOk(await w.deleter.remove(w.id));
      },
      holdsCopyTree,
    );
  });

  it("media.removeFolder, then images.remove of the ids it removed, leave nothing of the item once retried and synced", async () => {
    const removeFolder = async (w: World): Promise<Result<unknown, unknown>> => {
      const removed = await w.media.removeFolder("shoot");
      if (!removed.ok) return removed;
      for (const id of removed.value?.ids ?? []) {
        const dropped = await w.deleter.remove(id);
        if (!dropped.ok) return dropped;
      }
      return ok(undefined);
    };
    await failEachCallThenRetry(
      () => renderedPlain("shoot"),
      removeFolder,
      async (w) => {
        expect((await removeFolder(w)).ok).toBe(true);
        expectOk(await w.writer.syncPublic());
      },
      holdsCopyTree,
    );
  });

  it("images.prune keeps every pruned path answering, and a retry finishes it", async () => {
    await failEachCallThenRetry(
      async () => withInstances(await renderedPlain(), [THUMB]),
      (w) => w.deleter.prune(["hero"]),
      async (w) => {
        if (expectOk(await w.db.count(VARIANTS, { size: "hero" })) > 0) expectOk(await w.deleter.prune(["hero"]));
      },
      async (w, label) => {
        await holdsCopyTree(w, label);
        expect(expectOk(await w.db.count(VARIANTS, { size: "hero" })), label).toBe(0);
        expect(w.blobs.blobs.has(`site/media/${w.id}/variants/hero.jpg`), label).toBe(true);
        expect(expectOk(await w.writer.read(w.id, "hero.jpg"))?.variant, label).toBe("original");
      },
    );
  });
});
