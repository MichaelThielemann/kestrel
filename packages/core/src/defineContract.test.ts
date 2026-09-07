import { describe, it, expect } from "vitest";
import { defineContract, missingMethods } from "./defineContract.ts";

describe("defineContract", () => {
  const C = defineContract<{ a(): void; b(): void }>()("thing@1", ["a", "b"]);

  it("requires the complete method list at the type level", () => {
    defineContract<{ a(): void; b(): void }>()("thing@1", ["a", "b"]);
    // @ts-expect-error incomplete method list must not compile
    defineContract<{ a(): void; b(): void }>()("thing@1", ["a"]);
  });

  it("validates the name format", () => {
    expect(() => defineContract<{ a(): void }>()("thing", ["a"])).toThrow(/must look like/);
    expect(() => defineContract<{ a(): void }>()("thing@0", ["a"])).toThrow(/must look like/);
    expect(() => (defineContract<{ a(): void }>() as (name: string, methods: readonly string[]) => unknown)("thing@1", [])).toThrow(/no methods/);
  });

  it("reports missing methods", () => {
    expect(missingMethods(C, { a() {}, b() {} })).toEqual([]);
    expect(missingMethods(C, { a() {}, b: 1 })).toEqual(["b"]);
    expect(missingMethods(C, null)).toEqual(["a", "b"]);
    expect(missingMethods(C, 42)).toEqual(["a", "b"]);
    expect(missingMethods(C, Object.assign(function () {}, { a() {}, b() {} }))).toEqual([]);
    expect(missingMethods(C, Object.assign(function () {}, { a() {} }))).toEqual(["b"]);
  });
});
