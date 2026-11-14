import { describe, expect, it } from "vitest";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps, Introspection } from "@michaelthielemann/kestrel/defineModule";
import type { RunEndEvent, RunObserver } from "@michaelthielemann/kestrel";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { COLLECTION, type Audit } from "./impl.ts";
import module from "./module.ts";

function makeDeps(db: ReturnType<typeof createFakePersistence>): Deps {
  const providers = new Map<string, unknown>([[PERSISTENCE.name, db]]);
  return {
    get<T>(contract: Contract<T>): T {
      if (!providers.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(providers.get(contract.name), "host");
    },
    find: <T>(contract: Contract<T>): T | undefined => boundaryCast<T | undefined>(providers.get(contract.name), "host"),
    logger: silentLogger,
    root: process.cwd(),
    eventTriggers: [],
  };
}

async function boot(config: Record<string, unknown> = {}): Promise<{ instance: Audit; db: ReturnType<typeof createFakePersistence> }> {
  const db = createFakePersistence();
  const instance = boundaryCast<Audit>(await module.setup(module.configSchema.parse(config), makeDeps(db)), "host");
  return { instance, db };
}

const recordPipeline = definePipeline({ name: "record", steps: ["audit.record"] });
const recordActorPipeline = definePipeline({ name: "recordActor", steps: ["audit.recordActor"] });
const anonymizePipeline = definePipeline({ name: "anonymize", steps: ["audit.anonymize"] });
const prunePipeline = definePipeline({ name: "prune", steps: ["audit.prune"] });

describe("audit/persistence module steps via runPipeline", () => {
  it("record persists an entry built from the event envelope", async () => {
    const { instance, db } = await boot();
    const res = await runPipeline(recordPipeline, { body: { eventId: "e1", event: "auth.loggedIn", at: 1, identity: { id: "u1", claims: {} }, params: {} } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
    expect(expectOk(await db.count(COLLECTION, { event: "auth.loggedIn", identityId: "u1" }))).toBe(1);
  });

  it("record accepts an anonymous event with no identity", async () => {
    const { instance, db } = await boot();
    const res = await runPipeline(recordPipeline, { body: { eventId: null, event: "auth.loggedOut", at: 2, identity: null, params: {} } }, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
    expect(expectOk(await db.count(COLLECTION, { event: "auth.loggedOut", identityId: null }))).toBe(1);
  });

  it("anonymize strips the user the event payload names and is repeatable", async () => {
    const { instance, db } = await boot();
    await runPipeline(recordPipeline, { body: { eventId: "e1", event: "auth.loggedIn", at: 1, identity: { id: "u1", claims: {} }, params: {} } }, { modules: [{ module, instance }] });

    const first = await runPipeline(anonymizePipeline, { payload: { id: "u1", event: "user.deleted", at: 2, identity: null, params: { id: "u1" } } }, { modules: [{ module, instance }] });
    expect(first.status).toBe(200);
    expect(first.result).toEqual({ entries: 1 });
    expect(expectOk(await db.count(COLLECTION, { identityId: "u1" }))).toBe(0);

    const again = await runPipeline(anonymizePipeline, { params: { id: "u1" } }, { modules: [{ module, instance }] });
    expect(again.result).toEqual({ entries: 0 });
  });

  it("anonymize answers 400 without a user id", async () => {
    const { instance } = await boot();
    const res = await runPipeline(anonymizePipeline, {}, { modules: [{ module, instance }] });
    expect(res).toMatchObject({ status: 400, code: "VALIDATION" });
  });

  it("prune removes what retentionDays no longer covers and answers 400 when it is unset", async () => {
    const { instance, db } = await boot({ retentionDays: 30 });
    await runPipeline(recordPipeline, { body: { eventId: "old", event: "auth.loggedIn", at: 1, identity: null, params: {} } }, { modules: [{ module, instance }] });
    await runPipeline(recordPipeline, { body: { eventId: "new", event: "auth.loggedIn", at: Date.now(), identity: null, params: {} } }, { modules: [{ module, instance }] });

    const pruned = await runPipeline(prunePipeline, {}, { modules: [{ module, instance }] });
    expect(pruned.status).toBe(200);
    expect(pruned.result).toEqual({ removed: 1 });
    expect(expectOk(await db.count(COLLECTION, {}))).toBe(1);

    const { instance: unset } = await boot();
    expect(await runPipeline(prunePipeline, {}, { modules: [{ module, instance: unset }] })).toMatchObject({ status: 400, code: "VALIDATION" });
  });
});

describe("audit/persistence security events", () => {
  function attached(db: ReturnType<typeof createFakePersistence>, instance: Audit) {
    let observer: RunObserver | undefined;
    const kestrel: Introspection = {
      describe: () => { throw new Error("not needed"); },
      observe: (o) => { observer = o; return () => { observer = undefined; }; },
      health: () => ({ ok: true, restartRequired: false, modules: [] }),
    };
    const detach = module.attach?.(instance, kestrel);
    const end = (event: Partial<RunEndEvent>) => observer?.runEnd?.({ runId: "r", pipeline: "login", trigger: { kind: "http", name: "POST /login" }, at: 1_000, ms: 1, status: 200, outcome: "ok", ...event });
    const entries = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return expectOk(await db.findMany<Record<string, unknown> & { id: string }>(COLLECTION, {})).items;
    };
    return { end, entries, detach };
  }

  it("records a failed login with its time, username and client address, and never a password", async () => {
    const { instance, db } = await boot();
    const { end, entries } = attached(db, instance);
    end({ status: 401, outcome: "fail", code: "UNAUTHENTICATED", step: "authn.login", ip: "198.51.100.4", details: { username: "mallory" } });
    const [entry] = await entries();
    expect(entry).toMatchObject({ event: "auth.failed", at: 1_000, ip: "198.51.100.4", identityId: null, params: { pipeline: "login", step: "authn.login", code: "UNAUTHENTICATED", username: "mallory" } });
    expect(JSON.stringify(entry)).not.toMatch(/password/i);
  });

  it("records 403 and 429 answers as structured entries with the client address and the pipeline", async () => {
    const { instance, db } = await boot();
    const { end, entries } = attached(db, instance);
    end({ pipeline: "createUser", trigger: { kind: "http", name: "POST /users" }, status: 403, outcome: "fail", code: "FORBIDDEN", step: "authz.require:users.manage", ip: "198.51.100.5", identityId: "u2" });
    end({ pipeline: "login", status: 429, outcome: "fail", code: "RATE_LIMITED", step: "ratelimit.check:login", ip: "198.51.100.6" });
    const found = await entries();
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "access.denied", ip: "198.51.100.5", identityId: "u2", params: { pipeline: "createUser", step: "authz.require:users.manage", code: "FORBIDDEN" } }),
      expect.objectContaining({ event: "access.rateLimited", ip: "198.51.100.6", params: { pipeline: "login", step: "ratelimit.check:login", code: "RATE_LIMITED" } }),
    ]));
  });

  it("records a burst of rate-limited answers from one address once a minute, and ignores other runs", async () => {
    const { instance, db } = await boot();
    const { end, entries } = attached(db, instance);
    for (let i = 0; i < 50; i++) end({ status: 429, outcome: "fail", code: "RATE_LIMITED", step: "ratelimit.check:login", ip: "198.51.100.7", at: 1_000 + i });
    end({ status: 200 });
    end({ status: 401, outcome: "fail", code: "UNAUTHENTICATED", step: "authn.requireUser", pipeline: "me" });
    end({ status: 403, outcome: "fail", code: "FORBIDDEN", trigger: { kind: "cron", name: "* * * * *" } });
    expect(await entries()).toHaveLength(1);
  });

  it("records nothing once detached", async () => {
    const { instance, db } = await boot();
    const { end, entries, detach } = attached(db, instance);
    if (typeof detach === "function") detach();
    end({ status: 403, outcome: "fail", code: "FORBIDDEN" });
    expect(await entries()).toHaveLength(0);
  });
});

