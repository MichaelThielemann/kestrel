import { describe, it, expect } from "vitest";
import type { StepDescription } from "./defineModule.ts";
import { coerceQuery, findMissingRequired, resolveOutputSchema, validateSchema } from "./schema.ts";

const step = (partial: Partial<StepDescription>): StepDescription => ({ summary: "s", reads: [], writes: [], ...partial });

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

describe("coerceQuery", () => {
  const query = { limit: { type: "integer" }, ratio: { type: "number" }, deep: { type: "boolean" }, ids: { type: "array", items: { type: "string" } }, sort: { type: "string" }, sizes: { type: "array", items: { type: "integer" } } };

  it("converts strings to the declared integer, number and boolean types", () => {
    expect(coerceQuery(query, { limit: "10", ratio: "1.5", deep: "true" })).toEqual({ limit: 10, ratio: 1.5, deep: true });
    expect(coerceQuery(query, { deep: "false" })).toEqual({ deep: false });
  });

  it("leaves text that does not convert untouched so validation reports it", () => {
    expect(coerceQuery(query, { limit: "abc", ratio: "", deep: "yes", limit2: "1" })).toEqual({ limit: "abc", ratio: "", deep: "yes" });
    expect(coerceQuery(query, { limit: "1.5" })).toEqual({ limit: "1.5" });
    expect(validateSchema(query.limit, coerceQuery(query, { limit: "abc" }).limit)).toEqual([{ path: "$", message: "expected integer, got string" }]);
  });

  it("wraps a single value for an array parameter and converts array items", () => {
    expect(coerceQuery(query, { ids: "a" })).toEqual({ ids: ["a"] });
    expect(coerceQuery(query, { ids: ["a", "b"] })).toEqual({ ids: ["a", "b"] });
    expect(coerceQuery(query, { sizes: ["1", "2"] })).toEqual({ sizes: [1, 2] });
    expect(coerceQuery(query, { sizes: "3" })).toEqual({ sizes: [3] });
  });

  it("copies only declared keys and never the strings themselves", () => {
    const values = { limit: "10", other: "x" };
    expect(coerceQuery(query, values)).toEqual({ limit: 10 });
    expect(values.limit).toBe("10");
    expect(coerceQuery(query, { sort: 5 })).toEqual({ sort: 5 });
  });
});

describe("resolveOutputSchema", () => {
  it("takes the last declared output", () => {
    const first = { type: "object", properties: { a: { type: "string" } } };
    const second = { type: "object", properties: { b: { type: "string" } } };
    expect(resolveOutputSchema([step({ output: first }), step({ output: second })])).toEqual(second);
  });

  it("merges extendsOutput into the preceding output", () => {
    const output = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const extension = { type: "object", properties: { b: { type: "string" } }, required: ["b"] };
    expect(resolveOutputSchema([step({ output }), step({ extendsOutput: extension })])).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    });
  });

  it("leaves the active output unchanged through a step with neither output nor extendsOutput", () => {
    const output = { type: "object", properties: { a: { type: "string" } } };
    expect(resolveOutputSchema([step({ output }), step({})])).toEqual(output);
  });

  it("returns undefined when nothing declares an output", () => {
    expect(resolveOutputSchema([step({}), step({})])).toBeUndefined();
  });

  it("merges extendsOutput into the properties of the preceding extendsOutput merge, without an output in between", () => {
    const a = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const b = { type: "object", properties: { b: { type: "string" } }, required: ["b"] };
    expect(resolveOutputSchema([step({ extendsOutput: a }), step({ extendsOutput: b })])).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    });
  });

  it("extendsOutput onto a union merges into every branch and keeps oneOf/anyOf", () => {
    const a = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const b = { type: "object", properties: { b: { type: "string" } }, required: ["b"] };
    const extra = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] };
    expect(resolveOutputSchema([step({ output: { oneOf: [a, b] } }), step({ extendsOutput: extra })])).toEqual({
      oneOf: [
        { type: "object", properties: { a: { type: "string" }, tag: { type: "string" } }, required: ["a", "tag"] },
        { type: "object", properties: { b: { type: "string" }, tag: { type: "string" } }, required: ["b", "tag"] },
      ],
    });
    expect(resolveOutputSchema([step({ output: { anyOf: [a, b] } }), step({ extendsOutput: extra })])).toEqual({
      anyOf: [
        { type: "object", properties: { a: { type: "string" }, tag: { type: "string" } }, required: ["a", "tag"] },
        { type: "object", properties: { b: { type: "string" }, tag: { type: "string" } }, required: ["b", "tag"] },
      ],
    });
  });

  it("extendsItems onto a union merges into the items of list-shaped branches and at the root of the others", () => {
    const listBranch = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, total: { type: "integer" } }, required: ["items", "total"] };
    const singleBranch = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
    const extension = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] };
    const result = resolveOutputSchema([step({ output: { oneOf: [listBranch, singleBranch] } }), step({ extendsItems: extension })]);
    expect(result).toEqual({
      oneOf: [
        { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, tag: { type: "string" } }, required: ["id", "tag"] } }, total: { type: "integer" } }, required: ["items", "total"] },
        { type: "object", properties: { id: { type: "string" }, tag: { type: "string" } }, required: ["id", "tag"] },
      ],
    });
  });
});

