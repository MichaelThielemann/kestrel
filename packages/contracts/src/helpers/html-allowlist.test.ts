import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HTML_ALLOWED_ATTRIBUTES, HTML_ALLOWED_SCHEMES, HTML_ALLOWED_TAGS, HTML_ID_PATTERN, HTML_IMG_SCHEMES, isAllowedHtmlUrl, normalizeHtmlAttributes } from "./html-allowlist.ts";

describe("html allowlist data", () => {
  it("names the tags, the attributes per tag and the schemes", () => {
    expect(HTML_ALLOWED_TAGS).toContain("a");
    expect(HTML_ALLOWED_TAGS).not.toContain("script");
    expect(HTML_ALLOWED_ATTRIBUTES.a).toEqual(["href", "title", "target", "rel", "data-kestrel-broken"]);
    expect(HTML_ALLOWED_ATTRIBUTES["*"]).toEqual(["id", "class", "lang", "dir"]);
    expect(HTML_ALLOWED_SCHEMES).toEqual(["http", "https", "mailto", "tel", "kestrel"]);
    expect(HTML_IMG_SCHEMES).toEqual(["http", "https", "data"]);
  });

  it("accepts ids of an ASCII letter followed by up to 63 letters, digits, - or _", () => {
    expect(HTML_ID_PATTERN.test("intro_1-b")).toBe(true);
    expect(HTML_ID_PATTERN.test("a".repeat(64))).toBe(true);
    for (const id of ["", "1a", "__x", "-a", "a".repeat(65), "a b", "ä"]) expect(HTML_ID_PATTERN.test(id), id).toBe(false);
  });

  it("has no imports, so a browser bundle can use it", () => {
    const source = readFileSync(new URL("./html-allowlist.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bnode:/);
    expect(source).not.toMatch(/\brequire\(/);
  });
});

describe("isAllowedHtmlUrl", () => {
  it("allows http, https, mailto, tel and kestrel links and relative references", () => {
    for (const value of ["https://example.com/a?b#c", "HTTP://example.com", "mailto:a@b.example", "tel:+491234", "kestrel:pages:abc", "/path", "page.html", "../up", "#frag", "?q=1", "", "a/b:c"]) {
      expect(isAllowedHtmlUrl("a", "href", value), value).toBe(true);
    }
  });

  it("refuses data:, javascript:, vbscript: and unknown schemes in a link, however they are spelled", () => {
    for (const value of ["data:text/html,<b>x</b>", "DATA:text/html;base64,AAAA", "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "\u0001javascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "java\rscript:alert(1)", "vbscript:x", "file:///etc/passwd", "blob:https://example.com/x", "x-custom:y"]) {
      expect(isAllowedHtmlUrl("a", "href", value), JSON.stringify(value)).toBe(false);
    }
  });

  it("refuses a protocol-relative reference, with slashes, backslashes or removed control characters", () => {
    for (const value of ["//evil.example/x", "///evil.example", "\\\\evil.example", "/\\evil.example", "\\/evil.example", " //evil.example", "/\t/evil.example", "/\n/evil.example", "//"]) {
      expect(isAllowedHtmlUrl("a", "href", value), JSON.stringify(value)).toBe(false);
      expect(isAllowedHtmlUrl("img", "src", value), JSON.stringify(value)).toBe(false);
    }
  });

  it("allows data: only in img src", () => {
    expect(isAllowedHtmlUrl("img", "src", "data:image/png;base64,AAAA")).toBe(true);
    expect(isAllowedHtmlUrl("img", "src", "https://example.com/a.png")).toBe(true);
    expect(isAllowedHtmlUrl("img", "src", "mailto:a@b.example")).toBe(false);
    expect(isAllowedHtmlUrl("img", "src", "kestrel:media:abc")).toBe(false);
    expect(isAllowedHtmlUrl("a", "href", "data:image/png;base64,AAAA")).toBe(false);
    expect(isAllowedHtmlUrl("img", "href", "data:image/png;base64,AAAA")).toBe(false);
  });
});

describe("normalizeHtmlAttributes", () => {
  it("forces rel to noopener noreferrer for every target but _self, whatever the case", () => {
    for (const target of ["_blank", "_BLANK", "_Blank", "win1", "_parent", "_top", " _self", "_self "]) {
      expect(normalizeHtmlAttributes("a", { href: "https://example.com", target, rel: "opener" }), target).toEqual({ href: "https://example.com", target, rel: "noopener noreferrer" });
      expect(normalizeHtmlAttributes("a", { target })["rel"], target).toBe("noopener noreferrer");
    }
  });

  it("leaves a link without target, with an empty target or with _self (any case) alone", () => {
    for (const attribs of [{ href: "/a" }, { href: "/a", rel: "opener" }, { href: "/a", target: "" }, { href: "/a", target: "_self", rel: "nofollow" }, { href: "/a", target: "_SELF" }]) {
      expect(normalizeHtmlAttributes("a", attribs)).toEqual(attribs);
    }
  });

  it("drops opener from rel and keeps the other tokens", () => {
    expect(normalizeHtmlAttributes("a", { target: "_blank", rel: "Opener nofollow  NOOPENER ugc" })["rel"]).toBe("noopener noreferrer nofollow ugc");
    expect(normalizeHtmlAttributes("a", { target: "_blank", rel: "noreferrer" })["rel"]).toBe("noopener noreferrer");
  });

  it("keeps the order of the attributes and adds rel last", () => {
    expect(Object.keys(normalizeHtmlAttributes("a", { target: "_blank", href: "/a", title: "t" }))).toEqual(["target", "href", "title", "rel"]);
  });

  it("drops an href or src that isAllowedHtmlUrl refuses and keeps the element's other attributes", () => {
    expect(normalizeHtmlAttributes("a", { href: "data:text/html,x", title: "t" })).toEqual({ title: "t" });
    expect(normalizeHtmlAttributes("a", { href: "//evil.example", target: "_blank" })).toEqual({ target: "_blank", rel: "noopener noreferrer" });
    expect(normalizeHtmlAttributes("img", { src: "data:image/gif;base64,R0lG", alt: "x" })).toEqual({ src: "data:image/gif;base64,R0lG", alt: "x" });
    expect(normalizeHtmlAttributes("img", { src: "javascript:x()", alt: "x" })).toEqual({ alt: "x" });
  });

  it("drops an id that does not match the id pattern", () => {
    expect(normalizeHtmlAttributes("p", { id: "__x", class: "c" })).toEqual({ class: "c" });
    expect(normalizeHtmlAttributes("p", { id: "ok-1", class: "c" })).toEqual({ id: "ok-1", class: "c" });
  });

  it("matches attribute and tag names without regard to case and does not touch other tags' target", () => {
    expect(normalizeHtmlAttributes("A", { HREF: "javascript:x()", TARGET: "_blank" })).toEqual({ TARGET: "_blank", rel: "noopener noreferrer" });
    expect(normalizeHtmlAttributes("div", { target: "_blank" })).toEqual({ target: "_blank" });
  });

  it("handles an attribute named like an Object.prototype member", () => {
    const attribs = Object.fromEntries([["__proto__", "x"], ["constructor", "y"], ["target", "_blank"]]);
    const out = normalizeHtmlAttributes("a", attribs);
    expect(Object.keys(out)).toEqual(["__proto__", "constructor", "target", "rel"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});
