import { describe, it, expect } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline, ok, silentLogger, stepFactory, type Context } from "@michaelthielemann/kestrel";
import { generateOpenApi } from "./index.ts";

const pass = async (ctx: Context) => ok(ctx);
const demo = defineModule({
  name: "demo/x",
  provides: [],
  requires: [],
  configSchema: z.object({}),
  async setup() { return {}; },
  steps: () => ({
    requireUser: pass,
    identifyUser: pass,
    create: stepFactory(() => pass),
    get: stepFactory(() => pass),
    upload: pass,
    download: pass,
    plain: pass,
    publish: pass,
    exportRedirects: pass,
    lonelyExtend: pass,
    replaceAfterExtend: pass,
    list: pass,
    attachToItems: pass,
  }),
  describe: () => ({
    requireUser: { summary: "Require a valid session", reads: [], writes: [], security: "required", errors: { 401: "not authenticated" } },
    identifyUser: { summary: "Identify the caller if a session exists", reads: [], writes: [], security: "optional" },
    create: (type) => ({ summary: `Create ${type}`, reads: [], writes: ["result"], input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, output: { type: "object", properties: { id: { type: "string" } } }, errors: { 400: "validation failed" } }),
    get: (type) => ({ summary: `Get ${type}`, reads: [], writes: ["result"], query: { locale: { type: "string" } }, output: { type: "object" }, errors: { 404: "not found" } }),
    upload: { summary: "Upload a file", reads: ["files"], writes: ["result"], multipart: true, input: { type: "object", properties: { folder: { type: "string" } } }, output: { type: "object" } },
    download: { summary: "Download a file", reads: ["params.id"], writes: ["result"], binary: true, errors: { 404: "not found" } },
    plain: { summary: "Plain step", reads: [], writes: [] },
    publish: { summary: "Publish", reads: [], writes: ["result"], output: { type: "object", properties: { documents: { type: "integer" }, live: { type: "integer" }, errors: { type: "integer" } }, required: ["documents", "live", "errors"] } },
    exportRedirects: { summary: "Export redirects", reads: [], writes: ["result.redirects"], extendsOutput: { type: "object", properties: { redirects: { type: "object", properties: { rules: { type: "integer" } }, required: ["rules"] } }, required: ["redirects"] } },
    lonelyExtend: { summary: "Lonely extend", reads: [], writes: ["result.extra"], extendsOutput: { type: "object", properties: { extra: { type: "string" } }, required: ["extra"] } },
    replaceAfterExtend: { summary: "Replace after extend", reads: [], writes: ["result"], output: { type: "object", properties: { onlyThis: { type: "string" } }, required: ["onlyThis"] } },
    list: { summary: "List", reads: [], writes: ["result"], output: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, total: { type: "integer" } }, required: ["items", "total"] } },
    attachToItems: { summary: "Attach to items", reads: ["result"], writes: ["result.variants"], extendsItems: { type: "object", properties: { variants: { type: "array", items: { type: "string" } } }, required: ["variants"] } },
  }),
});
const config = {
  modules: [{ use: "./demo", config: {} }],
  triggers: [
    { http: "POST /pages", pipeline: "createPage" },
    { http: "GET /pages/:id", pipeline: "readPage" },
    { http: "GET /site/*path", pipeline: "readPage" },
    { http: "POST /media", pipeline: "upload" },
    { http: "GET /media/:id/file", pipeline: "download" },
    { http: "GET /plain", pipeline: "plain" },
    { http: "POST /publish-all", pipeline: "publishAll" },
    { http: "POST /lonely-extend", pipeline: "lonelyExtendOnly" },
    { http: "POST /replace-after-extend", pipeline: "replaceAfterExtendOnly" },
    { http: "GET /listed", pipeline: "listed" },
    { http: "GET /single", pipeline: "single" },
  ],
  http: null,
};
const pipelines = [
  definePipeline({ name: "createPage", steps: ["demo.requireUser", "demo.create:pages"] }),
  definePipeline({ name: "readPage", steps: ["demo.identifyUser", "demo.get:pages"] }),
  definePipeline({ name: "upload", steps: ["demo.requireUser", "demo.upload"] }),
  definePipeline({ name: "download", steps: ["demo.download"] }),
  definePipeline({ name: "plain", steps: ["demo.plain"] }),
  definePipeline({ name: "publishAll", steps: ["demo.publish", "demo.exportRedirects"] }),
  definePipeline({ name: "lonelyExtendOnly", steps: ["demo.lonelyExtend"] }),
  definePipeline({ name: "replaceAfterExtendOnly", steps: ["demo.exportRedirects", "demo.replaceAfterExtend"] }),
  definePipeline({ name: "listed", steps: ["demo.list", "demo.attachToItems"] }),
  definePipeline({ name: "single", steps: ["demo.replaceAfterExtend", "demo.attachToItems"] }),
];

async function generate(mountPath?: string) {
  const kestrel = await boot({ config, modules: [demo], pipelines, logger: silentLogger });
  return generateOpenApi(kestrel, { title: "t", version: "1.0.0", servers: ["http://localhost:3000"], ...(mountPath === undefined ? {} : { mountPath }) }) as {
    openapi: string;
    paths: Record<string, Record<string, Record<string, unknown>>>;
    components: Record<string, unknown>;
  };
}

