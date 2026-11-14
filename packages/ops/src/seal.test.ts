import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { REPLICATION_PACKAGE } from "./context.ts";
import { jsonBytes } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { buildDatabase, listGenerations, sealOf } from "./replica.ts";
import { createHarness, PREFIXES } from "./harness.fixture.ts";

function hide(bucket: MemoryBucket, key: string, listings: number): void {
  const object = bucket.objects.get(key);
  if (!object) throw new Error(`${key} expected`);
  object.visibleAfterLists = listings;
}
import { localTarget } from "./target.ts";

describe("seal of a stopped replica", () => {
  it("reads sealed.json first, whatever the target reports about the runtime", async () => {
    const store = memoryStore(new MemoryBucket("seal"));
    await store.put("database/gen/20261114T120000Z/snapshot.db", new Uint8Array([1]));
    await store.put("database/gen/20261114T120000Z/sealed.json", jsonBytes({ lineage: 1, lastFrame: 4, segments: 0, at: 1 }));
    await store.put("database/gen/20261114T130000Z/snapshot.db", new Uint8Array([1]));
    const [withSeal, withoutSeal] = await listGenerations(store, "database/");
    if (!withSeal || !withoutSeal) throw new Error("two generations expected");
    const states = async (runtime: string | null) => [(await sealOf(store, "database/", withSeal, runtime)).state, (await sealOf(store, "database/", withoutSeal, runtime)).state];
    expect(await states(null)).toEqual(["sealed", "unknown"]);
    expect(await states("5.8.1")).toEqual(["sealed", "unsupported"]);
    expect(await states("6.0.0")).toEqual(["sealed", "unsealed"]);
  });
});

describe("seal with a segment count", () => {
  const fast = { delayMs: 1, attempts: 20, sleep: async () => {} };
  const gen = "20261114T120000Z";
  const segment = (seq: number) => `database/gen/${gen}/wal/000001-${String(seq).padStart(6, "0")}-20261114T12000${seq}Z.wal`;

  it("reads sealed.json from the store although the listing does not show it, and lists again until every sealed segment shows", async () => {
    const bucket = new MemoryBucket("seal-lag");
    const store = memoryStore(bucket);
    await store.put(`database/gen/${gen}/snapshot.db`, new Uint8Array([1]));
    await store.put(segment(0), new Uint8Array([2]));
    await store.put(segment(1), new Uint8Array([3]));
    await store.put(`database/gen/${gen}/sealed.json`, jsonBytes({ lineage: 1, lastFrame: 9, segments: 2, at: 1 }));
    hide(bucket, segment(1), 3);
    hide(bucket, `database/gen/${gen}/sealed.json`, 10);
    const [listed] = await listGenerations(store, "database/");
    if (!listed) throw new Error("a generation expected");
    expect(listed.segments).toHaveLength(1);
    const report = await sealOf(store, "database/", listed, "6.0.0", fast);
    expect(report.state).toBe("sealed");
    expect(report.listed.segments.map((s) => s.key)).toEqual([segment(0), segment(1)]);
  });

  it("refuses, naming the generation, when the listing keeps lacking a segment the seal counts", async () => {
    const store = memoryStore(new MemoryBucket("seal-missing"));
    await store.put(`database/gen/${gen}/snapshot.db`, new Uint8Array([1]));
    await store.put(segment(0), new Uint8Array([2]));
    await store.put(`database/gen/${gen}/sealed.json`, jsonBytes({ lineage: 1, lastFrame: 9, segments: 2, at: 1 }));
    const [listed] = await listGenerations(store, "database/");
    if (!listed) throw new Error("a generation expected");
    await expect(sealOf(store, "database/", listed, "6.0.0", fast)).rejects.toThrow(`generation ${gen} is sealed with 2 segment(s), the listing shows 1`);
  });

  it("does not take a sealed.json without a segment count for a seal", async () => {
    const store = memoryStore(new MemoryBucket("seal-format"));
    await store.put(`database/gen/${gen}/snapshot.db`, new Uint8Array([1]));
    await store.put(`database/gen/${gen}/sealed.json`, jsonBytes({ lineage: 1, lastFrame: 9, at: 1 }));
    const [listed] = await listGenerations(store, "database/");
    if (!listed) throw new Error("a generation expected");
    expect((await sealOf(store, "database/", listed, "6.0.0", fast)).state).toBe("unsealed");
  });

  it("rebuilds a generation from the listing it is given, also when a later listing lags behind", async () => {
    const bucket = new MemoryBucket("build-listed");
    const store = memoryStore(bucket);
    const h = createHarness({ store });
    try {
      await h.app.start();
      await h.app.seed();
      h.app.run(`INSERT INTO pages VALUES ('late', 'Late', 'shipped last')`);
      await h.app.stop();
      const newest = (await listGenerations(store, PREFIXES.replica)).at(-1);
      const last = newest?.segments.at(-1);
      if (!newest || !last) throw new Error("a generation with segments expected");
      hide(bucket, last.key, 50);
      const out = join(h.root, "built.db");
      await buildDatabase(store, PREFIXES.replica, newest, out);
      const db = new DatabaseSync(out, { readOnly: true });
      expect(db.prepare(`SELECT "id" FROM pages WHERE "id" = 'late'`).all()).toEqual([{ id: "late" }]);
      db.close();
    } finally {
      await h.dispose();
    }
  });

  it("backs up the last frames of a sealed stop whose newest segment and seal the listing shows late", async () => {
    const bucket = new MemoryBucket("freeze-lag");
    const store = memoryStore(bucket);
    const h = createHarness({ store });
    try {
      await h.app.start();
      await h.app.seed();
      h.app.run(`INSERT INTO pages VALUES ('late', 'Late', 'shipped last')`);
      await h.app.stop();
      const newest = (await listGenerations(store, PREFIXES.replica)).at(-1);
      const last = newest?.segments.at(-1);
      const sealed = newest?.files["sealed.json"];
      if (!last || !sealed) throw new Error("a sealed generation with segments expected");
      hide(bucket, last.key, 4);
      hide(bucket, sealed.key, 4);
      const backup = await h.run(["backup", "create", "--freeze", "--yes", "--json"]);
      expect(backup.stderr).toBe("");
      expect(backup.code).toBe(0);
      expect(backup.json.manifest).toMatchObject({ source: { seal: "sealed" }, db: { rows: { pages: 4 } } });
    } finally {
      await h.dispose();
    }
  });
});

