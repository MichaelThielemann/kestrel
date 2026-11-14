import { describe, it, expect } from "vitest";
import { STATUS_OF, failure, customFailure, isKestrelError, isKestrelBootError, KestrelBootError, type CoreCode } from "./errors.ts";

describe("STATUS_OF", () => {
  it("maps every core code to its HTTP status", () => {
    expect(STATUS_OF).toEqual({
      VALIDATION: 400,
      DANGLING_REF: 400,
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      PAYLOAD_TOO_LARGE: 413,
      UNSUPPORTED: 415,
      RATE_LIMITED: 429,
      INTERNAL: 500,
      TRANSIENT: 503,
    });
  });
});

describe("failure", () => {
  it("takes the status from the code table", () => {
    expect(failure("NOT_FOUND", "pages/1 not found")).toEqual({ code: "NOT_FOUND", status: 404, message: "pages/1 not found", retryable: false });
  });

  it("marks only TRANSIENT and RATE_LIMITED as retryable", () => {
    const codes: CoreCode[] = ["VALIDATION", "NOT_FOUND", "CONFLICT", "FORBIDDEN", "UNAUTHENTICATED", "RATE_LIMITED", "DANGLING_REF", "PAYLOAD_TOO_LARGE", "UNSUPPORTED", "TRANSIENT", "INTERNAL"];
    const retryable = codes.filter((code) => failure(code, "x").retryable);
    expect(retryable).toEqual(["RATE_LIMITED", "TRANSIENT"]);
  });

  it("omits details and cause when they are not given", () => {
    const error = failure("VALIDATION", "missing id");
    expect(Object.keys(error).sort()).toEqual(["code", "message", "retryable", "status"]);
  });

  it("keeps details and cause when they are given", () => {
    const cause = new Error("underlying");
    const error = failure("VALIDATION", "invalid", { details: { fields: [{ field: "slug" }] }, cause });
    expect(error.details).toEqual({ fields: [{ field: "slug" }] });
    expect(error.cause).toBe(cause);
  });
});

describe("customFailure", () => {
  it("takes the status from the caller and defaults retryable to false", () => {
    expect(customFailure("MIGRATION_FAILED", 500, "migration 003 failed")).toEqual({ code: "MIGRATION_FAILED", status: 500, message: "migration 003 failed", retryable: false });
  });

  it("accepts an explicit retryable flag, details and cause", () => {
    const error = customFailure("UPSTREAM_BUSY", 503, "upstream busy", { retryable: true, details: { retryAfterSeconds: 5 }, cause: "raw" });
    expect(error).toEqual({ code: "UPSTREAM_BUSY", status: 503, message: "upstream busy", retryable: true, details: { retryAfterSeconds: 5 }, cause: "raw" });
  });
});

describe("isKestrelError", () => {
  it("accepts a built failure", () => {
    expect(isKestrelError(failure("CONFLICT", "taken"))).toBe(true);
    expect(isKestrelError(customFailure("TEAPOT", 418, "no coffee"))).toBe(true);
  });

  it("rejects anything without the four required fields", () => {
    expect(isKestrelError(null)).toBe(false);
    expect(isKestrelError("NOT_FOUND")).toBe(false);
    expect(isKestrelError({ code: "NOT_FOUND", status: 404, message: "x" })).toBe(false);
    expect(isKestrelError({ code: 404, status: 404, message: "x", retryable: false })).toBe(false);
    expect(isKestrelError(new Error("boom"))).toBe(false);
  });
});

async function secondCopyBootError(module: string, reason: string, code: string): Promise<unknown> {
  const copy: unknown = await import(new URL("./errors.ts?copy=second", import.meta.url).href);
  if (typeof copy !== "object" || copy === null || !("KestrelBootError" in copy) || typeof copy.KestrelBootError !== "function") throw new Error("the second copy has no KestrelBootError");
  const error: unknown = Reflect.construct(copy.KestrelBootError, [module, reason, code]);
  return error;
}

describe("isKestrelBootError", () => {
  it("recognizes a KestrelBootError of this copy of the module", () => {
    expect(isKestrelBootError(new KestrelBootError("store/sqlite", "locked", "instance-locked"))).toBe(true);
  });

  it("recognizes a KestrelBootError created by a second copy of the module", async () => {
    const error = await secondCopyBootError("store/sqlite", "locked", "instance-locked");
    expect(error instanceof KestrelBootError).toBe(false);
    expect(isKestrelBootError(error)).toBe(true);
  });

  it("does not take a plain error with the same fields for a KestrelBootError", () => {
    expect(isKestrelBootError(Object.assign(new Error("[store/sqlite] locked"), { module: "store/sqlite", reason: "locked", code: "instance-locked" }))).toBe(false);
    expect(isKestrelBootError({ module: "store/sqlite", reason: "locked", code: "instance-locked" })).toBe(false);
    expect(isKestrelBootError(undefined)).toBe(false);
  });
});

describe("KestrelBootError", () => {
  it("names the module, the reason and the code", () => {
    const error = new KestrelBootError("pipelines/createPage", 'unknown step "nope"', "unknown-step");
    expect(error.message).toBe('[pipelines/createPage] unknown step "nope"');
    expect(error.module).toBe("pipelines/createPage");
    expect(error.reason).toBe('unknown step "nope"');
    expect(error.code).toBe("unknown-step");
  });
});
