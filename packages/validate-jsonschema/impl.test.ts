import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { validateContractTests } from "@michaelthielemann/kestrel-contracts/validate.contract.test";
import type { Context } from "@michaelthielemann/kestrel/context";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { failure, type CoreCode, type KestrelError } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, isErr, type Err } from "@michaelthielemann/kestrel/result";
import { createValidator, measure, type Validator } from "./impl.ts";
import module from "./module.ts";
import { sanitize, sanitizeBySchema } from "./sanitize.ts";

function stubLogger(): Logger & { errors: Array<{ message: string; data?: Record<string, unknown> }> } {
  const errors: Array<{ message: string; data?: Record<string, unknown> }> = [];
  return {
    errors,
    step() {},
    info() {},
    error(message, data) {
      errors.push(data === undefined ? { message } : { message, data });
    },
  };
}

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-schema-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const contractDirs: string[] = [];
afterAll(() => {
  for (const contractDir of contractDirs) rmSync(contractDir, { recursive: true, force: true });
});

validateContractTests(async (schemas) => {
  const contractDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-schema-contract-"));
  contractDirs.push(contractDir);
  const files: Record<string, string> = {};
  for (const [target, schema] of Object.entries(schemas)) {
    const file = `${target}.json`;
    writeFileSync(join(contractDir, file), JSON.stringify(schema));
    files[target] = file;
  }
  return createValidator({ schemas: files, maxDepth: 32, maxNodes: 20_000 }, contractDir, stubLogger());
});

const blocks = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    blocks: {
      type: "array",
      items: {
        oneOf: [
          { type: "object", properties: { type: { const: "hero" }, title: { type: "string", minLength: 1 }, image: { type: "string" } }, required: ["type", "title"], additionalProperties: false },
          { type: "object", properties: { type: { const: "text" }, html: { type: "string", format: "html" } }, required: ["type", "html"], additionalProperties: false },
        ],
      },
    },
  },
  required: ["blocks"],
  additionalProperties: false,
};
writeFileSync(join(dir, "blocks.json"), JSON.stringify(blocks));
writeFileSync(join(dir, "broken.json"), "{ not json");
writeFileSync(join(dir, "invalid.json"), JSON.stringify({ type: "nonsense" }));

const config = { schemas: { "pages.body": "blocks.json" }, maxDepth: 5, maxNodes: 50 };

const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>ok';
const CLEAN = '<img src="x" />ok';

describe("sanitizeBySchema branch selection", () => {
  const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
  const html = { type: "string", format: "html" };

  it("sanitizes an optional field, whose schema is an anyOf wrapper without a discriminator", () => {
    const root = { type: "object", properties: { required: html, optional: nullable(html) } };
    expect(sanitizeBySchema(root, root, { required: EVIL, optional: EVIL })).toEqual({ required: CLEAN, optional: CLEAN });
  });

  it("reaches html inside an optional repeater", () => {
    const item = { type: "object", properties: { body: nullable(html) } };
    const root = { type: "object", properties: { rows: nullable({ type: "array", items: item }) } };
    expect(sanitizeBySchema(root, root, { rows: [{ body: EVIL }] })).toEqual({ rows: [{ body: CLEAN }] });
  });

  it("leaves a null value alone", () => {
    const root = { type: "object", properties: { optional: nullable(html) } };
    expect(sanitizeBySchema(root, root, { optional: null })).toEqual({ optional: null });
  });

  it("still selects a tagged union by properties.type.const and skips a value with no matching tag", () => {
    const root = {
      type: "object",
      properties: {
        block: {
          oneOf: [
            { type: "object", properties: { type: { const: "text" }, html } },
            { type: "object", properties: { type: { const: "hero" }, title: { type: "string" } } },
          ],
        },
      },
    };
    expect(sanitizeBySchema(root, root, { block: { type: "text", html: EVIL } })).toEqual({ block: { type: "text", html: CLEAN } });
    expect(sanitizeBySchema(root, root, { block: { type: "unknown", html: EVIL } })).toEqual({ block: { type: "unknown", html: EVIL } });
  });
});