describe("kestrel-openapi", () => {
  it("emits one operation per trigger with params, body, responses and security", async () => {
    const doc = await generate();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).sort()).toEqual(["/listed", "/lonely-extend", "/media", "/media/{id}/file", "/pages", "/pages/{id}", "/plain", "/publish-all", "/replace-after-extend", "/single", "/site/{path}"]);
    const create = doc.paths["/pages"]?.post as Record<string, unknown>;
    expect(create.operationId).toBe("createPage");
    expect(create.security).toEqual([{ bearerAuth: [] }]);
    expect(create.requestBody).toMatchObject({ content: { "application/json": { schema: { required: ["title"] } } } });
    expect(Object.keys(create.responses as object).sort()).toEqual(["200", "400", "401", "500", "503"]);
    const read = doc.paths["/pages/{id}"]?.get as Record<string, unknown>;
    expect(read.security).toEqual([{ bearerAuth: [] }, {}]);
    expect(read.parameters).toEqual([{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "locale", in: "query", required: false, schema: { type: "string" } }]);
    expect((doc.paths["/site/{path}"]?.get?.parameters as Array<{ name: string }>)[0]?.name).toBe("path");
  });

  it("describes the error body with code, retryable and the optional step and details fields", async () => {
    const doc = await generate();
    expect((doc.components as { schemas: { Error: unknown } }).schemas.Error).toEqual({
      type: "object",
      properties: {
        error: { type: "string" },
        code: { type: "string" },
        retryable: { type: "boolean" },
        runId: { type: "string", format: "uuid" },
        step: { type: "string" },
        details: { type: "object", additionalProperties: true },
      },
      required: ["error", "code", "retryable", "runId"],
    });
  });

  it("documents Retry-After on 429 and 503 but not on other error responses", async () => {
    const doc = await generate();
    const create = doc.paths["/pages"]?.post as { responses: Record<string, { headers?: unknown }> };
    expect(create.responses["500"]?.headers).toBeUndefined();
    expect(create.responses["503"]?.headers).toEqual({ "Retry-After": { description: "seconds until the client may retry", schema: { type: "integer" } } });
    const upload = doc.paths["/media"]?.post as { responses: Record<string, { headers?: unknown }> };
    expect(upload.responses["401"]?.headers).toBeUndefined();
  });

  it("describes multipart uploads and binary downloads", async () => {
    const doc = await generate();
    const upload = doc.paths["/media"]?.post as Record<string, unknown>;
    expect(upload.requestBody).toMatchObject({ content: { "multipart/form-data": { schema: { properties: { file: { format: "binary" }, folder: { type: "string" } }, required: ["file"] } } } });
    const download = doc.paths["/media/{id}/file"]?.get as { responses: Record<string, unknown> };
    expect(download.responses["200"]).toMatchObject({ content: { "*/*": { schema: { format: "binary" } } } });
  });

  it("steps without an output schema still produce an operation, and output is deterministic", async () => {
    const a = await generate("/api");
    const b = await generate("/api");
    expect(Object.keys(a.paths)[0]).toBe("/api/listed");
    expect((a.paths["/api/plain"]?.get as { responses: Record<string, unknown> }).responses["200"]).toMatchObject({ content: { "application/json": { schema: {} } } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("merges extendsOutput into the preceding output's properties and required", async () => {
    const doc = await generate();
    const publishAll = doc.paths["/publish-all"]?.post as { responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }> };
    const schema = publishAll.responses["200"]!.content["application/json"].schema;
    expect(schema).toEqual({
      type: "object",
      properties: {
        documents: { type: "integer" },
        live: { type: "integer" },
        errors: { type: "integer" },
        redirects: { type: "object", properties: { rules: { type: "integer" } }, required: ["rules"] },
      },
      required: ["documents", "errors", "live", "redirects"],
    });
  });

  it("uses extendsOutput as the output when there was no prior output", async () => {
    const doc = await generate();
    const lonely = doc.paths["/lonely-extend"]?.post as { responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }> };
    expect(lonely.responses["200"]!.content["application/json"].schema).toEqual({
      type: "object",
      properties: { extra: { type: "string" } },
      required: ["extra"],
    });
  });

  it("lets a later output replace a preceding extendsOutput merge", async () => {
    const doc = await generate();
    const replaced = doc.paths["/replace-after-extend"]?.post as { responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }> };
    expect(replaced.responses["200"]!.content["application/json"].schema).toEqual({
      type: "object",
      properties: { onlyThis: { type: "string" } },
      required: ["onlyThis"],
    });
  });

  it("merges extendsItems into items[] of a list output", async () => {
    const doc = await generate();
    const listed = doc.paths["/listed"]?.get as { responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }> };
    expect(listed.responses["200"]!.content["application/json"].schema).toEqual({
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, variants: { type: "array", items: { type: "string" } } }, required: ["id", "variants"] } },
        total: { type: "integer" },
      },
      required: ["items", "total"],
    });
  });

  it("merges extendsItems at the root when the output has no items[]", async () => {
    const doc = await generate();
    const single = doc.paths["/single"]?.get as { responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }> };
    expect(single.responses["200"]!.content["application/json"].schema).toEqual({
      type: "object",
      properties: { onlyThis: { type: "string" }, variants: { type: "array", items: { type: "string" } } },
      required: ["onlyThis", "variants"],
    });
  });
});