describe("audit/persistence security entries stay small", () => {
  function attach(db: ReturnType<typeof createFakePersistence>, instance: Audit) {
    let observer: RunObserver | undefined;
    const kestrel: Introspection = {
      describe: () => { throw new Error("not needed"); },
      observe: (o) => { observer = o; return () => { observer = undefined; }; },
      health: () => ({ ok: true, restartRequired: false, modules: [] }),
    };
    module.attach?.(instance, kestrel);
    const end = (event: Partial<RunEndEvent>) => observer?.runEnd?.({ runId: "r", pipeline: "login", trigger: { kind: "http", name: "POST /login" }, at: 1_000, ms: 1, status: 200, outcome: "ok", ...event });
    const entries = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return expectOk(await db.findMany<Record<string, unknown> & { id: string; params: Record<string, string> }>(COLLECTION, {})).items;
    };
    return { end, entries };
  }

  it("keeps at most 256 characters of a tried username and no control characters", async () => {
    const { instance, db } = await boot();
    const { end, entries } = attach(db, instance);
    end({ status: 401, outcome: "fail", code: "UNAUTHENTICATED", step: "authn.login", ip: "198.51.100.4", details: { username: `evil\nuser\r\n${"x".repeat(1000)}` } });
    const [entry] = await entries();
    const username = entry?.params.username ?? "";
    expect(username.length).toBeLessThanOrEqual(256);
    expect([...username].some((char) => (char.codePointAt(0) ?? 0) < 0x20)).toBe(false);
    expect(username.startsWith("evil user")).toBe(true);
    expect(username.includes("  ")).toBe(true);
  });

  it("records a burst of 403 answers of one caller once a minute, with how many it left out", async () => {
    const { instance, db } = await boot();
    const { end, entries } = attach(db, instance);
    const denied = { pipeline: "listUsers", trigger: { kind: "http" as const, name: "GET /users" }, status: 403, outcome: "fail" as const, code: "FORBIDDEN", step: "authz.requireRole", ip: "198.51.100.5", identityId: "u9" };
    for (let i = 0; i < 500; i++) end({ ...denied, at: 1_000 + i });
    end({ ...denied, at: 70_000 });
    const found = (await entries()).filter((row) => row.event === "access.denied");
    expect(found).toHaveLength(2);
    expect(found[1]?.params.suppressed).toBe("499");
  });

  it("counts a failed second-factor check as a failed sign-in by default", async () => {
    const { instance, db } = await boot();
    const { end, entries } = attach(db, instance);
    end({ status: 401, outcome: "fail", code: "UNAUTHENTICATED", step: "mfa.check", ip: "198.51.100.6", details: { username: "alice" } });
    expect((await entries())[0]).toMatchObject({ event: "auth.failed", params: { step: "mfa.check", username: "alice" } });
  });
});

