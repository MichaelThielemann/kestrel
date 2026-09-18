import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context, Step } from "@michaelthielemann/kestrel/context";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import module, { configSchema } from "./module.ts";
import type { Validator } from "./impl.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-validate-jsonschema-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, "blocks.json"), JSON.stringify({ type: "object", additionalProperties: false, properties: { title: { type: "string" } } }));

describe("validate/jsonschema module", () => {
  it("resolves relative schema paths against deps.root, not process.cwd()", async () => {
    const config = configSchema.parse({ schemas: { "pages.title": "blocks.json" } });
    const instance = boundaryCast<Validator>(await module.setup(config, {
      get: () => {
        throw new Error("no contract expected");
      },
      find: () => undefined,
      logger: silentLogger,
      root: dir,
    }), "host");
    expect(instance.targets()).toEqual(["pages.title"]);
    expect(dir).not.toBe(process.cwd());
    instance.close();
  });

  it("accepts an inline schema object next to a path", () => {
    const config = configSchema.parse({ schemas: { "pages.title": "blocks.json", "settings.navigation": { type: "array" } } });
    expect(config.schemas).toEqual({ "pages.title": "blocks.json", "settings.navigation": { type: "array" } });
    expect(() => configSchema.parse({ schemas: { "pages.title": "" } })).toThrow();
    expect(() => configSchema.parse({ schemas: { "pages.title": 3 } })).toThrow();
  });
});

async function makeInstance(schemas: Record<string, unknown>): Promise<Validator> {
  const config = configSchema.parse({ schemas });
  return boundaryCast<Validator>(await module.setup(config, {
    get: () => {
      throw new Error("no contract expected");
    },
    find: () => undefined,
    logger: silentLogger,
    root: process.cwd(),
  }), "host");
}

function pipeline(...steps: string[]) {
  return definePipeline({ name: "test", steps });
}

const capture: Step = async (ctx: Context) => ok({ ...ctx, result: ctx.payload });

describe("validate/jsonschema steps via runPipeline", () => {
  const bodySchema = { type: "object", additionalProperties: false, properties: { html: { type: "string", format: "html" }, text: { type: "string" } }, required: ["text"] };

  it("check: passes describe().input (additionalProperties: true) and validates payload.body against the registered schema", async () => {
    const validator = await makeInstance({ "pages.body": bodySchema });
    const good = await runPipeline(pipeline("validate.check:pages.body"), { body: { body: { text: "hi" }, unrelated: "kept" } }, { modules: [{ module, instance: validator }] });
    expect(good.status).toBe(200);

    const bad = await runPipeline(pipeline("validate.check:pages.body"), { body: { body: { text: 5 } } }, { modules: [{ module, instance: validator }] });
    expect(bad.status).toBe(400);
    expect(bad.code).toBe("VALIDATION");
  });

  it("sanitize: cleans format:\"html\" positions of the payload field", async () => {
    const validator = await makeInstance({ "pages.body": bodySchema });
    const res = await runPipeline(pipeline("validate.sanitize:pages.body", "capture.payload"), { body: { body: { text: "hi", html: "<script>alert(1)</script><p>ok</p>" } } }, { modules: [{ module, instance: validator }], steps: { "capture.payload": capture } });
    expect(res.status).toBe(200);
    const body = boundaryCast<{ body: { html: string } }>(res.result, "host").body;
    expect(body.html).not.toContain("<script>");
    expect(body.html).toContain("<p>ok</p>");
  });

  it("sanitize: leaves a payload without the field alone", async () => {
    const validator = await makeInstance({ "pages.body": bodySchema });
    const res = await runPipeline(pipeline("validate.sanitize:pages.body", "capture.payload"), { body: { unrelated: "kept" } }, { modules: [{ module, instance: validator }], steps: { "capture.payload": capture } });
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ unrelated: "kept" });
  });

  it("sanitizeHtml: cleans an arbitrary payload field", async () => {
    const validator = await makeInstance({ "pages.body": bodySchema });
    const res = await runPipeline(pipeline("validate.sanitizeHtml:comment", "capture.payload"), { body: { comment: "<script>alert(1)</script><p>hi</p>" } }, { modules: [{ module, instance: validator }], steps: { "capture.payload": capture } });
    expect(res.status).toBe(200);
    const comment = boundaryCast<{ comment: string }>(res.result, "host").comment;
    expect(comment).not.toContain("<script>");
    expect(comment).toContain("<p>hi</p>");
  });

  it("sanitizeHtml: leaves a field that is not a string alone", async () => {
    const validator = await makeInstance({ "pages.body": bodySchema });
    const res = await runPipeline(pipeline("validate.sanitizeHtml:comment", "capture.payload"), { body: { comment: 5 } }, { modules: [{ module, instance: validator }], steps: { "capture.payload": capture } });
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ comment: 5 });
  });
});
