import { describe, expect, it } from "vitest";
import { RedirectRuleError as PublicError, type RedirectRuleDetails as PublicDetails, type RedirectRuleField as PublicField, type RedirectRuleReason as PublicReason } from "./impl.ts";
import { compilePublishableRedirects, compileRedirects, MAX_FROM_LENGTH, MAX_RULES, MAX_WILDCARDS, normalizeTarget, patternToRegexSource, RedirectRuleError, type RedirectRuleDetails } from "./rules.ts";

function rejection(work: () => unknown): RedirectRuleError {
  try {
    work();
  } catch (error) {
    if (error instanceof RedirectRuleError) return error;
    throw error;
  }
  throw new Error("expected a RedirectRuleError");
}

const reservedPaths = ["/admin", "/api"];

const manyWildcards = `/${Array.from({ length: MAX_WILDCARDS + 1 }, () => "*").join("/")}`;

const fromCases: Array<[string, unknown, RedirectRuleDetails]> = [
  ["a blank source", "  ", { row: 1, field: "from", reason: "blank" }],
  ["a source that is not a string", undefined, { row: 1, field: "from", reason: "blank" }],
  ["a source over the length limit", `/${"a".repeat(MAX_FROM_LENGTH)}`, { row: 1, field: "from", reason: "too-long" }],
  ["a source with a scheme", "https://x.example/a", { row: 1, field: "from", reason: "scheme-or-host" }],
  ["a protocol-relative source", "//x.example/a", { row: 1, field: "from", reason: "scheme-or-host" }],
  ["a query string", "/a?b=1", { row: 1, field: "from", reason: "query-or-fragment" }],
  ["a fragment", "/a#b", { row: 1, field: "from", reason: "query-or-fragment" }],
  ["a control character", "/a\u0007b", { row: 1, field: "from", reason: "control-characters" }],
  ["a backslash", "/a\\b", { row: 1, field: "from", reason: "backslash" }],
  ["a dot segment", "/a/../b", { row: 1, field: "from", reason: "dot-segments" }],
  ["two adjacent double wildcards", "/a/**/**", { row: 1, field: "from", reason: "adjacent-double-wildcards" }],
  ["more wildcards than the limit", manyWildcards, { row: 1, field: "from", reason: "too-many-wildcards" }],
  ["the reserved path itself", "/admin", { row: 1, field: "from", reason: "reserved-path", path: "/admin" }],
  ["a path below a reserved path", "/api/x/y", { row: 1, field: "from", reason: "reserved-path", path: "/api" }],
  ["a wildcard that reaches a reserved path", "/*/login", { row: 1, field: "from", reason: "reserved-path", path: "/admin" }],
];

const toCases: Array<[string, string, unknown, RedirectRuleDetails]> = [
  ["a blank target", "/a", "  ", { row: 1, field: "to", reason: "blank" }],
  ["a target that is not a string", "/a", undefined, { row: 1, field: "to", reason: "blank" }],
  ["a control character", "/a", "/b\u0007", { row: 1, field: "to", reason: "control-characters" }],
  ["a backslash", "/a", "/b\\c", { row: 1, field: "to", reason: "backslash" }],
  ["a protocol-relative target", "/a", "//evil.example", { row: 1, field: "to", reason: "protocol-relative" }],
  ["a scheme other than http(s)", "/a", "javascript:alert(1)", { row: 1, field: "to", reason: "unsupported-scheme" }],
  ["an unparsable url", "/a", "https://[", { row: 1, field: "to", reason: "invalid-url" }],
  ["embedded credentials", "/a", "https://user:pw@x.example/", { row: 1, field: "to", reason: "embedded-credentials" }],
  ["a placeholder in the host", "/a/*", "https://x.example$1/", { row: 1, field: "to", reason: "placeholder-in-host" }],
  ["a placeholder beyond the wildcards", "/a/*", "/x/$2", { row: 1, field: "to", reason: "placeholder-out-of-range" }],
  ["a placeholder written as ${1}", "/a/*", "/x/${1}", { row: 1, field: "to", reason: "placeholder-syntax" }],
];

