import { describe, it, expect } from "vitest";
import { EXTENSION_BY_TYPE, NEUTRAL_EXTENSION, NEUTRAL_TYPE, canonicalMediaType, contentMatchesMediaType, mediaTypeAllowed, mediaTypeEssence, mediaTypeMatches, parseMediaType, publicFormOf, sniffMediaType, verifiedMediaType } from "./mediaType.ts";

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

describe("mediaTypeMatches", () => {
  const table: Array<[string, string, boolean]> = [
    ["*", "image/png", true],
    ["*", "application/x-unknown", true],
    [" * ", "text/html", true],
    ["*/*", "image/png", true],
    ["*/*", "application/pdf; version=1.7", true],
    ["*/*; q=1", "text/plain", true],
    ["image/*", "image/png", true],
    ["IMAGE/*", "image/svg+xml", true],
    ["image/*", "IMAGE/PNG; x=1", true],
    ["image/*", "application/pdf", false],
    ["image/*", "imagex/png", false],
    ["image/png", "image/png", true],
    ["IMAGE/PNG; x=1", "image/png", true],
    ["image/png", "Image/Png; Charset=utf-8", true],
    ["image/svg+xml; charset=utf-8", "IMAGE/SVG+XML", true],
    ["image/png", "image/jpeg", false],
    ["*/png", "image/png", false],
    ["image", "image/png", false],
    ["", "image/png", false],
    ["image/png, text/html", "image/png", false],
    ["image/*, text/*", "text/html", false],
    ["image/p ng", "image/png", false],
    ["**", "image/png", false],
    ["*", "", false],
    ["*/*", "image/png, text/html", false],
    ["image/*", "not a type", false],
    ["image/*+xml", "image/svg+xml", true],
    ["image/*+xml", "Image/Foo+XML; charset=utf-8", true],
    ["IMAGE/*+XML; x=1", "image/svg+xml", true],
    ["image/*+xml", "image/+xml", false],
    ["image/*+xml", "image/svg+xmlx", false],
    ["image/*+xml", "image/png", false],
    ["image/*+xml", "application/xhtml+xml", false],
    ["image/*+xml", "image/*+xml", true],
    ["*/*+xml", "application/xhtml+xml", true],
    ["*/*+xml", "image/svg+xml", true],
    ["*/*+xml", "text/html", false],
    ["*/*+json", "application/ld+json", true],
    ["*/*+json", "application/json", false],
    ["image/*+", "image/a+", false],
    ["image/*+xml, text/*", "image/svg+xml", false],
  ];
  for (const [pattern, mediaType, matches] of table) {
    it(`${JSON.stringify(pattern)} ${matches ? "matches" : "does not match"} ${JSON.stringify(mediaType)}`, () => {
      expect(mediaTypeMatches(pattern, mediaType)).toBe(matches);
    });
  }
});