describe("resolveOutputSchema fold contradictions", () => {
  it("reports extendsOutput onto a non-object, non-union schema without changing the fold", () => {
    const list = { type: "array", items: { type: "string" } };
    const extension = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] };
    const hits: Array<{ index: number; keyword: string; reason: string; sourceIndex: number | undefined }> = [];
    const result = resolveOutputSchema([step({ output: list }), step({ extendsOutput: extension })], (index, keyword, reason, sourceIndex) => hits.push({ index, keyword, reason, sourceIndex }));
    expect(hits).toEqual([{ index: 1, keyword: "extendsOutput", reason: 'type "array", not "object"', sourceIndex: 0 }]);
    expect(result).toEqual(list);
  });

  it("reports the step that set the active schema, not just the immediately preceding one", () => {
    const list = { type: "array", items: { type: "string" } };
    const extension = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] };
    const hits: Array<number | undefined> = [];
    resolveOutputSchema([step({ output: list }), step({}), step({}), step({ extendsOutput: extension })], (_index, _keyword, _reason, sourceIndex) => hits.push(sourceIndex));
    expect(hits).toEqual([0]);
  });

  it("reports a type array and an allOf schema as a contradiction, each naming the shape", () => {
    const extension = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] };
    const hitsA: string[] = [];
    resolveOutputSchema([step({ output: { type: ["object", "null"] } }), step({ extendsOutput: extension })], (_i, _k, reason) => hitsA.push(reason));
    expect(hitsA).toEqual(['a type array ("object", "null")']);
    const hitsB: string[] = [];
    resolveOutputSchema([step({ output: { allOf: [{ type: "object" }] } }), step({ extendsOutput: extension })], (_i, _k, reason) => hitsB.push(reason));
    expect(hitsB).toEqual(["an allOf schema"]);
    const hitsC: string[] = [];
    resolveOutputSchema([step({ output: {} }), step({ extendsOutput: extension })], (_i, _k, reason) => hitsC.push(reason));
    expect(hitsC).toEqual(["a schema without a declared type"]);
  });

  it("reports extendsOutput onto a union with a non-object branch", () => {
    const union = { oneOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "string" }] };
    const extension = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] };
    const hits: string[] = [];
    resolveOutputSchema([step({ output: union }), step({ extendsOutput: extension })], (_i, keyword, reason) => hits.push(`${keyword}: ${reason}`));
    expect(hits).toEqual(["extendsOutput: a union with a non-object branch"]);
  });

  it("reports a non-object extension for both extendsOutput and extendsItems", () => {
    const hitsA: string[] = [];
    resolveOutputSchema([step({ extendsOutput: { type: "array" } })], (_i, keyword, reason) => hitsA.push(`${keyword}: ${reason}`));
    expect(hitsA).toEqual(["extendsOutput: the extension is not an object schema"]);
    const hitsB: string[] = [];
    resolveOutputSchema([step({ output: { type: "object", properties: {}, required: [] } }), step({ extendsItems: { type: "array" } })], (_i, keyword, reason) => hitsB.push(`${keyword}: ${reason}`));
    expect(hitsB).toEqual(["extendsItems: the extension is not an object schema"]);
  });

  it("reports extendsItems onto a union with no list-shaped branch", () => {
    const union = { oneOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object", properties: { b: { type: "string" } }, required: ["b"] }] };
    const extension = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] };
    const hits: string[] = [];
    resolveOutputSchema([step({ output: union }), step({ extendsItems: extension })], (_i, keyword, reason) => hits.push(`${keyword}: ${reason}`));
    expect(hits).toEqual(["extendsItems: a union with no list-shaped branch"]);
  });

  it("reports extendsItems root fallback onto a non-object schema", () => {
    const extension = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] };
    const hits: string[] = [];
    resolveOutputSchema([step({ output: { type: "array", items: { type: "string" } } }), step({ extendsItems: extension })], (_i, keyword, reason) => hits.push(`${keyword}: ${reason}`));
    expect(hits).toEqual(['extendsItems: type "array", not "object"']);
  });

  it("does not report a contradiction for an object-only union, or extendsItems onto a single non-list object", () => {
    const hits: unknown[] = [];
    const collect = () => hits.push(1);
    const a = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const b = { type: "object", properties: { b: { type: "string" } }, required: ["b"] };
    const extension = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] };
    resolveOutputSchema([step({ output: { oneOf: [a, b] } }), step({ extendsOutput: extension })], collect);
    resolveOutputSchema([step({ output: a }), step({ extendsItems: extension })], collect);
    expect(hits).toEqual([]);
  });
});