describe("segment numbers", () => {
  const fast = { delayMs: 1, attempts: 20, sleep: async () => {} };
  const gen = "20261114T120000Z";
  const segment = (seq: number, prefix = "database/") => `${prefix}gen/${gen}/wal/000001-${String(seq).padStart(6, "0")}-20261114T12000${seq}Z.wal`;

  it("counts the segments of a sealed generation under a replica prefix that itself holds /wal/", async () => {
    const store = memoryStore(new MemoryBucket("seal-nested-prefix"));
    const prefix = "site/wal/";
    await store.put(`${prefix}gen/${gen}/snapshot.db`, new Uint8Array([1]));
    await store.put(segment(0, prefix), new Uint8Array([2]));
    await store.put(segment(1, prefix), new Uint8Array([3]));
    await store.put(`${prefix}gen/${gen}/sealed.json`, jsonBytes({ lineage: 1, lastFrame: 9, segments: 2, at: 1 }));
    const [listed] = await listGenerations(store, prefix);
    if (!listed) throw new Error("a generation expected");
    expect((await sealOf(store, prefix, listed, "6.0.0", fast)).state).toBe("sealed");
  });
});

describe("local target", () => {
  it("finds the replication runtime an app gets through another package, also in a nested node_modules", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-ops-runtime-"));
    try {
      const app = join(root, "app");
      const layer = join(app, "node_modules", "@example", "layer");
      const nested = join(layer, "node_modules", ...REPLICATION_PACKAGE.split("/"));
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(app, "package.json"), JSON.stringify({ name: "site", dependencies: { "@example/layer": "2.0.0" } }));
      writeFileSync(join(layer, "package.json"), JSON.stringify({ name: "@example/layer", version: "2.0.0", dependencies: { [REPLICATION_PACKAGE]: "6.0.0" } }));
      writeFileSync(join(nested, "package.json"), JSON.stringify({ name: REPLICATION_PACKAGE, version: "6.0.0" }));
      const target = await localTarget({ dir: "app", database: "kestrel.db", command: ["node", "server.mjs"], disk: "ephemeral" }, { root, clock: Date.now });
      expect((await target.describe()).packages).toEqual({ "@example/layer": "2.0.0", [REPLICATION_PACKAGE]: "6.0.0" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
