import { describe, expect, it } from "vitest";
import type { ObservedRead } from "@michaelthielemann/kestrel/reads";
import { canonicalJson, normalizeReads } from "./dependencies.ts";

const self = { type: "pages", docId: "p1" };
const rules = { home: "home", slugField: "slug", prefixPrimary: false, fallback: true, filter: { status: "published" } };

describe("delivery/static normalizeReads", () => {
  it("drops reads of the published document itself: its own writes publish it", () => {
    const reads: ObservedRead[] = [
      { kind: "document", type: "pages", id: "p1", locale: "de" },
      { kind: "path", type: "pages", id: "p1", locale: "de", rules, path: "/" },
      { kind: "document", type: "pages", id: "p2", locale: "de" },
    ];
    expect(normalizeReads(reads, self, 1000)).toEqual([{ kind: "document", depType: "pages", depId: "p2", depLocale: "de", filter: null, rules: null, path: null }]);
  });

  it("deduplicates: one document row per document whatever the locale, one query row per filter and locale", () => {
    const reads: ObservedRead[] = [
      { kind: "document", type: "speakers", id: "s1", locale: "de" },
      { kind: "document", type: "speakers", id: "s1", locale: "en" },
      { kind: "query", type: "speakers", filter: { status: "published", name: { like: "A%" } }, locale: "de" },
      { kind: "query", type: "speakers", filter: { name: { like: "A%" }, status: "published" }, locale: "de" },
      { kind: "query", type: "speakers", filter: { status: "published", name: { like: "A%" } }, locale: "en" },
      { kind: "path", type: "pages", id: "p2", locale: "de", rules, path: "/info" },
      { kind: "path", type: "pages", id: "p2", locale: "de", rules: { ...rules }, path: "/info" },
    ];
    const rows = normalizeReads(reads, self, 1000);
    expect(rows?.map((r) => [r.kind, r.depType, r.depId, r.depLocale])).toEqual([
      ["document", "speakers", "s1", "de"],
      ["query", "speakers", null, "de"],
      ["query", "speakers", null, "en"],
      ["path", "pages", "p2", "de"],
    ]);
    expect(rows?.[3]).toMatchObject({ rules, path: "/info" });
  });

  it("a type read covers every other read of that type", () => {
    const reads: ObservedRead[] = [
      { kind: "document", type: "settings", id: "x", locale: "de" },
      { kind: "type", type: "settings" },
      { kind: "query", type: "settings", filter: {}, locale: "de" },
      { kind: "type", type: "settings" },
      { kind: "document", type: "media", id: "m1" },
    ];
    expect(normalizeReads(reads, self, 1000)?.map((r) => [r.kind, r.depType, r.depId])).toEqual([
      ["type", "settings", null],
      ["document", "media", "m1"],
    ]);
  });

  it("over the cap, collapses the largest per-type group into one type row first", () => {
    const reads: ObservedRead[] = [
      ...Array.from({ length: 5 }, (_, i): ObservedRead => ({ kind: "document", type: "speakers", id: `s${i}` })),
      { kind: "document", type: "media", id: "m1" },
      { kind: "document", type: "media", id: "m2" },
      { kind: "type", type: "settings" },
    ];
    expect(normalizeReads(reads, self, 4)?.map((r) => [r.kind, r.depType, r.depId])).toEqual([
      ["type", "settings", null],
      ["type", "speakers", null],
      ["document", "media", "m1"],
      ["document", "media", "m2"],
    ]);
    expect(normalizeReads(reads, self, 3)?.map((r) => [r.kind, r.depType])).toEqual([
      ["type", "settings"],
      ["type", "speakers"],
      ["type", "media"],
    ]);
  });

  it("is unknown (null) when even one type row per read type exceeds the cap", () => {
    const reads: ObservedRead[] = [
      { kind: "document", type: "speakers", id: "s1" },
      { kind: "document", type: "media", id: "m1" },
    ];
    expect(normalizeReads(reads, self, 1)).toBeNull();
  });

  it("an empty read list is a known, empty set", () => {
    expect(normalizeReads([], self, 1000)).toEqual([]);
  });
});

describe("delivery/static canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });
});
