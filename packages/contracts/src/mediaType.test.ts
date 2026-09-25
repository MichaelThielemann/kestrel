import { describe, it, expect } from "vitest";
import { EXTENSION_BY_TYPE, NEUTRAL_EXTENSION, NEUTRAL_TYPE, canonicalMediaType, mediaTypeEssence, parseMediaType, publicFormOf } from "./mediaType.ts";

const neutral = { contentType: NEUTRAL_TYPE, extension: NEUTRAL_EXTENSION };

describe("mediaTypeEssence", () => {
  it("answers the lower-cased type/subtype of exactly one media type, with or without parameters", () => {
    expect(mediaTypeEssence("image/png")).toBe("image/png");
    expect(mediaTypeEssence("IMAGE/PNG")).toBe("image/png");
    expect(mediaTypeEssence("Image/Svg+Xml; Charset=UTF-8")).toBe("image/svg+xml");
    expect(mediaTypeEssence(" text/plain ;charset=utf-8; format=\"a;b\" ")).toBe("text/plain");
    expect(mediaTypeEssence("text/plain;")).toBe("text/plain");
  });

  it("refuses a list of types, which a browser reads as its last entry", () => {
    expect(mediaTypeEssence("image/png; x=1, text/html")).toBeNull();
    expect(mediaTypeEssence("image/x-foo, text/html")).toBeNull();
    expect(mediaTypeEssence("image/png, image/png")).toBeNull();
    expect(mediaTypeEssence('image/png; x="a,b"')).toBeNull();
  });

  it("refuses an empty type and anything that is not type/subtype of token characters", () => {
    for (const declared of ["", " ", "image", "image/", "/png", "image/png/x", "image /png", "image/png x", "image/png; x", "image/png; x=", "image/png; x=\"open", "image/png\r\n", "image/pn\u0000g", "image/pngé"]) {
      expect(mediaTypeEssence(declared)).toBeNull();
    }
  });

  it("stays linear on a long run of separators", () => {
    const started = performance.now();
    expect(mediaTypeEssence(`a/b${" ;".repeat(20000)}!`)).toBeNull();
    expect(mediaTypeEssence(`a/b${"; x=y".repeat(20000)} z`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("canonicalMediaType", () => {
  it("keeps a text type's first charset when it is a token, lower-cased, and no other parameter", () => {
    expect(canonicalMediaType("Text/Plain; Charset=UTF-8; format=flowed")).toBe("text/plain; charset=utf-8");
    expect(canonicalMediaType("text/csv; header=present; charset=ISO-8859-1; charset=utf-8")).toBe("text/csv; charset=iso-8859-1");
    expect(canonicalMediaType("text/plain")).toBe("text/plain");
  });

  it("drops a quoted charset, and the charset of a type that is not text", () => {
    expect(canonicalMediaType('text/plain; charset="utf-8"')).toBe("text/plain");
    expect(canonicalMediaType('text/plain; charset="utf-8"; charset=latin1')).toBe("text/plain");
    expect(canonicalMediaType("image/svg+xml; charset=utf-8")).toBe("image/svg+xml");
    expect(canonicalMediaType("application/json; charset=utf-8")).toBe("application/json");
  });

  it("refuses what parseMediaType refuses", () => {
    expect(canonicalMediaType("text/plain; charset=utf-8, text/html")).toBeNull();
    expect(canonicalMediaType("")).toBeNull();
    expect(parseMediaType("text/plain; charset=utf-8, text/html")).toBeNull();
    expect(parseMediaType("TEXT/PLAIN; CHARSET=UTF-8")).toEqual({ essence: "text/plain", charset: "utf-8" });
  });
});

describe("publicFormOf", () => {
  it("publishes a listed type in its canonical form with its extension", () => {
    expect(publicFormOf("image/jpeg")).toEqual({ contentType: "image/jpeg", extension: "jpg" });
    expect(publicFormOf("IMAGE/PNG; x=1")).toEqual({ contentType: "image/png", extension: "png" });
    expect(publicFormOf("text/plain; Charset=UTF-8; format=flowed")).toEqual({ contentType: "text/plain; charset=utf-8", extension: "txt" });
    expect(publicFormOf("text/html; charset=utf-8")).toEqual(neutral);
  });

  it("publishes an unlisted type, a list of types and an empty type as a neutral download", () => {
    for (const contentType of ["text/html", "application/xhtml+xml", "text/javascript", "application/xml", "image/x-foo", "image/png; x=1, text/html", "image/x-foo, text/html", ""]) {
      expect(publicFormOf(contentType)).toEqual(neutral);
    }
  });

  it("publishes an SVG as one only when its bytes passed sanitize.svg", () => {
    expect(publicFormOf("image/svg+xml")).toEqual(neutral);
    expect(publicFormOf("image/svg+xml", false)).toEqual(neutral);
    expect(publicFormOf("IMAGE/SVG+XML; charset=utf-8", true)).toEqual({ contentType: "image/svg+xml", extension: "svg" });
    expect(publicFormOf("image/png", true)).toEqual({ contentType: "image/png", extension: "png" });
  });

  it("keeps a real extension for common document and archive types", () => {
    const expected: Record<string, string> = {
      "application/pdf": "pdf",
      "text/csv": "csv",
      "text/plain": "txt",
      "application/zip": "zip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
      "application/vnd.oasis.opendocument.text": "odt",
      "application/vnd.oasis.opendocument.spreadsheet": "ods",
      "application/vnd.oasis.opendocument.presentation": "odp",
    };
    for (const [contentType, extension] of Object.entries(expected)) expect(publicFormOf(contentType)).toEqual({ contentType, extension });
  });

  it("lists no type a browser runs as a document from a static host, apart from the gated SVG", () => {
    const active = /(^text\/html$|^application\/xhtml\+xml$|\/xml$|\+xml$|javascript|ecmascript|^text\/xsl$)/;
    const activeExtensions = new Set(["html", "htm", "xhtml", "xht", "xml", "xsl", "svg", "svgz", "js", "mjs", "cjs"]);
    for (const [contentType, extension] of Object.entries(EXTENSION_BY_TYPE)) {
      if (contentType === "image/svg+xml") continue;
      expect(contentType).not.toMatch(active);
      expect(activeExtensions.has(extension)).toBe(false);
      expect(mediaTypeEssence(contentType)).toBe(contentType);
    }
  });
});
