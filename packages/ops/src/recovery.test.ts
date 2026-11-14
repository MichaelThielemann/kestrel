import { describe, expect, it } from "vitest";
import { createHarness, PREFIXES } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { listGenerations } from "./replica.ts";
import type { ObjectStore } from "./store.ts";

function failingPuts(inner: ObjectStore): { store: ObjectStore; failNext: (match: (key: string) => boolean) => void } {
  const pending: Array<(key: string) => boolean> = [];
  return {
    store: {
      ...inner,
      put: async (key, data, options) => {
        const at = pending.findIndex((match) => match(key));
        if (at >= 0) {
          pending.splice(at, 1);
          throw new Error(`connection reset writing ${key}`);
        }
        return inner.put(key, data, options);
      },
    },
    failNext: (match) => {
      pending.push(match);
    },
  };
}

async function seededWithChange(name: string) {
  const failing = failingPuts(memoryStore(new MemoryBucket(name)));
  const h = createHarness({ store: failing.store });
  await h.app.start();
  await h.app.seed();
  const backup = await h.run(["backup", "create", "--freeze", "--json"]);
  expect(backup.code).toBe(0);
  h.app.run(`UPDATE pages SET "body" = 'changed after the backup' WHERE "id" = 'home'`);
  await h.app.export();
  await h.app.sync();
  return { h, failNext: failing.failNext, id: String(backup.json.id), restoreArgs: () => ["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"] };
}

describe("a restore that failed while it placed its generation", () => {
  it("places a complete generation on the next run instead of treating the half placement as the current state", async () => {
    const { h, failNext, restoreArgs } = await seededWithChange("half-placement");
    try {
      failNext((key) => key.startsWith(PREFIXES.replica) && key.endsWith("/origin.json"));
      const first = await h.run(restoreArgs());
      expect(first.code).toBe(1);
      expect(first.stderr).toContain("the app stays stopped");
      const half = (await listGenerations(h.store, PREFIXES.replica)).at(-1);
      expect(half?.name).toMatch(/^\d{8}T\d{6}Z$/);
      expect(half?.files["origin.json"]).toBeUndefined();

      const second = await h.run(restoreArgs());
      expect(second.code).toBe(0);
      expect(second.stderr).not.toContain("stop went without teardown");
      expect(second.stderr).toContain(`generation ${half?.name ?? ""} is an unfinished placement`);
      expect(second.json).toMatchObject({ noop: false, acknowledgement: "applied" });
      const promoted = String(Reflect.get(Object(second.json.promoted), "generation"));
      expect(promoted > String(half?.name)).toBe(true);
      expect((await listGenerations(h.store, PREFIXES.replica)).find((g) => g.name === promoted)?.files["origin.json"]).toBeDefined();
      expect(h.app.restoredFrom).toBe(promoted);
      expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Home", body: "Welcome" });
    } finally {
      await h.dispose();
    }
  });

  it("names an unfinished placement as a problem in status", async () => {
    const { h, failNext, restoreArgs } = await seededWithChange("half-placement-status");
    try {
      failNext((key) => key.startsWith(PREFIXES.replica) && key.endsWith("/origin.json"));
      expect((await h.run(restoreArgs())).code).toBe(1);
      const report = await h.run(["status"]);
      expect(report.code).toBe(1);
      expect(report.stderr).toMatch(/generation \d{8}T\d{6}Z is an unfinished placement/);
    } finally {
      await h.dispose();
    }
  });
});
