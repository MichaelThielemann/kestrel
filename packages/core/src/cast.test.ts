import { describe, it, expect } from "vitest";
import { boundaryCast } from "./cast.ts";

describe("boundaryCast", () => {
  it("returns the value unchanged", () => {
    const parsed: unknown = JSON.parse('{"name":"x"}');
    const value = boundaryCast<{ name: string }>(parsed, "json");
    expect(value).toBe(parsed);
    expect(value.name).toBe("x");
  });

  it("does not touch the boundary argument", () => {
    expect(boundaryCast<null>(null, "host")).toBeNull();
    expect(boundaryCast<undefined>(undefined, "dom")).toBeUndefined();
  });
});
