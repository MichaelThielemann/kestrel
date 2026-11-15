import { describe, expect, it } from "vitest";
import { compileRedirects, assertNoRedirectLoop, MAX_REDIRECT_HOPS, RedirectRuleError } from "./rules.ts";

function rejection(rows: unknown): RedirectRuleError {
  try {
    assertNoRedirectLoop(compileRedirects(rows));
  } catch (error) {
    if (error instanceof RedirectRuleError) return error;
    throw error;
  }
  throw new Error("expected a RedirectRuleError");
}

describe("redirect loops in the editor rules", () => {
  it("refuses a rule that points at its own source", () => {
    const error = rejection([{ from: "/self", to: "/self" }]);
    expect(error.message).toBe('Row 1: "To" /self leads back to /self, a redirect loop: /self → /self (row 1)');
    expect(error.toDetails()).toEqual({ row: 1, field: "to", reason: "redirect-loop", path: "/self" });
  });

  it("refuses a target that only adds a trailing slash, a query or a fragment to the source", () => {
    expect(rejection([{ from: "/r10", to: "/r10/" }]).toDetails()).toEqual({ row: 1, field: "to", reason: "redirect-loop", path: "/r10/" });
    expect(rejection([{ from: "/r10/", to: "/r10?ref=old" }]).reason).toBe("redirect-loop");
    expect(rejection([{ from: "/r10", to: "/r10#top" }]).reason).toBe("redirect-loop");
  });

  it("refuses a wildcard rule whose target its own source matches again", () => {
    const error = rejection([{ from: "/blog/**", to: "/blog/$1" }]);
    expect(error.message).toMatch(/^Row 1: "To" \/blog\/\$1 leads back to \/blog\/.+, a redirect loop/);
    expect(error.reason).toBe("redirect-loop");
  });

  it("refuses two rules that point at each other and names both rows and the loop", () => {
    const error = rejection([{ from: "/a", to: "/b" }, { from: "/c", to: "/d" }, { from: "/b", to: "/a" }]);
    expect(error.message).toBe('Row 3: "To" /a leads back to /a, a redirect loop: /a → /b → /a (rows 1, 3)');
    expect(error.toDetails()).toEqual({ row: 3, field: "to", reason: "redirect-loop", path: "/a" });
  });

  it("refuses a longer cycle through wildcard captures", () => {
    const error = rejection([{ from: "/x/*", to: "/y/$1" }, { from: "/y/*", to: "/z/$1" }, { from: "/z/*", to: "/x/$1" }]);
    expect(error.row).toBe(3);
    expect(error.message).toMatch(/rows 1, 2, 3\)$/);
  });

  it("refuses a chain that grows on every hop and would never end", () => {
    const error = rejection([{ from: "/news/**", to: "/news/archive/$1" }]);
    expect(error.reason).toBe("redirect-loop");
    expect(error.message).toContain(`more than ${MAX_REDIRECT_HOPS} redirects`);
  });

  it("accepts chains that end, rules that move a tree elsewhere and external targets", () => {
    const lists: unknown[] = [
      [{ from: "/a", to: "/b" }, { from: "/b", to: "/c" }],
      [{ from: "/blog/**", to: "/artikel/$1" }],
      [{ from: "/blog/*", to: "/blog" }],
      [{ from: "/self", to: "https://other.example/self" }],
      [{ from: "/a", to: "/b" }, { from: "/a", to: "/a" }],
      [{ from: "/old/**", to: "/new/$1" }, { from: "/new/x", to: "/old" }],
    ];
    for (const rows of lists) expect(() => assertNoRedirectLoop(compileRedirects(rows))).not.toThrow();
  });

  it("checks a full list of literal rules quickly", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ from: `/page-${i}`, to: `/page-${i + 1}/moved` }));
    const started = performance.now();
    assertNoRedirectLoop(compileRedirects(rows));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
