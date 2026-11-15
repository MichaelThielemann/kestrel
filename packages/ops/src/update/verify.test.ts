import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PREFIXES } from "../harness.fixture.ts";
import { buildDatabase, listGenerations, markerKey, promote, stableGenerations, type Promoted } from "../replica.ts";
import { appClock } from "../serverTime.ts";
import type { FakeRelease } from "./fakeUpdateTarget.fixture.ts";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import type { UpdateContext, VerifyResult } from "./types.ts";
import { verifyRelease } from "./verify.ts";

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

interface Started {
  h: UpdateHarness;
  ctx: UpdateContext;
  promoted: Promoted;
  startedAt: number;
}

async function startOnPromoted(release: Partial<FakeRelease> = {}): Promise<Started> {
  const h = createUpdateHarness({ from: { runtime: "6.0.0", ...release } });
  harnesses.push(h);
  const ctx = await h.context();
  const seeding = createUpdateHarness({ store: h.store, from: { runtime: "6.0.0" } });
  harnesses.push(seeding);
  await seeding.target.start();
  await seeding.target.app?.seed();
  await seeding.target.stop();
  await seeding.target.idle();
  const newest = (await stableGenerations(h.store, PREFIXES.replica, ctx.poll)).at(-1);
  if (newest === undefined) throw new Error("the seeded replica has no generation");
  const copy = join(h.root, "copy.db");
  await buildDatabase(h.store, PREFIXES.replica, newest, copy);
  const clock = await appClock(ctx);
  const promoted = await promote({ store: h.store, prefix: PREFIXES.replica, target: h.target, database: copy, origin: { kind: "upgrade", source: "test" }, serverNow: clock.now, skewMs: clock.skewMs, clock: Date.now, poll: ctx.poll });
  while (Date.now() < promoted.at + 1000) await new Promise((done) => setTimeout(done, 20));
  const startedAt = Date.now();
  await h.target.start();
  return { h, ctx, promoted, startedAt };
}

const verify = ({ ctx, promoted, startedAt }: Started): Promise<VerifyResult> => verifyRelease(ctx, { promoted, startedAt });
const failed = (result: VerifyResult): string[] => result.checks.filter((c) => c.hard && !c.ok).map((c) => c.name);

async function ownKeys(s: Started): Promise<string[]> {
  const own = (await listGenerations(s.h.store, PREFIXES.replica)).find((g) => g.name > s.promoted.generation);
  if (own === undefined) throw new Error("no own generation");
  return [own.snapshot?.key ?? "", ...own.segments.map((i) => i.key), ...Object.values(own.files).map((i) => i.key)].filter((k) => k !== "");
}