describe("validate/jsonschema", () => {
  it("drops the failed null branch of a nullable union when a deeper problem explains the failure", async () => {
    const schema = {
      type: "object",
      properties: { rows: { anyOf: [{ type: "array", items: { type: "object", required: ["link"], properties: { link: { anyOf: [{ type: "object" }, { type: "null" }] } } } }, { type: "null" }] } },
    };
    writeFileSync(join(dir, "rows.json"), JSON.stringify(schema));
    const validator = await createValidator({ ...config, schemas: { "docs.rows": "rows.json" } }, dir, stubLogger());
    const missing = validator.check("docs.rows", { rows: [{}] });
    expect(missing.ok).toBe(false);
    expect(missing.problems).toEqual([{ path: "/rows/0", message: "must have required property 'link'" }]);
    const wrongType = validator.check("docs.rows", { rows: "nope" });
    expect(wrongType.ok).toBe(false);
    expect(wrongType.problems.map((p) => p.path)).toEqual(["/rows", "/rows"]);
  });


  it("rejects non-object values against a discriminated oneOf whose branches omit type", async () => {
    const nav = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { link: { $ref: "#/$defs/link" } },
      $defs: {
        link: {
          oneOf: [
            { properties: { type: { const: "internal" }, ref: { type: "string" } }, required: ["ref"], additionalProperties: false },
            { properties: { type: { const: "external" }, url: { type: "string" } }, required: ["url"], additionalProperties: false },
          ],
        },
      },
    };
    writeFileSync(join(dir, "nav.json"), JSON.stringify(nav));
    const v = await createValidator({ ...config, schemas: { "settings.navigation": "nav.json" } }, dir, stubLogger());
    expect(v.check("settings.navigation", { link: { type: "internal", ref: "kestrel:pages:1" } })).toEqual({ ok: true, problems: [] });
    for (const value of [null, "x", 5, true, []]) {
      expect(v.check("settings.navigation", { link: value }).ok, JSON.stringify(value)).toBe(false);
    }
    expect(v.check("settings.navigation", { link: {} }).ok).toBe(false);
  });

  it("accepts valid block trees and reports problems with paths", async () => {
    const v = await createValidator(config, dir, stubLogger());
    expect(v.targets()).toEqual(["pages.body"]);
    expect(v.check("pages.body", { blocks: [{ type: "hero", title: "Hi" }, { type: "text", html: "<p>x</p>" }] })).toEqual({ ok: true, problems: [] });
    const bad = v.check("pages.body", { blocks: [{ type: "hero" }, { type: "video" }, { type: "text", html: "x", extra: true }], extra: 1 });
    expect(bad.ok).toBe(false);
    const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
    expect([...bad.problems].sort(byPath)).toEqual(
      [
        { path: "/", message: 'unexpected property "extra"' },
        { path: "/blocks/0", message: "must have required property 'title'" },
        { path: "/blocks/1/type", message: 'unknown type "video"' },
        { path: "/blocks/2", message: 'unexpected property "extra"' },
      ].sort(byPath),
    );
    expect(() => v.check("nope.x", {})).toThrow(/no schema/);
  });

  it("limits nesting depth and node count", async () => {
    const v = await createValidator(config, dir, stubLogger());
    let deep: unknown = "x";
    for (let i = 0; i < 10; i++) deep = [deep];
    expect(v.check("pages.body", { blocks: [{ type: "text", html: "x" }], deep }).problems[0]?.message).toMatch(/nesting deeper than 5/);
    const many = { blocks: Array.from({ length: 30 }, () => ({ type: "text", html: "x" })) };
    expect(v.check("pages.body", many).problems[0]?.message).toMatch(/more than 50 nodes/);
    expect(measure({ a: [1, { b: 2 }] })).toEqual({ depth: 3, nodes: 5 });
  });

  it("rejects a payload nested far deeper than maxDepth with VALIDATION instead of overflowing the stack", async () => {
    const v = await createValidator(config, dir, stubLogger());
    let deep: unknown = "x";
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(measure(deep)).toEqual({ depth: 100_000, nodes: 100_001 });
    expect(v.check("pages.body", deep)).toEqual({ ok: false, problems: [{ path: "/", message: "nesting deeper than 5" }] });

    const ctx: Context = {
      runId: "test",
      trigger: { kind: "http", name: "t" },
      payload: { body: deep },
      params: {},
      headers: {},
      files: [],
      fail(codeOrError: CoreCode | KestrelError, message?: string, details?: Record<string, unknown>): Err<KestrelError> {
        return typeof codeOrError !== "string" ? err(codeOrError) : err(failure(codeOrError, message ?? "", details === undefined ? {} : { details }));
      },
      done() {
        throw new Error("done called");
      },
    };
    const check = module.steps!(v).check("pages.body");
    const result = await check(ctx);
    if (!isErr(result)) throw new Error("expected an Err");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toBe("pages.body: / nesting deeper than 5");
    expect(result.error.details).toEqual({
      problems: [{ path: "/", message: "nesting deeper than 5" }],
      fields: [{ field: "body", message: "nesting deeper than 5" }],
    });
  });

  it("fails loudly on unreadable or invalid schemas and bad targets", async () => {
    await expect(createValidator({ ...config, schemas: { "pages.body": "missing.json" } }, dir, stubLogger())).rejects.toThrow(/cannot read schema/);
    await expect(createValidator({ ...config, schemas: { "pages.body": "broken.json" } }, dir, stubLogger())).rejects.toThrow(/cannot read schema/);
    await expect(createValidator({ ...config, schemas: { "pages.body": "invalid.json" } }, dir, stubLogger())).rejects.toThrow(/invalid schema/);
    await expect(createValidator({ ...config, schemas: { body: "blocks.json" } }, dir, stubLogger())).rejects.toThrow(/must look like/);
  });

  it("sanitizes html only at format:html positions, keeping kestrel: links", async () => {
    const v = await createValidator(config, dir, stubLogger());
    const dirty = '<p onclick="x()">Hi <a href="kestrel:pages:abc" target="_blank">link</a><script>alert(1)</script><img src="javascript:evil()"><a href="https://ok.example">ok</a></p>';
    const out = v.sanitize("pages.body", { blocks: [{ type: "hero", title: dirty }, { type: "text", html: dirty }, { type: "video", html: dirty }] }) as { blocks: Array<Record<string, string>> };
    expect(out.blocks[0]?.title).toBe(dirty);
    expect(out.blocks[1]?.html).toBe('<p>Hi <a href="kestrel:pages:abc" target="_blank" rel="noopener noreferrer">link</a><img /><a href="https://ok.example">ok</a></p>');
    expect(out.blocks[2]?.html).toBe(dirty);
    expect(sanitize('<div data-kestrel-broken="pages:1"><a href="#" data-kestrel-broken="pages:1">x</a></div>')).toBe('<div><a href="#" data-kestrel-broken="pages:1">x</a></div>');
    expect(sanitize("<b>ok</b><iframe src=x></iframe>")).toBe("<b>ok</b>");
  });

  async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return check();
  }

  it("reloads a changed schema file when watch is enabled, keeping the old schema on a broken update", async () => {
    const watchDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-schema-watch-"));
    const schemaPath = join(watchDir, "watched.json");
    const original = { type: "object", properties: { html: { type: "string" } }, required: ["html"], additionalProperties: false };
    writeFileSync(schemaPath, JSON.stringify(original));
    const logger = stubLogger();
    let v: Awaited<ReturnType<typeof createValidator>> | undefined;
    try {
      v = await createValidator({ schemas: { "pages.body": "watched.json" }, maxDepth: 5, maxNodes: 50, watch: true }, watchDir, logger);
      expect(v.check("pages.body", { html: "x", extra: 1 })).toEqual({ ok: false, problems: [{ path: "/", message: 'unexpected property "extra"' }] });

      const updated = { type: "object", properties: { html: { type: "string" } }, required: ["html"], additionalProperties: true };
      writeFileSync(schemaPath, JSON.stringify(updated));
      expect(await waitUntil(() => v!.check("pages.body", { html: "x", extra: 1 }).ok, 2000)).toBe(true);

      writeFileSync(schemaPath, "{ not json");
      expect(await waitUntil(() => logger.errors.length > 0, 2000)).toBe(true);
      expect(v.check("pages.body", { html: "x", extra: 1 })).toEqual({ ok: true, problems: [] });
      expect(logger.errors[0]?.message).toMatch(/^validate\/jsonschema:/);
    } finally {
      v?.close();
      rmSync(watchDir, { recursive: true, force: true });
    }
  });

  it("picks up an atomic rename-over-file write, twice in a row", async () => {
    const watchDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-schema-rename-"));
    const schemaPath = join(watchDir, "watched.json");
    writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: { html: { type: "string" } }, required: ["html"], additionalProperties: false }));
    let v: Awaited<ReturnType<typeof createValidator>> | undefined;
    try {
      v = await createValidator({ schemas: { "pages.body": "watched.json" }, maxDepth: 5, maxNodes: 50, watch: true }, watchDir, stubLogger());
      expect(v.check("pages.body", { html: "x", extra: 1 }).ok).toBe(false);

      const tmpPath = join(watchDir, "watched.json.tmp");
      writeFileSync(tmpPath, JSON.stringify({ type: "object", properties: { html: { type: "string" } }, required: ["html"], additionalProperties: true }));
      renameSync(tmpPath, schemaPath);
      expect(await waitUntil(() => v!.check("pages.body", { html: "x", extra: 1 }).ok, 2000)).toBe(true);

      writeFileSync(tmpPath, JSON.stringify({ type: "object", properties: { html: { type: "string" } }, required: ["html"], additionalProperties: false }));
      renameSync(tmpPath, schemaPath);
      expect(await waitUntil(() => !v!.check("pages.body", { html: "x", extra: 1 }).ok, 2000)).toBe(true);
    } finally {
      v?.close();
      rmSync(watchDir, { recursive: true, force: true });
    }
  });

  it("two boots keep their own schemas; the first instance's step factories still resolve against it", async () => {
    const deps: Deps = { get: () => { throw new Error("not needed"); }, find: () => undefined, logger: stubLogger(), root: dir };
    const schemaPath = "blocks.json";
    const first = (await module.setup(module.configSchema.parse({ schemas: { "pages.a": schemaPath } }), deps)) as Validator;
    const second = (await module.setup(module.configSchema.parse({ schemas: { "pages.b": schemaPath } }), deps)) as Validator;
    try {
      const check = module.steps!(first).check as (arg: string) => unknown;
      expect(() => check("pages.a")).not.toThrow();
      expect(() => check("pages.b")).toThrow(/no schema/);
    } finally {
      first.close();
      second.close();
    }
  });
});