describe("redirect rule rejection reasons", () => {
  it.each(fromCases)("tags %s with its reason, field and path", (_name, from, expected) => {
    const error = rejection(() => compileRedirects([{ from, to: "/t" }], { reservedPaths }));
    expect(error.toDetails()).toEqual(expected);
  });

  it.each(toCases)("tags %s in the target with its reason and field", (_name, from, to, expected) => {
    const error = rejection(() => compileRedirects([{ from, to }]));
    expect(error.toDetails()).toEqual(expected);
  });

  it("tags an unsupported status", () => {
    const error = rejection(() => compileRedirects([{ from: "/a", to: "/b", status: "303" }]));
    expect(error.toDetails()).toEqual({ row: 1, field: "status", reason: "invalid-status" });
  });

  it("reports the row of the failing entry", () => {
    const error = rejection(() => compileRedirects([{ from: "/a", to: "/b" }, { from: "/c", to: "/d" }, { from: "/admin/x", to: "/e" }], { reservedPaths }));
    expect(error.toDetails()).toEqual({ row: 3, field: "from", reason: "reserved-path", path: "/admin" });
    expect(error.row).toBe(3);
    expect(error.message).toMatch(/^Row 3: /);
  });

  it("rejects a status that cannot be turned into text as an invalid status", () => {
    const rows: unknown = JSON.parse('[{"from":"/a","to":"/b","status":{"toString":1}}]');
    expect(rejection(() => compileRedirects(rows)).toDetails()).toEqual({ row: 1, field: "status", reason: "invalid-status" });
  });

  it("skips a row with such a status and keeps the others when publishing", () => {
    const rows: unknown = JSON.parse('[{"from":"/ok","to":"/t"},{"from":"/a","to":"/b","status":{"toString":1}}]');
    const { rules, skippedRules } = compilePublishableRedirects(rows);
    expect(rules.map((rule) => rule.from)).toEqual(["/ok"]);
    expect(skippedRules).toEqual([{ row: 2, field: "status", reason: "invalid-status" }]);
  });

  it("tags a list-level rejection without a row or field", () => {
    expect(rejection(() => compileRedirects("nope")).toDetails()).toEqual({ reason: "not-a-list" });
    const rows = Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ from: `/old/${i}`, to: `/new/${i}` }));
    expect(rejection(() => compileRedirects(rows)).toDetails()).toEqual({ reason: "too-many-rules" });
  });

  it("keeps the message text of every rejection", () => {
    expect(rejection(() => compileRedirects([{ from: "/admin/x", to: "/t" }], { reservedPaths })).message).toBe('Row 1: "From" can match the reserved path /admin, which the application serves itself');
    expect(rejection(() => compileRedirects([{ from: "/a", to: "/b", status: "303" }])).message).toBe("Row 1: Status must be one of 301, 302, 307, 308 (got 303)");
  });

  it("tags a source rejected outside a row context", () => {
    expect(rejection(() => patternToRegexSource("/a?b")).toDetails()).toEqual({ field: "from", reason: "query-or-fragment" });
    expect(rejection(() => normalizeTarget("//x")).toDetails()).toEqual({ field: "to", reason: "protocol-relative" });
  });

  it("describes every skipped row of a publishable list with the same structure", () => {
    const rows = [{ from: "/a", to: "/b" }, { from: "/admin/login", to: "/c" }, { from: "/bad?x", to: "/c" }, { from: "/d", to: "/e", status: "303" }];
    const { skipped, skippedRules } = compilePublishableRedirects(rows, { reservedPaths });
    expect(skipped).toHaveLength(3);
    expect(skippedRules).toEqual([
      { row: 2, field: "from", reason: "reserved-path", path: "/admin" },
      { row: 3, field: "from", reason: "query-or-fragment" },
      { row: 4, field: "status", reason: "invalid-status" },
    ]);
  });

  it("describes the rows beyond the limit of a publishable list", () => {
    const rows = Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ from: `/old/${i}`, to: `/new/${i}` }));
    expect(compilePublishableRedirects(rows).skippedRules).toEqual([{ row: MAX_RULES + 1, reason: "too-many-rules" }]);
  });
});

describe("public rejection types", () => {
  it("are importable from the impl entry point and match what a rejection carries", () => {
    const reason: PublicReason = "reserved-path";
    const field: PublicField = "from";
    const details: PublicDetails = { row: 1, field, reason, path: "/admin" };
    expect(new PublicError("Row 1: x", details).toDetails()).toEqual(details);
  });
});