describe("verifying a started release", { timeout: 20_000 }, () => {
  it("passes a ready release that acknowledged the promoted generation, snapshots, syncs and renders", async () => {
    const s = await startOnPromoted();
    const result = await verify(s);
    expect(failed(result)).toEqual([]);
    expect(result.verdict).toBe("passed");
    expect(result.ready).toEqual({ outcome: "ready", status: 200 });
    expect(result.ownGeneration).not.toBeNull();
    expect(result.ownGeneration! > s.promoted.generation).toBe(true);
  });

  it("passes a release that writes nothing to its database after its first snapshot", async () => {
    const s = await startOnPromoted({ records: false });
    const own = (await listGenerations(s.h.store, PREFIXES.replica)).find((g) => g.name > s.promoted.generation);
    expect(own?.segments.map((segment) => segment.size)).toEqual([32]);
    const result = await verify(s);
    expect(failed(result)).toEqual([]);
    expect(result.verdict).toBe("passed");
  });

  it("fails when the platform records a crash during the readiness and sync windows, after the first look found none", async () => {
    const s = await startOnPromoted();
    const probe = s.h.target.probeReady.bind(s.h.target);
    let crashed = false;
    s.h.target.probeReady = async () => {
      if (!crashed) {
        crashed = true;
        s.h.target.crashes.push({ at: Date.now(), type: "audit.app.process.crash", reason: "APP/PROC/WEB: Exited with status 137 (out of memory)" });
      }
      return probe();
    };
    const result = await verify(s);
    expect(crashed).toBe(true);
    expect(result.verdict).toBe("failed");
    expect(failed(result)).toEqual(["crashes"]);
    expect(result.checks.find((c) => c.name === "crashes")?.detail).toContain("out of memory");
  });

  it("fails when no instance runs any more at the end of the windows", async () => {
    const s = await startOnPromoted();
    const list = s.h.store.list.bind(s.h.store);
    let stopped = false;
    s.h.store.list = async (prefix) => {
      const listed = await list(prefix);
      if (!stopped && prefix === PREFIXES.delivery && listed.length > 0) {
        stopped = true;
        s.h.target.kill();
      }
      return listed;
    };
    const result = await verify(s);
    expect(stopped).toBe(true);
    expect(result.verdict).toBe("failed");
    expect(failed(result)).toContain("instance");
  });

  it("fails on 503", async () => {
    const result = await verify(await startOnPromoted({ ready: "not-ready" }));
    expect(result.verdict).toBe("failed");
    expect(result.ready).toEqual({ outcome: "not-ready", status: 503 });
  });

  it.each(["forbidden", "unreachable"] as const)("halts when readiness is %s", async (ready) => {
    const result = await verify(await startOnPromoted({ ready }));
    expect(result.verdict).toBe("unverifiable");
    expect(failed(result)).toEqual(["ready"]);
  });

  it("waits within the sync window for an applied.json the runtime writes only at a later sync, after the store's poll attempts ran out", async () => {
    const s = await startOnPromoted();
    const key = markerKey(PREFIXES.replica, s.promoted.generation, "applied");
    const applied = await s.h.store.get(key);
    if (applied === null) throw new Error("the release did not acknowledge the promoted generation");
    await s.h.store.delete(key);
    s.ctx.poll = { delayMs: 5, attempts: 2 };
    s.ctx.update = { ...s.ctx.update, syncWindowSeconds: 3 };
    const late = setTimeout(() => void s.h.store.put(key, applied), 400);
    try {
      const result = await verify(s);
      expect(failed(result)).toEqual([]);
      expect(result.verdict).toBe("passed");
    } finally {
      clearTimeout(late);
    }
  });

  it("fails when applied.json of the promoted generation is missing", async () => {
    const s = await startOnPromoted();
    await s.h.store.delete(markerKey(PREFIXES.replica, s.promoted.generation, "applied"));
    const result = await verify(s);
    expect(result.verdict).toBe("failed");
    expect(failed(result)).toEqual(["provenance"]);
  });

  it("fails without a first snapshot of the release's own generation", async () => {
    const s = await startOnPromoted();
    for (const key of await ownKeys(s)) await s.h.store.delete(key);
    const result = await verify(s);
    expect(result.verdict).toBe("failed");
    expect(failed(result)).toContain("first-snapshot");
    expect(result.ownGeneration).toBeNull();
  });

  it("fails when no segment reaches the own generation after its first snapshot, whatever marker files it holds", async () => {
    const s = await startOnPromoted();
    for (const key of await ownKeys(s)) if (!key.endsWith("/snapshot.db") && !key.endsWith(".json")) await s.h.store.delete(key);
    const own = (await listGenerations(s.h.store, PREFIXES.replica)).find((g) => g.name > s.promoted.generation);
    expect(own?.segments).toEqual([]);
    expect(Object.keys(own?.files ?? {}).length).toBeGreaterThan(0);
    const result = await verify(s);
    expect(result.verdict).toBe("failed");
    expect(failed(result)).toEqual(["sync-advances"]);
  });

  it("fails when the release does not render again", async () => {
    const result = await verify(await startOnPromoted({ renders: false }));
    expect(result.verdict).toBe("failed");
    expect(failed(result)).toContain("render-started");
  });

  it("cannot tell, instead of failing, when the store cannot be read during a check", async () => {
    const s = await startOnPromoted();
    const store = s.ctx.app;
    let failures = 1;
    s.ctx.app = {
      ...store,
      list: async (prefix) => {
        if (prefix.startsWith(PREFIXES.replica) && failures-- > 0) throw new Error("connect ETIMEDOUT");
        return store.list(prefix);
      },
    };
    const result = await verify(s);
    expect(result.verdict).toBe("unverifiable");
    expect(result.ready).toMatchObject({ outcome: "unverifiable", reason: expect.stringContaining("connect ETIMEDOUT") as unknown });
    expect(failed(result)).toContain("readable");
  });

  it("fails on a crash event since the start, and on a release that never runs", async () => {
    const s = await startOnPromoted();
    s.h.target.crashes.push({ at: Date.now(), type: "audit.app.process.crash", reason: "out of memory" });
    const crashed = await verify(s);
    expect(crashed.verdict).toBe("failed");
    expect(failed(crashed)).toEqual(["crashes"]);
    const never = await verify(await startOnPromoted({ crashes: true }));
    expect(never.verdict).toBe("failed");
    expect(failed(never)).toEqual(expect.arrayContaining(["instance", "crashes"]));
  });
});
