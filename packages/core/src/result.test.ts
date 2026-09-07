import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, match, unwrapOr, type Result } from "./result.ts";

describe("ok", () => {
  it("wraps a value", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
  });

  it("wraps nothing as an undefined value", () => {
    expect(ok()).toEqual({ ok: true, value: undefined });
  });

  it("keeps null as a value, not an absence", () => {
    expect(ok(null)).toEqual({ ok: true, value: null });
  });
});

describe("err", () => {
  it("wraps an error", () => {
    expect(err("boom")).toEqual({ ok: false, error: "boom" });
  });
});

describe("isOk / isErr", () => {
  it("narrow a Result to its branch", () => {
    const good: Result<number, string> = ok(1);
    const bad: Result<number, string> = err("boom");
    expect(isOk(good)).toBe(true);
    expect(isErr(good)).toBe(false);
    expect(isOk(bad)).toBe(false);
    expect(isErr(bad)).toBe(true);
    if (isOk(good)) expect(good.value).toBe(1);
    if (isErr(bad)) expect(bad.error).toBe("boom");
  });
});

describe("match", () => {
  it("calls the ok branch with the value", () => {
    expect(match(ok(2), { ok: (v: number) => v * 2, err: () => -1 })).toBe(4);
  });

  it("calls the err branch with the error", () => {
    expect(match(err("boom"), { ok: () => "none", err: (e: string) => e.toUpperCase() })).toBe("BOOM");
  });
});

describe("unwrapOr", () => {
  it("returns the value of an Ok", () => {
    expect(unwrapOr(ok(1), 0)).toBe(1);
  });

  it("returns the fallback for an Err", () => {
    expect(unwrapOr(err("boom") as Result<number, string>, 0)).toBe(0);
  });
});

describe("propagation", () => {
  it("passes an inner Err through an outer Result with a wider error union", () => {
    const inner = (): Result<number, "A"> => err("A");
    const outer = (): Result<string, "A" | "B"> => {
      const r = inner();
      if (isErr(r)) return r;
      return ok(String(r.value));
    };
    expect(outer()).toEqual({ ok: false, error: "A" });
  });
});