describe("mediaTypeAllowed", () => {
  it("needs an allowed pattern and no denied one", () => {
    expect(mediaTypeAllowed(["image/*"], ["image/svg+xml"], "image/png")).toBe(true);
    expect(mediaTypeAllowed(["image/*"], ["image/svg+xml"], "image/svg+xml; charset=utf-8")).toBe(false);
    expect(mediaTypeAllowed(["*/*"], [], "text/html")).toBe(true);
    expect(mediaTypeAllowed(["*"], ["*/*"], "image/png")).toBe(false);
    expect(mediaTypeAllowed([], [], "image/png")).toBe(false);
    expect(mediaTypeAllowed(["*"], [], "image/png, text/html")).toBe(false);
  });

  it("leaves out every XML image type through one suffix pattern", () => {
    const denied = ["image/gif", "image/*+xml"];
    expect(mediaTypeAllowed(["image/*"], denied, "image/png")).toBe(true);
    expect(mediaTypeAllowed(["image/*"], denied, "image/svg+xml")).toBe(false);
    expect(mediaTypeAllowed(["image/*"], denied, "image/foo+xml; charset=utf-8")).toBe(false);
    expect(mediaTypeAllowed(["image/*"], denied, "IMAGE/GIF")).toBe(false);
    expect(mediaTypeAllowed(["image/*"], denied, "application/xhtml+xml")).toBe(false);
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

const bytes = (...parts: Array<string | number[]>): Uint8Array => Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("sniffMediaType", () => {
  it("recognises image and document signatures", () => {
    expect(sniffMediaType(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe("image/png");
    expect(sniffMediaType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMediaType(bytes("GIF89a", [1, 0]))).toBe("image/gif");
    expect(sniffMediaType(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toBe("image/webp");
    expect(sniffMediaType(bytes([0, 0, 0, 0x1c], "ftypavif", [0, 0, 0, 0], "mif1"))).toBe("image/avif");
    expect(sniffMediaType(bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0]))).toBe("image/heic");
    expect(sniffMediaType(bytes("II*", [0]))).toBe("image/tiff");
    expect(sniffMediaType(bytes("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMediaType(bytes([0, 0, 0, 0x18], "ftypisom", [0, 0, 0, 0]))).toBeNull();
    expect(sniffMediaType(bytes("plain text"))).toBeNull();
    expect(sniffMediaType(new Uint8Array())).toBeNull();
  });

  it("recognises markup, and svg among it wherever the root element starts", () => {
    expect(sniffMediaType(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
    expect(sniffMediaType(bytes([0xef, 0xbb, 0xbf], '\n  <?xml version="1.0"?>\n<!-- drawn by hand -->\n<!DOCTYPE svg>\n<svg width="1"/>'))).toBe("image/svg+xml");
    expect(sniffMediaType(bytes('<?xml version="1.0"?><feed/>'))).toBe("application/xml");
    expect(sniffMediaType(bytes("<!doctype html><p>hi"))).toBe("text/html");
  });
});

describe("verifiedMediaType", () => {
  const svg = bytes("<svg/>");
  const png = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a]);
  it("takes the recognised type of an image or pdf whose content is another type", () => {
    expect(verifiedMediaType("image/png", svg)).toBe("image/svg+xml");
    expect(verifiedMediaType("image/jpeg", png)).toBe("image/png");
    expect(verifiedMediaType("application/pdf", svg)).toBe("image/svg+xml");
  });
  it("keeps the declared type when the content matches it, is not recognised, or the type is not checked", () => {
    expect(verifiedMediaType("image/png; foo=bar", png)).toBe("image/png; foo=bar");
    expect(verifiedMediaType("image/png", bytes([1, 2, 3]))).toBe("image/png");
    expect(verifiedMediaType("image/x-icon", bytes([0, 0, 1, 0]))).toBe("image/x-icon");
    expect(verifiedMediaType("image/vnd.microsoft.icon", bytes([0, 0, 1, 0]))).toBe("image/vnd.microsoft.icon");
    expect(verifiedMediaType("text/plain", svg)).toBe("text/plain");
  });
});

describe("ISO image brands", () => {
  const mif1Avif = bytes([0, 0, 0, 0x1c], "ftypmif1", [0, 0, 0, 0], "mif1avifmiaf");
  const mif1Heic = bytes([0, 0, 0, 0x1c], "ftypmif1", [0, 0, 0, 0], "mif1heicmiaf");
  it("recognises AVIF whose major brand is mif1", () => {
    expect(sniffMediaType(mif1Avif)).toBe("image/avif");
    expect(verifiedMediaType("image/avif", mif1Avif)).toBe("image/avif");
    expect(contentMatchesMediaType(mif1Avif, "image/avif")).toBe(true);
  });
  it("keeps a declared type that any of the brands names", () => {
    expect(verifiedMediaType("image/heic", mif1Heic)).toBe("image/heic");
    expect(verifiedMediaType("image/heif", mif1Heic)).toBe("image/heif");
    expect(contentMatchesMediaType(mif1Heic, "image/heic")).toBe(true);
    expect(verifiedMediaType("image/png", mif1Avif)).toBe("image/avif");
  });
});

describe("contentMatchesMediaType", () => {
  it("is true only when the content is recognised as the declared type", () => {
    expect(contentMatchesMediaType(bytes([0xff, 0xd8, 0xff, 0xdb]), "image/jpeg")).toBe(true);
    expect(contentMatchesMediaType(bytes("<svg/>"), "image/png")).toBe(false);
    expect(contentMatchesMediaType(bytes([1, 2, 3]), "image/png")).toBe(false);
    expect(contentMatchesMediaType(bytes([0, 0, 0, 0x1c], "ftypmif1", [0, 0, 0, 0], "heic"), "image/heif")).toBe(true);
  });
});