describe("audit/persistence entries from events", () => {
  it("keeps the client address and the id the event is about", async () => {
    const { instance, db } = await boot();
    await runPipeline(recordPipeline, { body: { eventId: "e9", event: "user.created", at: 5, identity: { id: "admin", claims: {} }, params: {}, id: "u9", ip: "192.0.2.1" } }, { modules: [{ module, instance }] });
    const [entry] = expectOk(await db.findMany<Record<string, unknown> & { id: string }>(COLLECTION, {})).items;
    expect(entry).toMatchObject({ event: "user.created", identityId: "admin", ip: "192.0.2.1", params: { id: "u9" } });
  });
});

describe("audit/persistence recordActor", () => {
  it("keeps the event, its time, the caller and the address but neither the params nor the id", async () => {
    const { instance, db } = await boot();
    const envelope = { eventId: "e7", event: "user.auditAnonymizeRetried", at: 7, identity: { id: "admin", claims: {} }, params: { id: "u7" }, id: "u7", ip: "192.0.2.7" };
    const res = await runPipeline(recordActorPipeline, { body: envelope }, { modules: [{ module, instance }] });
    expect(res.status).toBe(200);
    const [entry] = expectOk(await db.findMany<Record<string, unknown> & { id: string }>(COLLECTION, {})).items;
    expect(entry).toMatchObject({ eventId: "e7", event: "user.auditAnonymizeRetried", at: 7, identityId: "admin", ip: "192.0.2.7", params: {} });
    expect(JSON.stringify(entry)).not.toContain("u7");
  });
});
