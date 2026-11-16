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

  it("refuses a chain that passes too many redirects when its tail was already followed from an earlier row", () => {
    const chain = Array.from({ length: MAX_REDIRECT_HOPS }, (_, i) => ({ from: `/c${i}`, to: `/c${i + 1}` }));
    const error = rejection([...chain, { from: "/start", to: "/c0" }]);
    expect(error.message).toBe(`Row ${MAX_REDIRECT_HOPS}: "To" /c${MAX_REDIRECT_HOPS} leads on through more than ${MAX_REDIRECT_HOPS} redirects without ending: /start → /c0 → /c1 → … (rows ${Array.from({ length: MAX_REDIRECT_HOPS + 1 }, (_, i) => i + 1).join(", ")})`);
  });

  it("checks a full list of wildcard rules under the root with a long chain quickly", () => {
    const chain = Array.from({ length: 18 }, (_, i) => ({ from: `/p${i}`, to: `/p${i + 1}` }));
    const rows = [...Array.from({ length: 1000 - chain.length }, (_, i) => ({ from: `/*/never-${i}-*`, to: "/p0" })), ...chain];
    const started = performance.now();
    assertNoRedirectLoop(compileRedirects(rows));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("checks a full list of wildcard rules that each move one page quickly", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ from: `/*/old-${i}`, to: `/new/page-${i}` }));
    const started = performance.now();
    assertNoRedirectLoop(compileRedirects(rows));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("checks chains that pass a new path on every hop next to wildcard rules under the root quickly", () => {
    const chain = Array.from({ length: 18 }, (_, i) => ({ from: `/l${i}/**`, to: `/l${i + 1}/$1` }));
    const starts = Array.from({ length: 491 }, (_, i) => ({ from: `/s-${i}`, to: `/l0/${i}` }));
    const others = Array.from({ length: 491 }, (_, i) => ({ from: `/*/never-${i}-*`, to: "/elsewhere" }));
    const started = performance.now();
    assertNoRedirectLoop(compileRedirects([...others, ...starts, ...chain]));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses a list whose loop check would take more than the step limit, and does so quickly", () => {
    const long = "a".repeat(2000);
    const nearMisses = Array.from({ length: 491 }, () => ({ from: "/*/Y*z-*", to: "/elsewhere" }));
    const starts = Array.from({ length: 491 }, (_, i) => ({ from: `/s-${i}`, to: `/l0/Yz-${long}${i}` }));
    const chain = Array.from({ length: 18 }, (_, i) => ({ from: `/l${i}/*`, to: `/l${i + 1}/$1` }));
    const started = performance.now();
    const error = rejection([...nearMisses, ...starts, ...chain]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(error.toDetails()).toEqual({ reason: "too-complex" });
    expect(error.message).toBe("Redirect rules are too complex to check for redirect loops: use fewer wildcard rules that can match the same paths, or shorter targets");
  });
});
