import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stamp, unstamp } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { listGenerations, promote, stableGenerations, type PromoteInput } from "./replica.ts";
import { serverClock } from "./serverTime.ts";
import type { Target, TargetStatus } from "./target.ts";

const fast = { delayMs: 1, attempts: 50, sleep: async () => {} };

function target(state: TargetStatus): Target {
  return {
    transport: "promote",
    describe: async () => ({ kind: "test", packages: {} }),
    status: async () => state,
    stop: async () => ({ stoppedAt: 0 }),
    start: async () => {},
    waitReady: async () => true,
  };
}

describe("promote", () => {
  let dir: string;
  let database: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kestrel-ops-promote-test-"));
    database = join(dir, "db.sqlite");
    const db = new DatabaseSync(database);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE pages ("id" TEXT PRIMARY KEY, "title" TEXT)`);
    db.exec(`INSERT INTO pages VALUES ('home', 'Home')`);
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const input = (bucket: MemoryBucket, overrides: Partial<PromoteInput> = {}): PromoteInput => ({
    store: memoryStore(bucket),
    prefix: "database/",
    target: target({ state: "stopped", instances: 0 }),
    database,
    origin: { kind: "restore", source: "prod-20261101T000000Z-manual-abcd" },
    serverNow: () => Date.parse("2026-11-14T12:00:00.250Z"),
    skewMs: 0,
    clock: () => Date.parse("2026-11-14T12:00:00.250Z"),
    poll: fast,
    ...overrides,
  });

  it("refuses unless the target is stopped with no running instance", async () => {
    await expect(promote(input(new MemoryBucket("a"), { target: target({ state: "started", instances: 1 }) }))).rejects.toThrow(/must be stopped/);
    await expect(promote(input(new MemoryBucket("b"), { target: target({ state: "stopped", instances: 1 }) }))).rejects.toThrow(/1 running instance/);
  });

  it("refuses when this machine's clock is more than 30 s off the store's", async () => {
    await expect(promote(input(new MemoryBucket("c"), { skewMs: 30_001 }))).rejects.toThrow(/clock is 30 s off/);
    await expect(promote(input(new MemoryBucket("d"), { skewMs: -45_000 }))).rejects.toThrow(/-45 s off/);
  });

  it("names the generation by server time rounded up to the next second and writes origin.json with a nonce", async () => {
    const bucket = new MemoryBucket("e");
    const promoted = await promote(input(bucket));
    expect(promoted.generation).toBe("20261114T120001Z");
    const origin = JSON.parse(new TextDecoder().decode(bucket.objects.get(`database/gen/${promoted.generation}/origin.json`)?.data)) as unknown;
    expect(origin).toMatchObject({ kind: "restore", source: "prod-20261101T000000Z-manual-abcd", nonce: promoted.nonce });
    expect(promoted.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sorts after every existing generation, also one stamped up to 30 s after the store's time", async () => {
    const bucket = new MemoryBucket("f");
    const store = memoryStore(bucket);
    const ahead = stamp(Date.parse("2026-11-14T12:00:20Z"));
    await store.put(`database/gen/${ahead}-00019a8b5c2e${"0".repeat(32)}/snapshot.db`, new Uint8Array([1]));
    await store.put(`database/gen/20261114T115959Z/snapshot.db`, new Uint8Array([1]));
    const promoted = await promote(input(bucket));
    expect(promoted.generation).toBe("20261114T120021Z");
    expect((await listGenerations(store, "database/")).at(-1)?.name).toBe(promoted.generation);
  });

  it("refuses, naming it, a generation stamped more than 30 s after the store's time, and writes nothing", async () => {
    const bucket = new MemoryBucket("f2");
    const store = memoryStore(bucket);
    const future = stamp(Date.parse("2026-11-14T12:10:00Z"));
    await store.put(`database/gen/${future}/snapshot.db`, new Uint8Array([1]));
    const writes = bucket.writes.length;
    await expect(promote(input(bucket))).rejects.toThrow(`generation ${future} is stamped 600 s after the store's time`);
    expect(bucket.writes.length).toBe(writes);
  });

  it("uploads a single file without -wal that reads back with the same hash and passes integrity_check", async () => {
    const bucket = new MemoryBucket("g");
    const promoted = await promote(input(bucket));
    const keys = [...bucket.objects.keys()];
    expect(keys.filter((k) => k.includes("-wal") || k.includes("-shm"))).toEqual([]);
    const snapshot = bucket.objects.get(`database/gen/${promoted.generation}/snapshot.db`)?.data ?? new Uint8Array();
    const copy = join(dir, "read-back.db");
    writeFileSync(copy, snapshot);
    const db = new DatabaseSync(copy, { readOnly: true });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(db.prepare(`SELECT * FROM pages`).all()).toEqual([{ id: "home", title: "Home" }]);
    db.close();
    expect(readFileSync(copy).byteLength).toBe(promoted.bytes);
  });

  it("waits until a lagging listing shows the promoted generation as the newest", async () => {
    const bucket = new MemoryBucket("h", { listLag: 3 });
    const promoted = await promote(input(bucket));
    expect((await stableGenerations(memoryStore(bucket), "database/", fast)).at(-1)?.name).toBe(promoted.generation);
  });
});

describe("serverClock", () => {
  it("reads the store's clock from the LastModified of a probe, listing again until it appears, and removes the probe", async () => {
    const bucket = new MemoryBucket("clock", { listLag: 2, clock: () => Date.parse("2026-11-14T12:00:00Z") });
    const local = Date.parse("2026-11-14T12:00:40Z");
    const clock = await serverClock(memoryStore(bucket), "kestrel-backups/", "run1", () => local, fast);
    expect(clock.skewMs).toBe(40_000);
    expect(clock.now()).toBe(Date.parse("2026-11-14T12:00:00Z"));
    expect([...bucket.objects.keys()]).toEqual([]);
    expect(unstamp("20261114T120000Z")).toBe(Date.parse("2026-11-14T12:00:00Z"));
  });
});
