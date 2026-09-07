import { describe, it, expect } from "vitest";
import { createContext, first, isStepFactory, stepFactory, DONE, type Context } from "./context.ts";
import { customFailure } from "./errors.ts";
import { isErr, isOk, ok } from "./result.ts";

const input = { trigger: { kind: "http" as const, name: "POST /x" } };

describe("first", () => {
  it("returns a plain string unchanged", () => {
    expect(first("a")).toBe("a");
  });

  it("returns the first element of a string array", () => {
    expect(first(["a", "b"])).toBe("a");
  });

  it("returns undefined for anything else", () => {
    expect(first(undefined)).toBeUndefined();
    expect(first(42)).toBeUndefined();
    expect(first([])).toBeUndefined();
    expect(first([1, 2])).toBeUndefined();
  });
});

describe("ctx.fail", () => {
  it("builds an Err whose status comes from the code table", () => {
    const failed = createContext(input).fail("NOT_FOUND", "pages/1 not found");
    expect(isErr(failed)).toBe(true);
    expect(failed.error).toEqual({ code: "NOT_FOUND", status: 404, message: "pages/1 not found", retryable: false });
  });

  it("carries details when they are given and omits them otherwise", () => {
    const withDetails = createContext(input).fail("VALIDATION", "invalid", { fields: [{ field: "slug" }] });
    expect(withDetails.error.details).toEqual({ fields: [{ field: "slug" }] });
    expect(createContext(input).fail("VALIDATION", "invalid").error).not.toHaveProperty("details");
  });

  it("marks a retryable code retryable", () => {
    expect(createContext(input).fail("TRANSIENT", "busy").error).toMatchObject({ status: 503, retryable: true });
  });

  it("passes a contract error through unchanged", () => {
    const error = customFailure("RENDER_FAILED", 500, "template threw");
    expect(createContext(input).fail(error).error).toBe(error);
  });

  it("does not throw", () => {
    expect(() => createContext(input).fail("INTERNAL", "boom")).not.toThrow();
  });
});

describe("ctx.done", () => {
  it("returns an Ok context marked done and carrying the result", () => {
    const ctx = createContext(input);
    const done = ctx.done({ redirect: "/x" });
    expect(isOk(done)).toBe(true);
    expect(done.value.result).toEqual({ redirect: "/x" });
    expect(Reflect.get(done.value, DONE)).toBe(true);
    expect(Object.isFrozen(done.value)).toBe(true);
  });

  it("keeps what an earlier copy of the context carried", () => {
    const ctx = createContext(input);
    const later: Context = { ...ctx, params: { id: "p1" } };
    const done = later.done("x");
    expect(done.value.params).toEqual({ id: "p1" });
  });

  it("leaves the context it was called on untouched", () => {
    const ctx = createContext(input);
    ctx.done("x");
    expect(ctx.result).toBeUndefined();
    expect(Reflect.get(ctx, DONE)).toBeUndefined();
  });
});

describe("createContext", () => {
  it("freezes the context and fills the defaults", () => {
    const ctx = createContext(input);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx).toMatchObject({ payload: {}, params: {}, headers: {}, files: [] });
    expect(ctx.runId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("stepFactory", () => {
  it("brands a factory so the registry can tell it from a plain step", () => {
    const plain = async (ctx: Context) => ok(ctx);
    const factory = stepFactory((arg: string) => async (ctx: Context) => ok({ ...ctx, result: arg }));
    expect(isStepFactory(factory)).toBe(true);
    expect(isStepFactory(plain)).toBe(false);
  });
});
