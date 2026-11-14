import { describe, expect, it } from "vitest";
import { createHarness, LOCATION, PREFIXES } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { listGenerations, stableGenerations } from "./replica.ts";
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

async function seededWithChange(name: string, listLag = 0) {
  const failing = failingPuts(memoryStore(new MemoryBucket(name, { listLag })));
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
  it.each([
    ["a listing that shows every object at once", 0],
    ["a listing that lags behind writes", 1],
  ])("places a complete generation on the next run instead of treating the half placement as the current state, with %s", async (_store, listLag) => {
    const { h, failNext, restoreArgs } = await seededWithChange(`half-placement-${listLag}`, listLag);
    try {
      failNext((key) => key.startsWith(PREFIXES.replica) && key.endsWith("/origin.json"));
      const first = await h.run(restoreArgs());
      expect(first.code).toBe(1);
      expect(first.stderr).toContain("the app stays stopped");
      const half = (await stableGenerations(h.store, PREFIXES.replica, { delayMs: 5 })).at(-1);
      expect(half?.name).toMatch(/^\d{8}T\d{6}Z$/);
      expect(half?.files["origin.json"]).toBeUndefined();

      const second = await h.run(restoreArgs());
      expect(second.code).toBe(0);
      expect(second.stderr).not.toContain("stop went without teardown");
      expect(second.stderr).toContain(`generation ${half?.name ?? ""} is an unfinished placement`);
      expect(second.json).toMatchObject({ noop: false, acknowledgement: "applied" });
      const promoted = String(Reflect.get(Object(second.json.promoted), "generation"));
      expect(promoted > String(half?.name)).toBe(true);
      expect((await stableGenerations(h.store, PREFIXES.replica, { delayMs: 5 })).find((g) => g.name === promoted)?.files["origin.json"]).toBeDefined();
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

describe("a backup over a restore that failed while it placed its generation", () => {
  it("is refused, frozen or live, and names the restore to run again", async () => {
    const { h, failNext, restoreArgs } = await seededWithChange("backup-over-half-placement");
    try {
      failNext((key) => key.startsWith(PREFIXES.replica) && key.endsWith("/origin.json"));
      expect((await h.run(restoreArgs())).code).toBe(1);
      const before = (await h.store.list(LOCATION)).filter((info) => info.key.endsWith("/manifest.json")).length;
      for (const args of [["backup", "create", "--freeze", "--yes", "--answers", h.answers({ "unsealed-stop": "accept" })], ["backup", "create", "--yes"]]) {
        const refused = await h.run(args);
        expect(refused.code, args.join(" ")).toBe(1);
        expect(refused.stderr).toMatch(/generation \d{8}T\d{6}Z is an unfinished placement of a restore that failed; run that restore again/);
        expect(refused.stderr).not.toContain("stop went without teardown");
      }
      expect((await h.store.list(LOCATION)).filter((info) => info.key.endsWith("/manifest.json")).length).toBe(before);
    } finally {
      await h.dispose();
    }
  });
});

describe("a restore that stopped after it placed a complete generation", () => {
  it("starts the app from that generation on the next run without asking about an unsealed stop", async () => {
    const { h, failNext, restoreArgs } = await seededWithChange("placed-not-started");
    try {
      failNext((key) => key.endsWith("-promote-done.json"));
      const first = await h.run(restoreArgs());
      expect(first.code).toBe(1);
      expect(first.stderr).toContain("the app stays stopped");
      const placed = (await listGenerations(h.store, PREFIXES.replica)).at(-1);
      expect(placed?.files["origin.json"]).toBeDefined();

      const second = await h.run(restoreArgs());
      expect(second.stderr).not.toContain("stop went without teardown");
      expect(second.stderr).not.toContain("unsealed-stop");
      expect(second.code).toBe(0);
      expect(second.json).toMatchObject({ noop: true, safetyBackup: null });
      expect((await h.app.status()).state).toBe("started");
      expect(h.app.restoredFrom).toBe(placed?.name);
      expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Home", body: "Welcome" });
    } finally {
      await h.dispose();
    }
  });

  it("asks about an unsealed stop when the app it started from that generation is killed before a generation of its own", async () => {
    const bucket = new MemoryBucket("placed-noop-kill");
    const failing = failingPuts(memoryStore(bucket));
    const h = createHarness({ store: failing.store });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      expect(backup.code).toBe(0);
      h.app.run(`UPDATE pages SET "body" = 'changed after the backup' WHERE "id" = 'home'`);
      await h.app.export();
      await h.app.sync();
      const restoreArgs = ["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"];
      failing.failNext((key) => key.endsWith("-promote-done.json"));
      expect((await h.run(restoreArgs)).code).toBe(1);
      const placed = (await listGenerations(h.store, PREFIXES.replica)).at(-1)?.name ?? "";

      h.app.failNextBoot = true;
      const second = await h.run(restoreArgs);
      expect(second.code).toBe(0);
      expect(second.json).toMatchObject({ noop: true });
      h.app.run(`INSERT INTO pages VALUES ('news', 'News', 'Not shipped')`);
      h.app.kill();
      for (const generation of await listGenerations(h.store, PREFIXES.replica)) {
        if (generation.name <= placed) continue;
        for (const key of [...bucket.objects.keys()]) if (key.startsWith(`${PREFIXES.replica}gen/${generation.name}/`)) bucket.objects.delete(key);
      }
      expect((await listGenerations(h.store, PREFIXES.replica)).at(-1)?.name).toBe(placed);

      const frozen = await h.run(["backup", "create", "--freeze", "--yes", "--json"]);
      expect(frozen.code).toBe(1);
      expect(frozen.stderr).toContain('"unsealed-stop" needs an answer');
      const accepted = await h.run(["backup", "create", "--freeze", "--yes", "--answers", h.answers({ "unsealed-stop": "accept" }), "--json"]);
      expect(accepted.code).toBe(0);
      expect(accepted.json).toMatchObject({ manifest: { source: { seal: "unsealed" } } });
    } finally {
      await h.dispose();
    }
  });
});

describe("a restore that fails after it changed the store", () => {
  it("treats a journal entry it cannot write after the app started again as a warning and releases the pre-restore backup", async () => {
    const { h, failNext, restoreArgs } = await seededWithChange("journal-after-start");
    try {
      failNext((key) => key.endsWith("-restore-done.json"));
      failNext((key) => key.endsWith("-start-done.json"));
      const restored = await h.run(restoreArgs());
      expect(restored.code).toBe(0);
      expect(restored.stderr).not.toContain("stays stopped");
      expect(restored.stderr).toContain("-restore-done.json");
      expect(restored.stderr).toContain("-start-done.json");
      expect((await h.app.status()).state).toBe("started");
      expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Home", body: "Welcome" });
      const list = await h.run(["backup", "list"]);
      expect(list.stdout).toContain(String(restored.json.safetyBackup));
      expect(list.stdout).not.toContain("pinned by");
    } finally {
      await h.dispose();
    }
  });

  it("says the app was started again when it does not become ready, and names the pre-restore backup", async () => {
    const { h, restoreArgs } = await seededWithChange("not-ready");
    const waitReady = h.app.waitReady.bind(h.app);
    try {
      h.app.waitReady = async () => false;
      const restored = await h.run(restoreArgs());
      h.app.waitReady = waitReady;
      expect(restored.code).toBe(1);
      expect(restored.stderr).not.toContain("stays stopped");
      expect(restored.stderr).toContain("did not become ready");
      expect(restored.stderr).toMatch(/started the app again; check it, or restore the pre-restore backup prod-\d{8}T\d{6}Z-pre-restore-[0-9a-f]{4}/);
      expect((await h.app.status()).state).toBe("started");
    } finally {
      await h.dispose();
    }
  });

  it("names no pre-restore backup when --no-safety-backup skipped it", async () => {
    const { h, failNext, id } = await seededWithChange("no-safety");
    try {
      failNext((key) => key.endsWith("-blobs-done.json"));
      const restored = await h.run(["restore", "--backup", id, "--no-safety-backup", "--yes", "--answers", h.answers({ "access-changes": "accept" })]);
      expect(restored.code).toBe(1);
      expect(restored.stderr).toContain("the app stays stopped. Run the restore again");
      expect(restored.stderr).not.toContain("or restore the pre-restore backup");
      expect((await h.app.status()).state).toBe("stopped");
    } finally {
      await h.dispose();
    }
  });
});

describe("a step that fails right after the app stopped", () => {
  it("starts the app again after a frozen backup and after a restore whose stop entry cannot be written", async () => {
    const { h, failNext, restoreArgs } = await seededWithChange("stop-entry");
    try {
      failNext((key) => key.endsWith("-stop-done.json"));
      const frozen = await h.run(["backup", "create", "--freeze"]);
      expect(frozen.code).toBe(1);
      expect(frozen.stderr).toContain("-stop-done.json");
      expect(frozen.stderr).toContain("the app was stopped; starting it again");
      expect((await h.app.status()).state).toBe("started");

      failNext((key) => key.endsWith("-stop-done.json"));
      const restored = await h.run(restoreArgs());
      expect(restored.code).toBe(1);
      expect(restored.stderr).toContain("the app was stopped; starting it again");
      expect((await h.app.status()).state).toBe("started");
      expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Home", body: "changed after the backup" });
    } finally {
      await h.dispose();
    }
  });
});