describe("findMissingRequired", () => {
  it("reports the root schema when it declares properties without required", () => {
    expect(findMissingRequired({ type: "object", properties: { a: { type: "string" } } })).toEqual(["$"]);
  });

  it("stays quiet once required is declared, even as an empty array", () => {
    expect(findMissingRequired({ type: "object", properties: { a: { type: "string" } }, required: [] })).toEqual([]);
    expect(findMissingRequired({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })).toEqual([]);
  });

  it("ignores a schema with no properties", () => {
    expect(findMissingRequired({ type: "string" })).toEqual([]);
    expect(findMissingRequired({ type: "object" })).toEqual([]);
  });

  it("recurses into nested object properties", () => {
    const schema = { type: "object", properties: { meta: { type: "object", properties: { hits: { type: "integer" } } } }, required: ["meta"] };
    expect(findMissingRequired(schema)).toEqual(["$.properties.meta"]);
  });

  it("recurses into array items, single and tuple", () => {
    const single = { type: "array", items: { type: "object", properties: { id: { type: "string" } } } };
    expect(findMissingRequired(single)).toEqual(["$.items"]);
    const tuple = { type: "array", items: [{ type: "object", properties: { id: { type: "string" } } }] };
    expect(findMissingRequired(tuple)).toEqual(["$.items[0]"]);
  });

  it("recurses into oneOf/anyOf/allOf branches", () => {
    const branch = { type: "object", properties: { id: { type: "string" } } };
    expect(findMissingRequired({ oneOf: [branch] })).toEqual(["$.oneOf[0]"]);
    expect(findMissingRequired({ anyOf: [branch] })).toEqual(["$.anyOf[0]"]);
    expect(findMissingRequired({ allOf: [branch] })).toEqual(["$.allOf[0]"]);
  });

  it("recurses into an object-valued additionalProperties", () => {
    const schema = { type: "object", additionalProperties: { type: "object", properties: { id: { type: "string" } } } };
    expect(findMissingRequired(schema)).toEqual(["$.additionalProperties"]);
  });

  it("ignores a boolean additionalProperties", () => {
    expect(findMissingRequired({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false })).toEqual([]);
  });

  it("collects every offending path in one pass, prefixed by the given root", () => {
    const schema = {
      type: "object",
      properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, meta: { type: "object", properties: { hits: { type: "integer" } } } },
    };
    expect(findMissingRequired(schema, "$.output")).toEqual(["$.output", "$.output.properties.meta"]);
  });
});

