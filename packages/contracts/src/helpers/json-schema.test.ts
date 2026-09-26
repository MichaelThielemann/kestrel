import { describe, expect, it } from "vitest";
import { declaresType, jsonTypeOf, resolveSchema, typeTag } from "./json-schema.ts";

const root = {
  $defs: {
    id: { type: "string" },
    alias: { $ref: "#/$defs/id" },
    loop: { $ref: "#/$defs/loop" },
    block: { type: "object", properties: { type: { const: "hero" } } },
    blockAlias: { $ref: "#/$defs/block" },
  },
};

describe("resolveSchema", () => {
  it("returns a node without $ref as it is", () => {
    const node = { type: "number" };
    expect(resolveSchema(root, node)).toBe(node);
  });

  it("follows a chain of local $refs", () => {
    expect(resolveSchema(root, { $ref: "#/$defs/alias" })).toEqual({ type: "string" });
  });

  it("keeps keywords next to a $ref, over the target's", () => {
    expect(resolveSchema(root, { $ref: "#/$defs/id", "x-marker": "media", type: "integer" })).toEqual({ type: "integer", "x-marker": "media" });
  });

  it("answers undefined for a remote ref, an unknown pointer, a cycle and a non-object", () => {
    expect(resolveSchema(root, { $ref: "https://example.com/schema.json" })).toBeUndefined();
    expect(resolveSchema(root, { $ref: "#/$defs/missing" })).toBeUndefined();
    expect(resolveSchema(root, { $ref: "#/$defs/loop" })).toBeUndefined();
    expect(resolveSchema(root, "string")).toBeUndefined();
  });
});

describe("typeTag and declaresType", () => {
  it("reads the type const of a resolved branch", () => {
    expect(typeTag(resolveSchema(root, { $ref: "#/$defs/blockAlias" }))).toBe("hero");
    expect(typeTag({ type: "object" })).toBeUndefined();
  });

  it("matches a single type name and a list of them, never an absent type", () => {
    expect(declaresType({ type: "string" }, "x")).toBe(true);
    expect(declaresType({ type: ["null", "string"] }, "x")).toBe(true);
    expect(declaresType({ type: ["null", "number"] }, "x")).toBe(false);
    expect(declaresType({}, "x")).toBe(false);
  });

  it("names the JSON type of a value", () => {
    expect([null, [], {}, "a", 1, true].map(jsonTypeOf)).toEqual(["null", "array", "object", "string", "number", "boolean"]);
  });
});
