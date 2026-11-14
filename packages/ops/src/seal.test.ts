import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPLICATION_PACKAGE } from "./context.ts";
import { jsonBytes } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { listGenerations, sealOf } from "./replica.ts";
import { localTarget } from "./target.ts";

describe("seal of a stopped replica", () => {
  it("reads sealed.json first, whatever the target reports about the runtime", async () => {
    const store = memoryStore(new MemoryBucket("seal"));
    await store.put("database/gen/20261114T120000Z/snapshot.db", new Uint8Array([1]));
    await store.put("database/gen/20261114T120000Z/sealed.json", jsonBytes({ lineage: 1, lastFrame: 4, at: 1 }));
    await store.put("database/gen/20261114T130000Z/snapshot.db", new Uint8Array([1]));
    const [withSeal, withoutSeal] = await listGenerations(store, "database/");
    if (!withSeal || !withoutSeal) throw new Error("two generations expected");
    const states = async (runtime: string | null) => [(await sealOf(store, "database/", withSeal, runtime)).state, (await sealOf(store, "database/", withoutSeal, runtime)).state];
    expect(await states(null)).toEqual(["sealed", "unknown"]);
    expect(await states("5.8.1")).toEqual(["sealed", "unsupported"]);
    expect(await states("6.0.0")).toEqual(["sealed", "unsealed"]);
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
