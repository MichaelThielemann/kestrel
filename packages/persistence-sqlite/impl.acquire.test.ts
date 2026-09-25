import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createPersistenceSqlite, type PersistenceSqlite } from "./impl.ts";

interface Gate {
  open: () => void;
  opened: Promise<void>;
}

function gate(): Gate {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function holdConnection(db: PersistenceSqlite): Promise<{ release: () => void; holder: ReturnType<PersistenceSqlite["scope"]> }> {
  const entered = gate();
  const release = gate();
  const holder = db.scope({ pipeline: "holder", group: 1 }, async () => {
    entered.open();
    await release.opened;
    return "commit";
  });
  await entered.opened;
  return { release: release.open, holder };
}

describe("persistence/sqlite: every wait for the connection has one budget and one clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a call outside a group, queued behind an open group, answers TRANSIENT once acquireTimeoutMs has passed", async () => {
    const db = createPersistenceSqlite({ file: ":memory:", acquireTimeoutMs: 200, scopeTimeoutMs: 60000 });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const { release, holder } = await holdConnection(db);

    let answer: unknown;
    const waiting = db.findMany("rows", {}).then((result) => {
      answer = result;
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toMatchObject({ ok: false, error: { code: "TRANSIENT", status: 503, retryable: true } });

    release();
    expect(await holder).toEqual({ kind: "settled", verdict: "commit" });
    await waiting;
    db.close();
  });

  it("a write that timed out waiting is never executed once the connection frees up", async () => {
    const db = createPersistenceSqlite({ file: ":memory:", acquireTimeoutMs: 200, scopeTimeoutMs: 60000 });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const { release, holder } = await holdConnection(db);

    const late = db.createOne("rows", { id: "late", name: "late" });
    await vi.advanceTimersByTimeAsync(200);
    expect(await late).toMatchObject({ ok: false, error: { code: "TRANSIENT" } });

    release();
    await holder;
    expect(expectOk(await db.findMany("rows", {})).items).toEqual([]);
    db.close();
  });

  it("a call that gets its turn before acquireTimeoutMs runs normally", async () => {
    const db = createPersistenceSqlite({ file: ":memory:", acquireTimeoutMs: 200, scopeTimeoutMs: 60000 });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const { release, holder } = await holdConnection(db);

    const write = db.createOne("rows", { id: "a", name: "alpha" });
    await vi.advanceTimersByTimeAsync(199);
    release();
    await holder;
    expect(expectOk(await write).id).toBe("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(expectOk(await db.findMany("rows", {})).items.map((row) => row.id)).toEqual(["a"]);
    db.close();
  });

  it("a group answered with a timeout never runs, even when the connection frees up in the millisecond its budget ends", async () => {
    const db = createPersistenceSqlite({ file: ":memory:", acquireTimeoutMs: 200, scopeTimeoutMs: 60000 });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const { release, holder } = await holdConnection(db);

    let waiterRan = false;
    const waiter = db.scope({ pipeline: "waiter", group: 1 }, async () => {
      waiterRan = true;
      expectOk(await db.createOne("rows", { id: "late", name: "late" }));
      return "commit";
    });
    await vi.advanceTimersByTimeAsync(200);
    release();

    expect(await waiter).toMatchObject({ kind: "failed", phase: "begin", error: { code: "TRANSIENT", retryable: true } });
    await holder;
    expect(expectOk(await db.findMany("rows", {})).items).toEqual([]);
    expect(waiterRan).toBe(false);
    db.close();
  });

  it("a group answered with a timeout never runs when the clock steps back while it waits", async () => {
    const db = createPersistenceSqlite({ file: ":memory:", acquireTimeoutMs: 200, scopeTimeoutMs: 60000 });
    expectOk(await db.ensureCollection("rows", { name: "string" }));
    const { release, holder } = await holdConnection(db);

    let waiterRan = false;
    const waiter = db.scope({ pipeline: "waiter", group: 1 }, async () => {
      waiterRan = true;
      return "commit";
    });
    await vi.advanceTimersByTimeAsync(200);
    vi.setSystemTime(Date.now() - 60000);
    release();

    expect(await waiter).toMatchObject({ kind: "failed", phase: "begin" });
    await holder;
    expectOk(await db.findMany("rows", {}));
    expect(waiterRan).toBe(false);
    db.close();
  });
});
