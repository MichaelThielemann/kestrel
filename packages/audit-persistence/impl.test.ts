import { describe, it, expect } from "vitest";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Context } from "@michaelthielemann/kestrel/context";
import { failure, type CoreCode, type KestrelError } from "@michaelthielemann/kestrel/errors";
import { err, isErr, type Err } from "@michaelthielemann/kestrel/result";
import { COLLECTION, createAuditPersistence, entryFromEventData } from "./impl.ts";
import module from "./module.ts";

describe("audit/persistence", () => {
  it("records entries in its own collection", async () => {
    const db = createFakePersistence();
    const audit = await createAuditPersistence(db);
    expectOk(await audit.record({ eventId: null, event: "auth.loggedIn", at: 1, identityId: "admin", params: {} }));
    expect(expectOk(await db.count(COLLECTION, { event: "auth.loggedIn", identityId: "admin" }))).toBe(1);
  });

  it("skips a record whose eventId was already stored", async () => {
    const db = createFakePersistence();
    const audit = await createAuditPersistence(db);
    const entry = { eventId: "e1", event: "auth.loggedIn", at: 1, identityId: "admin", params: {} };
    expectOk(await audit.record(entry));
    expectOk(await audit.record(entry));
    expect(expectOk(await db.count(COLLECTION, { eventId: "e1" }))).toBe(1);
  });

  it("stores every record when the events carry no eventId", async () => {
    const db = createFakePersistence();
    const audit = await createAuditPersistence(db);
    expectOk(await audit.record({ eventId: null, event: "auth.loggedIn", at: 1, identityId: "admin", params: {} }));
    expectOk(await audit.record({ eventId: null, event: "auth.loggedIn", at: 2, identityId: "admin", params: {} }));
    expect(expectOk(await db.count(COLLECTION, { event: "auth.loggedIn" }))).toBe(2);
  });

  it("propagates a transient persistence failure from record()", async () => {
    const db = createFakePersistence();
    const audit = await createAuditPersistence(db);
    db.failNext("TRANSIENT");
    const result = await audit.record({ eventId: null, event: "auth.loggedIn", at: 1, identityId: "admin", params: {} });
    if (!isErr(result)) throw new Error("expected an Err");
    expect(result.error.code).toBe("TRANSIENT");
    expect(result.error.status).toBe(503);
    expect(result.error.retryable).toBe(true);
  });

  it("maps event data to an entry and drops everything else", () => {
    const entry = entryFromEventData({ eventId: "e1", event: "auth.loggedIn", at: 5, identity: { id: "u1", claims: {} }, params: { id: "x" }, result: { token: "secret" } });
    expect(entry).toEqual({ eventId: "e1", event: "auth.loggedIn", at: 5, identityId: "u1", params: { id: "x" } });
  });

  it("anonymous events get identityId null", () => {
    expect(entryFromEventData({ event: "e", at: 1, identity: null, params: {} })).toMatchObject({ identityId: null, eventId: null });
  });

  it("rejects payloads that are not event data", () => {
    expect(() => entryFromEventData({ title: "x" })).toThrow(/not event data/);
  });
});

function fakeCtx(payload: Record<string, unknown>): Context {
  return {
    runId: "test",
    trigger: { kind: "http", name: "t" },
    payload,
    params: {},
    headers: {},
    files: [],
    fail(codeOrError: CoreCode | KestrelError, message?: string, details?: Record<string, unknown>): Err<KestrelError> {
      return typeof codeOrError !== "string" ? err(codeOrError) : err(failure(codeOrError, message ?? "", details === undefined ? {} : { details }));
    },
    done(): never {
      throw new Error("done called");
    },
  };
}

describe("audit/persistence record step", () => {
  it("stores an entry built from the event payload and returns ok(ctx)", async () => {
    const db = createFakePersistence();
    const audit = await createAuditPersistence(db);
    const step = module.steps!(audit).record;
    const ctx = fakeCtx({ event: "auth.loggedIn", at: 1, identity: { id: "admin", claims: {} }, params: {} });

    const result = await step(ctx);

    if (isErr(result)) throw new Error(`expected Ok, got ${result.error.code}`);
    expect(result.value).toBe(ctx);
    expect(expectOk(await db.count(COLLECTION, { event: "auth.loggedIn" }))).toBe(1);
  });

  it("fails TRANSIENT (503, retryable) when persistence is down", async () => {
    const db = createFakePersistence();
    const audit = await createAuditPersistence(db);
    const step = module.steps!(audit).record;
    const ctx = fakeCtx({ event: "auth.loggedIn", at: 1, identity: null, params: {} });
    db.failNext("TRANSIENT");

    const result = await step(ctx);

    if (!isErr(result)) throw new Error("expected an Err");
    expect(result.error.code).toBe("TRANSIENT");
    expect(result.error.status).toBe(503);
    expect(result.error.retryable).toBe(true);
  });
});
