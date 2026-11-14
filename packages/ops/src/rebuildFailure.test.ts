import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createHarness, LOCATION, PREFIXES, type Harness } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import type { ObjectStore } from "./store.ts";

function trippingStore(inner: ObjectStore, matches: (key: string) => boolean, trip: () => void): { store: ObjectStore; arm: () => void } {
  let armed = false;
  return {
    store: {
      ...inner,
      get: async (key) => {
        const data = await inner.get(key);
        if (armed && matches(key)) {
          armed = false;
          trip();
        }
        return data;
      },
    },
    arm: () => {
      armed = true;
    },
  };
}

async function editedAfterBackup(h: Harness): Promise<string> {
  await h.app.start();
  await h.app.seed();
  const backup = await h.run(["backup", "create", "--freeze", "--json"]);
  expect(backup.code).toBe(0);
  h.app.run(`UPDATE pages SET "body" = 'edited after the backup' WHERE "id" = 'home'`);
  await h.app.sync();
  return String(backup.json.id);
}

function armAfterStop(h: Harness, arm: () => void): void {
  const stop = h.app.stop.bind(h.app);
  h.app.stop = async () => {
    const stopped = await stop();
    h.app.stop = stop;
    arm();
    return stopped;
  };
}

const answersFor = (h: Harness): string => h.answers({ "access-changes": "accept", "unreadable-current": "accept" });

async function expectUnchanged(h: Harness, bucket: MemoryBucket): Promise<void> {
  expect((await h.app.status()).state).toBe("started");
  expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Home", body: "edited after the backup" });
  expect([...bucket.objects.keys()].filter((key) => key.startsWith(LOCATION) && key.includes("-pre-restore-"))).toEqual([]);
}

describe("a restore whose rebuild of the current database fails on the store", () => {
  it("ends as interrupted on SIGTERM and starts the app again unchanged, never as an unreadable replica", async () => {
    const bucket = new MemoryBucket("rebuild-sigterm");
    const signals = new EventEmitter();
    const tripping = trippingStore(memoryStore(bucket), (key) => key.startsWith(`${PREFIXES.replica}gen/`) && key.endsWith("/snapshot.db"), () => signals.emit("SIGTERM"));
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      const id = await editedAfterBackup(h);
      armAfterStop(h, tripping.arm);
      const restored = await h.run(["restore", "--backup", id, "--yes", "--answers", answersFor(h)], { signals, stores: () => tripping.store });
      expect(restored.stderr).not.toContain("cannot be read");
      expect(restored.stderr).toContain("interrupted by SIGTERM");
      expect(restored.code).toBe(1);
      await expectUnchanged(h, bucket);
    } finally {
      await h.dispose();
    }
  });

  it("ends with the store's error on a timeout and starts the app again unchanged, never as an unreadable replica", async () => {
    const bucket = new MemoryBucket("rebuild-timeout");
    const tripping = trippingStore(
      memoryStore(bucket),
      (key) => key.startsWith(`${PREFIXES.replica}gen/`) && key.includes("/wal/"),
      () => {
        throw Object.assign(new Error("socket timed out while reading the segment"), { name: "TimeoutError" });
      },
    );
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      const id = await editedAfterBackup(h);
      armAfterStop(h, tripping.arm);
      const restored = await h.run(["restore", "--backup", id, "--yes", "--answers", answersFor(h)], { stores: () => tripping.store });
      expect(restored.stderr).not.toContain("cannot be read");
      expect(restored.stderr).toContain("socket timed out while reading the segment");
      expect(restored.code).toBe(1);
      await expectUnchanged(h, bucket);
    } finally {
      await h.dispose();
    }
  });
});
