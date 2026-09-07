import { describe, it, expect } from "vitest";
import { validateSchema } from "./schema.ts";

const paths = (schema: Record<string, unknown>, value: unknown) => validateSchema(schema, value).map((p) => p.path);
const ok = (schema: Record<string, unknown>, value: unknown) => validateSchema(schema, value);

describe("validateSchema", () => {
  it("type accepts the matching value and rejects the others", () => {
    expect(ok({ type: "string" }, "x")).toEqual([]);
    expect(ok({ type: "number" }, 1.5)).toEqual([]);
    expect(ok({ type: "boolean" }, false)).toEqual([]);
    expect(ok({ type: "null" }, null)).toEqual([]);
    expect(ok({ type: "array" }, [])).toEqual([]);
    expect(ok({ type: "object" }, {})).toEqual([]);
    expect(ok({ type: "string" }, 1)).toEqual([{ path: "$", message: "expected string, got number" }]);
    expect(ok({ type: "object" }, [])).toEqual([{ path: "$", message: "expected object, got array" }]);
    expect(ok({ type: "object" }, null)).toEqual([{ path: "$", message: "expected object, got null" }]);
  });

  it("type integer rejects a fractional number", () => {
    expect(ok({ type: "integer" }, 3)).toEqual([]);
    expect(ok({ type: "integer" }, 3.5)).toEqual([{ path: "$", message: "expected integer, got number" }]);
  });

  it("type accepts an array of names", () => {
    expect(ok({ type: ["string", "null"] }, null)).toEqual([]);
    expect(ok({ type: ["string", "null"] }, 1)).toEqual([{ path: "$", message: "expected string or null, got number" }]);
  });

  it("properties validates the keys that are present and names their path", () => {
    const schema = { type: "object", properties: { title: { type: "string" }, meta: { type: "object", properties: { hits: { type: "integer" } } } } };
    expect(ok(schema, { title: "x", meta: { hits: 1 } })).toEqual([]);
    expect(ok(schema, {})).toEqual([]);
    expect(ok(schema, { title: 1 })).toEqual([{ path: "$.title", message: "expected string, got number" }]);
    expect(paths(schema, { meta: { hits: 1.5 } })).toEqual(["$.meta.hits"]);
  });

  it("required reports a missing key at its own path", () => {
    const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
    expect(ok(schema, { title: "x" })).toEqual([]);
    expect(ok(schema, {})).toEqual([{ path: "$.title", message: "is required" }]);
    expect(ok(schema, { title: undefined })).toEqual([{ path: "$.title", message: "is required" }]);
  });

  it("additionalProperties false rejects unknown keys and true ignores them", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
    expect(ok(schema, { a: "x" })).toEqual([]);
    expect(ok(schema, { a: "x", b: 1 })).toEqual([{ path: "$.b", message: "is not allowed by additionalProperties: false" }]);
    expect(ok({ ...schema, additionalProperties: true }, { a: "x", b: 1 })).toEqual([]);
  });

  it("items validates every element and indexes the path", () => {
    const schema = { type: "array", items: { type: "string" } };
    expect(ok(schema, ["a", "b"])).toEqual([]);
    expect(ok(schema, ["a", 2])).toEqual([{ path: "$[1]", message: "expected string, got number" }]);
  });

  it("items in tuple form validates positionally", () => {
    const schema = { type: "array", items: [{ type: "string" }, { type: "integer" }] };
    expect(ok(schema, ["a", 1])).toEqual([]);
    expect(paths(schema, ["a", 1.5])).toEqual(["$[1]"]);
  });

  it("enum accepts a listed value and rejects anything else", () => {
    const schema = { enum: ["draft", "live"] };
    expect(ok(schema, "live")).toEqual([]);
    expect(ok(schema, "gone")).toEqual([{ path: "$", message: 'expected one of "draft", "live"' }]);
  });

  it("const compares deeply", () => {
    expect(ok({ const: { a: [1] } }, { a: [1] })).toEqual([]);
    expect(ok({ const: { a: [1] } }, { a: [2] })).toEqual([{ path: "$", message: 'expected {"a":[1]}' }]);
    expect(ok({ const: null }, null)).toEqual([]);
  });

  it("pattern applies to strings only", () => {
    const schema = { type: "string", pattern: "^[a-z]+$" };
    expect(ok(schema, "abc")).toEqual([]);
    expect(ok(schema, "ab1")).toEqual([{ path: "$", message: "does not match ^[a-z]+$" }]);
    expect(ok({ pattern: "^[a-z]+$" }, 5)).toEqual([]);
  });

  it("minimum and maximum bound numbers", () => {
    const schema = { type: "number", minimum: 1, maximum: 10 };
    expect(ok(schema, 1)).toEqual([]);
    expect(ok(schema, 10)).toEqual([]);
    expect(ok(schema, 0)).toEqual([{ path: "$", message: "below minimum 1" }]);
    expect(ok(schema, 11)).toEqual([{ path: "$", message: "above maximum 10" }]);
  });

  it("minLength and maxLength bound strings by code point", () => {
    const schema = { type: "string", minLength: 2, maxLength: 3 };
    expect(ok(schema, "ab")).toEqual([]);
    expect(ok(schema, "😀😀")).toEqual([]);
    expect(ok(schema, "a")).toEqual([{ path: "$", message: "shorter than minLength 2" }]);
    expect(ok(schema, "abcd")).toEqual([{ path: "$", message: "longer than maxLength 3" }]);
  });

  it("minItems bounds arrays", () => {
    const schema = { type: "array", minItems: 1 };
    expect(ok(schema, ["a"])).toEqual([]);
    expect(ok(schema, [])).toEqual([{ path: "$", message: "fewer than minItems 1" }]);
  });

  it("oneOf requires exactly one match", () => {
    const schema = { oneOf: [{ type: "string" }, { type: "integer" }] };
    expect(ok(schema, "x")).toEqual([]);
    expect(ok(schema, true)).toEqual([{ path: "$", message: "matches 0 of 2 oneOf schemas, expected exactly 1" }]);
    expect(ok({ oneOf: [{ type: "number" }, { type: "integer" }] }, 3)).toEqual([{ path: "$", message: "matches 2 of 2 oneOf schemas, expected exactly 1" }]);
  });

  it("anyOf requires at least one match", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "integer" }] };
    expect(ok(schema, 3)).toEqual([]);
    expect(ok(schema, true)).toEqual([{ path: "$", message: "matches none of the 2 anyOf schemas" }]);
  });

  it("ignores format and unknown keywords", () => {
    expect(ok({ type: "string", format: "date-time" }, "not a date")).toEqual([]);
    expect(ok({ type: "string", "x-kestrel": { anything: true }, exclusiveMinimum: 5 }, "x")).toEqual([]);
  });

  it("reports every problem of a payload, not just the first", () => {
    const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["c"], additionalProperties: false };
    expect(paths(schema, { a: 1, b: 1.5, d: true })).toEqual(["$.c", "$.a", "$.b", "$.d"]);
  });

  it("quotes a key that is not an identifier", () => {
    expect(paths({ type: "object", properties: { "content-type": { type: "string" } } }, { "content-type": 1 })).toEqual(['$["content-type"]']);
  });
});
