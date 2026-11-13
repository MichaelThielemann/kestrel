import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as impl from "./impl.ts";
import { normalizeSiteUrl, pageUrl } from "./site-url.ts";

describe("the site-url subpath", () => {
  it("imports nothing, so page code that also runs in a browser can use it", () => {
    const source = readFileSync(new URL("./site-url.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(|\bprocess\.|\bBuffer\b/);
  });

  it("is published as its own subpath and gives the same functions as ./impl", () => {
    const pkg: unknown = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    expect(pkg).toMatchObject({ exports: { "./site-url": "./site-url.ts" }, publishConfig: { exports: { "./site-url": { types: "./dist/site-url.d.ts", default: "./dist/site-url.js" } } } });
    expect(impl.normalizeSiteUrl).toBe(normalizeSiteUrl);
    expect(impl.pageUrl).toBe(pageUrl);
    expect(pageUrl(normalizeSiteUrl("https://Example.org/de/"), "/kontakt")).toBe("https://example.org/de/kontakt");
  });
});
