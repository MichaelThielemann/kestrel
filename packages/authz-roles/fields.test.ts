import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { binaryResult } from "@michaelthielemann/kestrel/context";
import type { JsonSchema } from "@michaelthielemann/kestrel/defineModule";
import { answerShape, cutAnswer, declaredPath, fieldTree, parseFieldsArgument, uncoveredMember } from "./fields.ts";

describe("the authz.fields argument", () => {
  it("names a resource and the answer's shape", () => {
    expect(parseFieldsArgument("media?shape=list")).toEqual({ resource: "media", shape: "list" });
    expect(parseFieldsArgument("redirectRules?shape=array")).toEqual({ resource: "redirectRules", shape: "array" });
    expect(parseFieldsArgument("mediaFile?shape=file")).toEqual({ resource: "mediaFile", shape: "file" });
    expect(parseFieldsArgument("pages?shape=item")).toEqual({ resource: "pages", shape: "item" });
  });

  it("refuses a missing or unknown shape, another parameter and a malformed resource", () => {
    for (const arg of ["media", "media?shape=", "media?shape=tree", "media?shape=list&x=1", "media?list", "1media?shape=item", "me dia?shape=item", "<arg>", ""]) {
      expect(parseFieldsArgument(arg), arg).toBeUndefined();
    }
  });
});

describe("cutting an answer to a field tree", () => {
  const item = { id: "m1", folder: "private", provenance: { origin: "human", tool: "cam" }, variants: [{ path: "/a.webp", bytes: 10 }, { path: "/b.webp", bytes: 20 }], alt: null, tags: ["x"] };
  const tree = fieldTree(["id", "provenance.origin", "variants[].path", "alt", "tags"]);

  it("keeps the granted members of one item, a subtree into objects and arrays, and drops the rest", () => {
    expect(cutAnswer(item, "item", tree)).toEqual({ id: "m1", provenance: { origin: "human" }, variants: [{ path: "/a.webp" }, { path: "/b.webp" }], alt: null, tags: ["x"] });
  });

  it("cuts every element of a list's items, keeps total and drops every other envelope member", () => {
    expect(cutAnswer({ items: [item], total: 1, cursor: "c" }, "list", tree)).toEqual({ items: [{ id: "m1", provenance: { origin: "human" }, variants: [{ path: "/a.webp" }, { path: "/b.webp" }], alt: null, tags: ["x"] }], total: 1 });
  });

  it("cuts every element of an array answer", () => {
    expect(cutAnswer([{ pattern: "/a", target: "/b", status: 301, note: "internal" }], "array", fieldTree(["pattern", "target", "status"]))).toEqual([{ pattern: "/a", target: "/b", status: 301 }]);
  });

  it("keeps a file's bytes, type and name and only the granted headers, whatever their case", () => {
    const file = { ...binaryResult(new Uint8Array([1, 2]), "image/png", "a.png"), headers: { "Cache-Control": "public", "X-Content-Provenance": "ai", "x-internal": "1" } };
    expect(cutAnswer(file, "file", fieldTree(["headers.cache-control", "headers.x-content-provenance"]))).toEqual({ ...binaryResult(new Uint8Array([1, 2]), "image/png", "a.png"), headers: { "Cache-Control": "public", "X-Content-Provenance": "ai" } });
    expect(cutAnswer(binaryResult(new Uint8Array([1]), "image/png"), "file", fieldTree(["headers.cache-control"]))).toEqual(binaryResult(new Uint8Array([1]), "image/png"));
  });

  it("keeps null and scalar answers as they are", () => {
    expect(cutAnswer(null, "item", tree)).toBeNull();
    expect(cutAnswer(7, "item", tree)).toBe(7);
    expect(cutAnswer({ id: "x", provenance: null }, "item", tree)).toEqual({ id: "x", provenance: null });
  });

  it("lets a whole grant win over a subtree of the same member", () => {
    expect(cutAnswer(item, "item", fieldTree(["provenance.origin", "provenance"]))).toEqual({ provenance: { origin: "human", tool: "cam" } });
    expect(cutAnswer(item, "item", fieldTree(["provenance", "provenance.origin"]))).toEqual({ provenance: { origin: "human", tool: "cam" } });
  });

  it("keeps a granted member named like an Object.prototype key as an own member", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"id":"x"}') as unknown;
    const cut = cutAnswer(hostile, "item", fieldTree(["__proto__", "id"]));
    expect(Object.getPrototypeOf(cut)).toBe(Object.prototype);
    expect(Object.keys(boundaryCast<Record<string, unknown>>(cut, "json"))).toEqual(["__proto__", "id"]);
    expect(cutAnswer(hostile, "item", fieldTree(["id"]))).toEqual({ id: "x" });
  });
});

