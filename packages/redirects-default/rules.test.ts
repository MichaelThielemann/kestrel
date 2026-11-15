import { describe, it, expect } from "vitest";
import { matchWildcardPath } from "./match.ts";
import { compilePublishableRedirects, compileRedirects, DEFAULT_RESERVED_PATHS, matchRedirect, MAX_FROM_LENGTH, MAX_LOOKUP_PATH_LENGTH, MAX_RULES, MAX_WILDCARDS, normalizeTarget, patternToRegexSource, RedirectRuleError, serializeRedirects } from "./rules.ts";

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
  it("writes the scheme of an absolute target in lower case and keeps the rest as written", () => {
    expect(normalizeTarget("HTTPS://Example.org/x")).toBe("https://Example.org/x");
    expect(normalizeTarget("Http://example.org/")).toBe("http://example.org/");
    expect(compileRedirects([{ from: "/gross", to: "HTTPS://Example.org/x", status: 302 }])[0]?.target).toBe("https://Example.org/x");
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
      { from: "/blog/*", pattern: patternToRegexSource("/blog/*"), target: "/artikel/$1", status: 301 },
      { from: "/x", pattern: patternToRegexSource("/x"), target: "/y", status: 302 },
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

describe("wildcard matching cost and limits", () => {
  const within = (ms: number, run: () => void) => {
    const start = performance.now();
    run();
    expect(performance.now() - start).toBeLessThan(ms);
  };

  it("carries the canonical from next to the regex pattern", () => {
    expect(compileRedirects([{ from: "blog/*/", to: "/x/$1" }])).toEqual([{ from: "/blog/*", pattern: patternToRegexSource("/blog/*"), target: "/x/$1", status: 301 }]);
    expect(compileRedirects([{ from: "/", to: "/home" }])[0]?.from).toBe("/");
  });

  it("matches several wildcards in one segment against a long near-miss path in linear time", () => {
    const [rule] = compileRedirects([{ from: "/produkte/*-*-*", to: "/p/$1/$2/$3" }]);
    within(50, () => expect(matchWildcardPath(rule!.from, `/produkte/${"-".repeat(8000)}/x`)).toBeNull());
    within(50, () => expect(matchWildcardPath(rule!.from, `/produkte/${"-".repeat(8000)}`)).toEqual(["-".repeat(7996), "-", "-"]));
    within(50, () => expect(matchRedirect([rule!], `/produkte/${"-".repeat(2000)}/x`)).toBeNull());
  });

  it("matches a rule with many wildcards in one segment in linear time", () => {
    const from = `/${Array.from({ length: 12 }, () => "*").join("-")}/x`;
    within(50, () => expect(matchWildcardPath(from, `/${"-".repeat(50)}`)).toBeNull());
    within(50, () => expect(matchWildcardPath(from, `/${"-".repeat(8000)}`)).toBeNull());
    within(50, () => expect(matchWildcardPath(from, `/${"-".repeat(8000)}/x`)).toHaveLength(12));
  });

  it("matches several ** wildcards against a long path in linear time", () => {
    const [rule] = compileRedirects([{ from: "/a/**/b/**/c/**", to: "/z/$1/$2/$3" }]);
    within(50, () => expect(matchWildcardPath(rule!.from, `/a/${"b/c/".repeat(2000)}\\`)).toBeNull());
  });

  it("captures exactly what the exported regex captures", () => {
    const froms = ["/blog/*", "/blog/**", "/*-*-*", "/a/**/b/*", "/**/amp", "/docs/**/*.html", "/x/*.*", "/"];
    const paths = ["/", "/blog/a", "/blog/a/b/", "/blog//x", "/a-b-c-d", "/a-b", "/a/x/y/b/z", "/a/b/b/b/q", "/p/q/amp", "/amp", "/docs/a/b/c.d.html", "/x/a.b.c", "/x/.b", "/blog/a/", "//"];
    for (const from of froms) {
      const [rule] = compileRedirects([{ from, to: from === "/" ? "/home" : "/t" }]);
      for (const path of paths) {
        const m = new RegExp(rule!.pattern).exec(path);
        const expected = m ? m.slice(1).join("|") : null;
        const hit = matchRedirect([{ ...rule!, target: m ? m.slice(1).map((_, i) => `$${i + 1}`).join("|") : "" }], path);
        expect(hit ? hit.target : null, `${from} against ${path}`).toBe(expected);
      }
    }
  });

  it("agrees with the exported regex on generated rules and paths", () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = (alphabet: string[], max: number) => Array.from({ length: next(max) + 1 }, () => alphabet[next(alphabet.length)]).join("");
    let compiled = 0;
    for (let i = 0; i < 400; i++) {
      const from = `/${pick(["a", "-", "/", "*", "**", ".", "a/"], 6)}`;
      const { rules } = compilePublishableRedirects([{ from, to: "/t" }]);
      const rule = rules[0];
      if (!rule) continue;
      compiled += 1;
      for (let j = 0; j < 20; j++) {
        const path = `/${pick(["a", "-", "/", ".", "b", "\\"], 10)}`;
        const m = new RegExp(rule.pattern).exec(path);
        expect(matchWildcardPath(rule.from, path), `${from} against ${path}`).toEqual(m ? m.slice(1) : null);
      }
    }
    expect(compiled).toBeGreaterThan(200);
  });

  it("rejects a rule with more wildcards than the limit and names the limit", () => {
    const from = `/${Array.from({ length: MAX_WILDCARDS + 1 }, () => "*").join("/")}`;
    expect(() => compileRedirects([{ from, to: "/x" }])).toThrow(new RegExp(`^Row 1: "From" has ${MAX_WILDCARDS + 1} wildcards, at most ${MAX_WILDCARDS} are allowed`));
    expect(() => compileRedirects([{ from: `/${Array.from({ length: MAX_WILDCARDS }, () => "*").join("/")}`, to: "/x" }])).not.toThrow();
  });

  it("rejects more rules than the limit and publishes only the first ones of a stored list", () => {
    const rows = Array.from({ length: MAX_RULES + 2 }, (_, i) => ({ from: `/old/${i}`, to: `/new/${i}` }));
    expect(compileRedirects(rows.slice(0, MAX_RULES))).toHaveLength(MAX_RULES);
    expect(() => compileRedirects(rows)).toThrow(new RegExp(`at most ${MAX_RULES} redirect rules are allowed, got ${MAX_RULES + 2}`));
    const { rules, skipped } = compilePublishableRedirects(rows);
    expect(rules).toHaveLength(MAX_RULES);
    expect(skipped).toEqual([`Row ${MAX_RULES + 1}: beyond the limit of ${MAX_RULES} rules`, `Row ${MAX_RULES + 2}: beyond the limit of ${MAX_RULES} rules`]);
  });

  it("rejects a from longer than the limit", () => {
    expect(() => compileRedirects([{ from: `/${"a".repeat(MAX_FROM_LENGTH)}`, to: "/x" }])).toThrow(new RegExp(`"From" is longer than ${MAX_FROM_LENGTH} characters`));
  });

  it("matches no rule for a path longer than the lookup limit", () => {
    const [rule] = compileRedirects([{ from: "/**", to: "/x" }]);
    expect(matchRedirect([rule!], `/${"a".repeat(MAX_LOOKUP_PATH_LENGTH - 1)}`)).toEqual({ target: "/x", status: 301 });
    expect(matchRedirect([rule!], `/${"a".repeat(MAX_LOOKUP_PATH_LENGTH)}`)).toBeNull();
  });
});

describe("reserved paths", () => {
  const reservedPaths = ["/admin", "/api"];
  const compile = (from: string) => compileRedirects([{ from, to: "/t" }], { reservedPaths });

  it("names the application paths a source may not take by default", () => {
    expect(DEFAULT_RESERVED_PATHS).toEqual(["/admin", "/api", "/media"]);
  });

  it("rejects the prefix itself and everything below it, for each prefix", () => {
    for (const prefix of reservedPaths) {
      for (const from of [prefix, `${prefix}/`, `${prefix}/x`, `${prefix}/x/y`, `${prefix}/*`, `${prefix}/**`]) {
        expect(() => compile(from), from).toThrow(new RegExp(`^Row 1: "From" .* the reserved path ${prefix}\\b`));
      }
    }
  });

  it("keeps a source that only shares the characters of a prefix", () => {
    for (const from of ["/administration", "/admin-old/x", "/apix", "/api-docs/*", "/blog/admin", "/adminx*"]) {
      expect(() => compile(from), from).not.toThrow();
    }
  });

  it("rejects a wildcard that can match a reserved path", () => {
    for (const from of ["/*", "/**", "/*/login", "/ad*/x", "/a*/*", "/**/x"]) {
      expect(() => compile(from), from).toThrow(/reserved path/);
    }
    for (const from of ["/blog/*", "/*-x", "/x/*/admin", "/a*z", "/"]) {
      expect(() => compile(from), from).not.toThrow();
    }
  });

  it("checks nothing without a list", () => {
    expect(compileRedirects([{ from: "/admin/x", to: "/t" }])).toHaveLength(1);
  });

  it("skips a stored rule under a reserved path when publishing and names its row", () => {
    const { rules, skipped } = compilePublishableRedirects([{ from: "/a", to: "/b" }, { from: "/admin/login", to: "/c" }, { from: "/api", to: "/d" }], { reservedPaths });
    expect(rules.map((rule) => rule.from)).toEqual(["/a"]);
    expect(skipped).toEqual([expect.stringMatching(/^Row 2: .*reserved path \/admin/), expect.stringMatching(/^Row 3: .*reserved path \/api/)]);
  });
});
