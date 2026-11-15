import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Blobstore, BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok, type Result } from "@michaelthielemann/kestrel/result";
import { createReplicationSqlite, type Replication } from "./impl.ts";

type Mode = "working" | "failing" | "stalled";

function switchableBlobs(): Blobstore & { mode: Mode } {
  const blobs = new Map<string, Uint8Array>();
  const state = { mode: "working" as Mode };
  const gate = async <T>(run: () => T): Promise<Result<T, BlobstoreError>> => {
    if (state.mode === "failing") return err(failure("TRANSIENT", "store answered 503 Slow Down"));
    if (state.mode === "stalled") return new Promise(() => undefined);
    return ok(run());
  };
  return {
    get mode() {
      return state.mode;
    },
    set mode(value: Mode) {
      state.mode = value;
    },
    put: (key, data) => gate(() => void blobs.set(key, new Uint8Array(data))),
    get: (key) => gate(() => blobs.get(key) ?? null),
    remove: (key) => gate(() => void blobs.delete(key)),
    move: (from, to) =>
      gate(() => {
        const value = blobs.get(from);
        if (value !== undefined) blobs.set(to, value);
        blobs.delete(from);
      }),
    list: (prefix) => gate(() => [...blobs].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, size: value.byteLength }))),
  };
}

const dirs: string[] = [];
const open: Array<Replication | DatabaseSync> = [];

afterEach(() => {
  for (const item of open.splice(0)) item.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-health-"));
  dirs.push(dir);
  const file = join(dir, "live.db");
  const app = new DatabaseSync(file);
  app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  let t = Date.UTC(2026, 0, 1);
  const blobs = switchableBlobs();
  const repl = createReplicationSqlite({ file, prefix: "replica/", checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: true }, blobs, () => t);
  open.push(repl, app);
  const insert = () => app.prepare("INSERT INTO t (v) VALUES ('x')").run();
  const advance = (ms: number) => {
    t += ms;
  };
  return { repl, blobs, insert, advance };
}

const MINUTE = 60_000;

describe("replication/sqlite health while syncs do not succeed", () => {
  it("adds a note once no sync has succeeded for a few sync intervals, names the last error and stays ok", async () => {
    const { repl, blobs, insert, advance } = setup();
    insert();
    expectOk(await repl.sync());
    advance(MINUTE);
    expectOk(await repl.sync());
    expect(repl.health()).toEqual({ ok: true });
    blobs.mode = "failing";
    for (let i = 0; i < 2; i++) {
      advance(MINUTE);
      insert();
      expectErr(await repl.sync(), "TRANSIENT");
    }
    expect(repl.health()).toEqual({ ok: true });
    advance(MINUTE);
    expectErr(await repl.sync(), "TRANSIENT");
    const health = repl.health();
    expect(health.ok).toBe(true);
    expect(health.note).toContain("no sync has succeeded since 2026-01-01T00:01:00.000Z");
    expect(health.note).toContain("503 Slow Down");
    blobs.mode = "working";
    advance(MINUTE);
    expectOk(await repl.sync());
    expect(repl.health()).toEqual({ ok: true });
  });

  it("adds the note while a sync hangs and later syncs queue behind it", async () => {
    const { repl, blobs, insert, advance } = setup();
    insert();
    expectOk(await repl.sync());
    advance(MINUTE);
    expectOk(await repl.sync());
    blobs.mode = "stalled";
    for (let i = 0; i < 4; i++) {
      advance(MINUTE);
      insert();
      void repl.sync();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const health = repl.health();
    expect(health.ok).toBe(true);
    expect(health.note).toContain("no sync has succeeded since 2026-01-01T00:01:00.000Z");
    expect(health.note).toContain("a sync is still running");
  });

  it("adds no note before the first two syncs show how often syncs run", async () => {
    const { repl, advance } = setup();
    advance(60 * MINUTE);
    expect(repl.health()).toEqual({ ok: true });
  });
});
