import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { matchWildcardPath } from "../../packages/redirects-default/match.ts";
import { compileRedirects } from "../../packages/redirects-default/rules.ts";

type Matcher = (rule: unknown, path: string) => unknown;

function handlerFunctions(): { matchFrom: (from: string, path: string) => unknown; matchRule: Matcher } {
  const source = readFileSync(new URL("./redirects.js", import.meta.url), "utf8").replace(/^export default .*$/m, "");
  const scope: Record<string, unknown> = {};
  runInNewContext(`${source}\nexported.matchFrom = matchFrom;\nexported.matchRule = matchRule;`, { exported: scope });
  const { matchFrom, matchRule } = scope;
  if (typeof matchFrom !== "function" || typeof matchRule !== "function") throw new Error("redirects.js does not define matchFrom and matchRule");
  return { matchFrom: (from, path) => plain(matchFrom(from, path)), matchRule: (rule, path) => plain(matchRule(rule, path)) };
}

function plain(value: unknown): unknown {
  return Array.isArray(value) ? Array.from(value, String) : value;
}

describe("the njs redirect handler", () => {
  const { matchFrom, matchRule } = handlerFunctions();

  it("captures what the lookup captures on generated rules and paths", () => {
    let seed = 11;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = (alphabet: string[], max: number) => Array.from({ length: next(max) + 1 }, () => alphabet[next(alphabet.length)]).join("");
    let compared = 0;
    for (let i = 0; i < 400; i++) {
      const from = `/${pick(["a", "-", "/", "*", "**", ".", "a/"], 6)}`.replace(/\*\*\/?\*\*/g, "*");
      for (let j = 0; j < 20; j++) {
        const path = `/${pick(["a", "-", "/", ".", "\\", "ä"], 10)}`;
        expect(matchFrom(from, path), `${from} against ${path}`).toEqual(matchWildcardPath(from, path));
        compared += 1;
      }
    }
    expect(compared).toBe(8000);
  });

  it("matches a rule by its from, and by its pattern when from is missing", () => {
    const [rule] = compileRedirects([{ from: "/blog/*", to: "/artikel/$1" }]);
    expect(matchRule(rule, "/blog/x")).toEqual(["x"]);
    expect(matchRule({ pattern: rule!.pattern, target: rule!.target, status: rule!.status }, "/blog/x")).toEqual(["x"]);
    expect(matchRule({ target: "/x", status: 301 }, "/blog/x")).toBeNull();
  });
});