const ITEM: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    provenance: { type: "object", properties: { origin: { type: "string" } }, required: ["origin"] },
    variants: { type: "array", items: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    _translations: { type: "object", additionalProperties: { type: "boolean" } },
    body: { anyOf: [{}, { type: "null" }] },
    hero: { anyOf: [{ type: "object", properties: { id: { type: "string" } }, required: ["id"] }, { type: "null" }] },
  },
  required: ["id"],
};

describe("the shape of a declared answer", () => {
  it("is a list for { items: object[] }, an array for object[], an item for any other object, a file after a binary step", () => {
    expect(answerShape({ type: "object", properties: { items: { type: "array", items: ITEM }, total: { type: "number" } }, required: ["items", "total"] }, false)).toBe("list");
    expect(answerShape({ type: "array", items: ITEM }, false)).toBe("array");
    expect(answerShape(ITEM, false)).toBe("item");
    expect(answerShape(undefined, true)).toBe("file");
    expect(answerShape(undefined, false)).toBe("item");
  });

  it("is the branches' shape for a union whose branches agree, and undefined when they do not", () => {
    expect(answerShape({ anyOf: [ITEM, { type: "object", properties: { x: { type: "string" } }, required: [] }] }, false)).toBe("item");
    expect(answerShape({ anyOf: [ITEM, { type: "array", items: ITEM }] }, false)).toBeUndefined();
  });
});

describe("whether a declared item has a field path", () => {
  it("finds members, members of objects, elements of arrays and nullable unions", () => {
    for (const path of ["id", "provenance", "provenance.origin", "variants", "variants[]", "variants[].path", "_translations", "body", "hero.id"]) {
      expect(declaredPath(ITEM, path), path).toEqual({ declared: true });
    }
  });

  it("names the way to write a path the schema reaches differently", () => {
    expect(declaredPath(ITEM, "variants.path")).toEqual({ declared: false, hint: '"variants" is a list, write "variants[].path"' });
    expect(declaredPath(ITEM, "provenance[].origin")).toEqual({ declared: false, hint: '"provenance" is not a list, write "provenance.origin"' });
    expect(declaredPath(ITEM, "_translations.de")).toEqual({ declared: false, hint: 'grant "_translations" whole' });
    expect(declaredPath(ITEM, "body.blocks")).toEqual({ declared: false, hint: 'grant "body" whole' });
    expect(declaredPath(ITEM, "folderr")).toEqual({ declared: false });
    expect(declaredPath(ITEM, "provenance.tool")).toEqual({ declared: false });
  });
});

describe("whether a field tree covers every member an answer schema can carry", () => {
  const redirect: JsonSchema = { type: "object", properties: { redirect: { type: "object", properties: { to: { type: "string" }, status: { type: "integer" } }, required: ["to", "status"], additionalProperties: false } }, required: ["redirect"], additionalProperties: false };

  it("covers a closed answer whose members are all granted, whole or member by member", () => {
    expect(uncoveredMember(redirect, fieldTree(["redirect"]))).toBeUndefined();
    expect(uncoveredMember(redirect, fieldTree(["redirect.to", "redirect.status"]))).toBeUndefined();
  });

  it("names the first ungranted member and an open object no grant can bound", () => {
    expect(uncoveredMember(redirect, fieldTree(["redirect.to"]))).toEqual({ kind: "ungranted", path: "redirect.status" });
    expect(uncoveredMember(redirect, fieldTree(["id"]))).toEqual({ kind: "ungranted", path: "redirect" });
    expect(uncoveredMember({ type: "object", properties: { redirect: { type: "string" } }, required: ["redirect"] }, fieldTree(["redirect"]))).toEqual({ kind: "open", path: "" });
  });
});
