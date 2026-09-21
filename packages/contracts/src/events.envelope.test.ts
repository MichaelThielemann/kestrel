import { describe, expect, it } from "vitest";
import type { Context } from "@michaelthielemann/kestrel/context";
import type { CoreCode, KestrelError } from "@michaelthielemann/kestrel/errors";
import { eventEnvelope, parseEmitSpec, withEventIdentity } from "./events.envelope.ts";

function fakeCtx(overrides: Partial<Context> = {}): Context {
  return {
    runId: "run-1",
    trigger: { kind: "http", name: "t" },
    payload: {},
    body: {},
    query: {},
    params: {},
    headers: {},
    files: [],
    fail(codeOrError: CoreCode | KestrelError, message?: string): never {
      throw new Error(`${typeof codeOrError === "string" ? codeOrError : codeOrError.code} ${message ?? ""}`);
    },
    done: () => {
      throw new Error("done called");
    },
    ...overrides,
  };
}

describe("parseEmitSpec", () => {
  it("splits the name from a plain spec", () => {
    expect(parseEmitSpec("page.created")).toEqual({ name: "page.created", withResult: false });
  });

  it("enables withResult for ?with=result and any extra query key", () => {
    expect(parseEmitSpec("page.created?with=result")).toEqual({ name: "page.created", withResult: true });
    expect(parseEmitSpec("page.created?with=result&other=1")).toEqual({ name: "page.created", withResult: true });
  });

  it("does not enable withResult for an unrelated query value", () => {
    expect(parseEmitSpec("page.created?with=other")).toEqual({ name: "page.created", withResult: false });
  });
});

describe("eventEnvelope", () => {
  it("derives id from result.id first", () => {
    const { envelope } = eventEnvelope("page.created", fakeCtx({ params: { id: "p-params" }, result: { id: "p-result" } }));
    expect(envelope.id).toBe("p-result");
  });

  it("falls back to result.document.id", () => {
    const { envelope } = eventEnvelope("page.created", fakeCtx({ result: { document: { id: "p2" } } }));
    expect(envelope.id).toBe("p2");
  });

  it("falls back to params.id", () => {
    const { envelope } = eventEnvelope("page.created", fakeCtx({ params: { id: "p3" } }));
    expect(envelope.id).toBe("p3");
  });

  it("falls back to null with no id anywhere", () => {
    const { envelope } = eventEnvelope("page.created", fakeCtx());
    expect(envelope.id).toBeNull();
  });

  it("adds ids only for an all-string array", () => {
    const strings = eventEnvelope("x", fakeCtx({ result: { ids: ["a", "b"] } })).envelope;
    expect(strings.ids).toEqual(["a", "b"]);
    const mixed = eventEnvelope("x", fakeCtx({ result: { ids: ["a", 1] } })).envelope;
    expect(mixed.ids).toBeUndefined();
  });

  it("adds result only with ?with=result, null when ctx.result is undefined", () => {
    const without = eventEnvelope("x", fakeCtx({ result: { a: 1 } })).envelope;
    expect(without.result).toBeUndefined();
    const withIt = eventEnvelope("x?with=result", fakeCtx({ result: { a: 1 } })).envelope;
    expect(withIt.result).toEqual({ a: 1 });
    const withUndefined = eventEnvelope("x?with=result", fakeCtx()).envelope;
    expect(withUndefined.result).toBeNull();
  });

  it("stamps a fresh eventId, the emitting runId, identity and params", () => {
    const identity = { id: "u1", claims: {} };
    const { envelope, name } = eventEnvelope("page.created", fakeCtx({ runId: "run-a", identity, params: { slug: "x" } }));
    expect(name).toBe("page.created");
    expect(envelope.event).toBe("page.created");
    expect(envelope.runId).toBe("run-a");
    expect(envelope.identity).toBe(identity);
    expect(envelope.params).toEqual({ slug: "x" });
    expect(envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("withEventIdentity", () => {
  it("adds eventId, event and at when missing, keeps other fields", () => {
    const before = Date.now();
    const out = withEventIdentity("x.happened", { a: 1 });
    expect(typeof out.eventId).toBe("string");
    expect(out.event).toBe("x.happened");
    expect(out.at).toBeGreaterThanOrEqual(before);
    expect(out.a).toBe(1);
  });

  it("keeps an emitter-supplied eventId and does not move or rename other fields", () => {
    const out = withEventIdentity("x.happened", { eventId: "given", a: 1 });
    expect(out.eventId).toBe("given");
    expect(out.event).toBe("x.happened");
    expect(out.a).toBe(1);
    expect(Object.keys(out).sort()).toEqual(["a", "at", "event", "eventId"]);
  });
});
