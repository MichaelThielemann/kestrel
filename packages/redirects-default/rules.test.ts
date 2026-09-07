import { describe, it, expect } from "vitest";
import { compilePublishableRedirects, compileRedirects, matchRedirect, normalizeTarget, patternToRegexSource, RedirectRuleError, serializeRedirects } from "./rules.ts";

describe("patternToRegexSource", () => {
  it("anchors literals, tolerates a trailing slash and escapes regex characters", () => {
    expect(patternToRegexSource("/alte-seite/")).toBe("^/alte\\-seite/?$");
    expect(patternToRegexSource("alte.seite")).toBe("^/alte\\.seite/?$");
    expect(patternToRegexSource("/")).toBe("^/$");
  });
  it("turns * into one segment and ** into one or more", () => {
    expect(new RegExp(patternToRegexSource("/blog/*")).exec("/blog/hallo")?.[1]).toBe("hallo");
    expect(new RegExp(patternToRegexSource("/blog/*")).test("/blog/a/b")).toBe(false);
    expect(new RegExp(patternToRegexSource("/blog/**")).exec("/blog/a/b/")?.[1]).toBe("a/b");
    expect(new RegExp(patternToRegexSource("/blog/**")).test("/blog//x")).toBe(false);
  });
  it("rejects hosts, queries, fragments, backslashes, .. and adjacent **", () => {
    for (const bad of ["https://x.example/a", "//x/a", "/a?b=1", "/a#b", "/a\\b", "/a/../b", "/a/**/**", ""]) {
      expect(() => patternToRegexSource(bad)).toThrow(RedirectRuleError);
    }
  });
});

describe("normalizeTarget", () => {
  it("adds the leading slash to paths and keeps absolute http(s) urls", () => {
    expect(normalizeTarget("neu")).toBe("/neu");
    expect(normalizeTarget("https://neu.example/a")).toBe("https://neu.example/a");
  });
  it("rejects dangerous targets", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "/a\\b", "https://user:pw@x.example/", "ftp://x.example/", ""]) {
      expect(() => normalizeTarget(bad)).toThrow(RedirectRuleError);
    }
  });
});

describe("compileRedirects", () => {
  it("compiles rows in order with status default 301", () => {
    expect(compileRedirects([{ from: "/blog/*", to: "/artikel/$1" }, { from: "/x", to: "/y", status: "302" }])).toEqual([
      { pattern: patternToRegexSource("/blog/*"), target: "/artikel/$1", status: 301 },
      { pattern: patternToRegexSource("/x"), target: "/y", status: 302 },
    ]);
    expect(compileRedirects(null)).toEqual([]);
  });
  it("names the row in every error", () => {
    expect(() => compileRedirects([{ from: "/a", to: "/b" }, { from: "/blog/*", to: "/x/$2" }])).toThrow(/^Row 2: "To" references \$2 but "From" has 1 wildcard/);
    expect(() => compileRedirects([{ from: "/a", to: "/${1}" }])).toThrow(/Row 1: .*\$1, \$2/);
    expect(() => compileRedirects([{ from: "/a/*", to: "https://x.example$1/" }])).toThrow(/after the host/);
    expect(() => compileRedirects([{ from: "/a", to: "/b", status: "303" }])).toThrow(/Status must be one of 301, 302, 307, 308/);
    expect(() => compileRedirects("nope")).toThrow(/must be a list/);
  });
});

describe("compilePublishableRedirects + serialize + match", () => {
  it("skips broken rows, keeps the rest, and matches first-wins with $n substitution", () => {
    const { rules, skipped } = compilePublishableRedirects([{ from: "/a", to: "/b" }, { from: "/bad?x", to: "/c" }, { from: "/blog/**", to: "https://neu.example/p/$1" }]);
    expect(rules).toHaveLength(2);
    expect(skipped).toEqual(['Row 2: "From" must not contain a query string or fragment']);
    expect(JSON.parse(serializeRedirects(rules))).toEqual(rules);
    expect(serializeRedirects([])).toBe("[]");
    expect(matchRedirect(rules, "/a/")).toEqual({ target: "/b", status: 301 });
    expect(matchRedirect(rules, "/blog/x/y")).toEqual({ target: "https://neu.example/p/x/y", status: 301 });
    expect(matchRedirect(rules, "/nope")).toBeNull();
  });
});
