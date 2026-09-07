import { describe, it, expect } from "vitest";
import type { Context } from "@michaelthielemann/kestrel/context";
import { failure, type CoreCode, type KestrelError } from "@michaelthielemann/kestrel/errors";
import { err, isErr, type Err } from "@michaelthielemann/kestrel/result";
import module from "./module.ts";
import { isSvg, sanitizeSvg } from "./impl.ts";

describe("sanitizeSvg", () => {
  it("strips scripts, event handlers, style and disallowed elements", () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10" onload="alert(2)" style="fill:red"/><foreignObject><div>x</div></foreignObject><image href="https://evil.example/a.png"/></svg>';
    const out = sanitizeSvg(dirty);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onload");
    expect(out).not.toContain("style=");
    expect(out).not.toContain("foreignObject");
    expect(out).not.toContain("<image");
  });

  it("strips external href and javascript: href but keeps internal references", () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g1"><stop offset="0" stop-color="red"/></linearGradient></defs><use xlink:href="https://evil.example/x.svg#y"/><use href="javascript:alert(1)"/><use href="#g1"/></svg>';
    const out = sanitizeSvg(dirty);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="#g1"');
  });

  it("keeps viewBox and camelCase gradient/clipPath tags", () => {
    const svg = '<svg viewBox="0 0 10 10"><clipPath id="c1"><rect width="5" height="5"/></clipPath><linearGradient id="g1"><stop offset="0" stop-color="blue"/></linearGradient></svg>';
    const out = sanitizeSvg(svg);
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain("<clipPath");
    expect(out).toContain("<linearGradient");
  });

  it("strips XML prolog, doctype and comments", () => {
    const svg = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">\n<!-- comment --><svg><rect width="1" height="1"/></svg>';
    const out = sanitizeSvg(svg);
    expect(out.startsWith("<svg")).toBe(true);
  });

  it("throws when no svg root element remains", () => {
    expect(() => sanitizeSvg("<div>not svg</div>")).toThrow(/no svg root element/);
    expect(() => sanitizeSvg("<script>alert(1)</script>")).toThrow(/no svg root element/);
  });

  it("isSvg matches image/svg+xml with optional parameters", () => {
    expect(isSvg("image/svg+xml")).toBe(true);
    expect(isSvg("image/svg+xml; charset=utf-8")).toBe(true);
    expect(isSvg("IMAGE/SVG+XML")).toBe(true);
    expect(isSvg("image/png")).toBe(false);
  });
});

function fakeCtx(files: Context["files"]): Context {
  return {
    runId: "test",
    trigger: { kind: "http", name: "t" },
    payload: {},
    params: {},
    headers: {},
    files,
    fail(codeOrError: CoreCode | KestrelError, message?: string, details?: Record<string, unknown>): Err<KestrelError> {
      return typeof codeOrError !== "string" ? err(codeOrError) : err(failure(codeOrError, message ?? "", details === undefined ? {} : { details }));
    },
    done(): never {
      throw new Error("done called");
    },
  };
}

describe("sanitize/svg step", () => {
  it("sanitizes svg files and leaves other files untouched", async () => {
    const step = module.steps!({ maxBytes: 2 * 1024 * 1024 });
    const svg = new TextEncoder().encode('<svg><script>alert(1)</script><rect width="1" height="1"/></svg>');
    const png = new TextEncoder().encode("not really a png");
    const ctx = fakeCtx([
      { field: "file", filename: "a.svg", contentType: "image/svg+xml", data: svg },
      { field: "file", filename: "b.png", contentType: "image/png", data: png },
    ]);
    const result = await step.svg(ctx);
    if (isErr(result)) throw new Error(`expected Ok, got ${result.error.code}`);
    const svgFile = result.value.files[0]!;
    const pngFile = result.value.files[1]!;
    expect(new TextDecoder().decode(svgFile.data)).not.toContain("<script");
    expect(svgFile.contentType).toBe("image/svg+xml");
    expect(pngFile.data).toBe(png);
  });

  it("sanitizes every svg file when multiple are uploaded", async () => {
    const step = module.steps!({ maxBytes: 2 * 1024 * 1024 });
    const svgA = new TextEncoder().encode('<svg><script>alert(1)</script></svg>');
    const svgB = new TextEncoder().encode('<svg><script>alert(2)</script></svg>');
    const ctx = fakeCtx([
      { field: "file", filename: "a.svg", contentType: "image/svg+xml", data: svgA },
      { field: "file", filename: "b.svg", contentType: "image/svg+xml", data: svgB },
    ]);
    const result = await step.svg(ctx);
    if (isErr(result)) throw new Error(`expected Ok, got ${result.error.code}`);
    expect(new TextDecoder().decode(result.value.files[0]!.data)).not.toContain("<script");
    expect(new TextDecoder().decode(result.value.files[1]!.data)).not.toContain("<script");
  });

  it("rejects oversize svg files with PAYLOAD_TOO_LARGE", async () => {
    const step = module.steps!({ maxBytes: 4 });
    const svg = new TextEncoder().encode('<svg><rect width="1" height="1"/></svg>');
    const ctx = fakeCtx([{ field: "file", filename: "a.svg", contentType: "image/svg+xml", data: svg }]);
    const result = await step.svg(ctx);
    if (!isErr(result)) throw new Error("expected an Err");
    expect(result.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(result.error.status).toBe(413);
    expect(result.error.message).toMatch(/exceeds/);
  });

  it("rejects invalid svg with VALIDATION", async () => {
    const step = module.steps!({ maxBytes: 2 * 1024 * 1024 });
    const notSvg = new TextEncoder().encode("<div>not svg</div>");
    const ctx = fakeCtx([{ field: "file", filename: "a.svg", contentType: "image/svg+xml", data: notSvg }]);
    const result = await step.svg(ctx);
    if (!isErr(result)) throw new Error("expected an Err");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.status).toBe(400);
    expect(result.error.message).toMatch(/invalid svg/);
  });
});
