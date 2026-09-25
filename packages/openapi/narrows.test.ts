import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline, ok, silentLogger, type Context, type JsonSchema, type NarrowsDeclaration } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { generateOpenApi } from "./index.ts";

const ITEM: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    folder: { type: "string" },
    provenance: { type: "object", properties: { origin: { type: "string" }, tool: { type: "string" } }, required: ["origin"] },
    variants: { type: "array", items: { type: "object", properties: { path: { type: "string" }, bytes: { type: "number" } }, required: ["path", "bytes"] } },
    hero: { anyOf: [{ type: "object", properties: { id: { type: "string" }, secret: { type: "string" } }, required: ["id", "secret"] }, { type: "null" }] },
    _translations: { type: "object", additionalProperties: { type: "boolean" } },
  },
  required: ["id", "folder", "provenance", "variants"],
};
const NARROWED_ITEM: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    provenance: { type: "object", properties: { origin: { type: "string" } }, required: ["origin"], additionalProperties: false },
    variants: { type: "array", items: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
    hero: { anyOf: [{ type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, { type: "null" }] },
    _translations: { type: "object", additionalProperties: { type: "boolean" } },
  },
  required: ["id", "provenance", "variants"],
  additionalProperties: false,
};
const PATHS = ["id", "provenance.origin", "variants[].path", "hero.id", "_translations", "notDeclaredHere"];
const TERMINAL: JsonSchema = { type: "object", properties: { redirect: { type: "string" } }, required: ["redirect"], additionalProperties: false };

function narrowing(shape: NarrowsDeclaration["shape"], answers: NarrowsDeclaration["answers"]) {
  return { summary: "cut", reads: ["result?"], writes: ["result?"], narrows: { shape, answers } };
}

const pass = async (ctx: Context) => ok(ctx);
const records = defineModule({
  name: "records/x",
  provides: [],
  requires: [],
  configSchema: z.object({}),
  async setup() {
    return {};
  },
  steps: () => ({ get: pass, list: pass, rules: pass, file: pass, maybeEnd: pass, cutItem: pass, cutList: pass, cutRules: pass, cutFile: pass, cutOdd: pass }),
  describe: () => ({
    get: { summary: "get", reads: [], writes: ["result"], output: ITEM },
    list: { summary: "list", reads: [], writes: ["result"], output: { type: "object", properties: { items: { type: "array", items: ITEM }, total: { type: "number" }, cursor: { type: "string" } }, required: ["items", "total"] } },
    rules: { summary: "rules", reads: [], writes: ["result"], output: { type: "array", items: { type: "object", properties: { pattern: { type: "string" }, note: { type: "string" } }, required: ["pattern", "note"] } } },
    file: { summary: "file", reads: [], writes: ["result"], binary: true },
    maybeEnd: { summary: "maybe end", reads: [], writes: ["result?"], terminalOutput: TERMINAL },
    cutItem: narrowing("item", { anonymous: PATHS, "role:reviewer": [...PATHS, "folder"] }),
    cutList: narrowing("list", { anonymous: PATHS }),
    cutRules: narrowing("array", { anonymous: ["pattern"] }),
    cutFile: narrowing("file", { anonymous: ["headers.cache-control", "headers.x-content-provenance"] }),
    cutOdd: narrowing("item", { anonymous: ["id"], "not a name": ["id"] }),
  }),
});

async function document() {
  const kestrel = await boot({
    config: {
      modules: [{ use: "./records", config: {} }],
      triggers: [
        { http: "GET /records/:id", pipeline: "getRecord" },
        { http: "GET /records", pipeline: "listRecords" },
        { http: "GET /rules", pipeline: "listRules" },
        { http: "GET /records/:id/file", pipeline: "getFile" },
        { http: "GET /site/*path", pipeline: "resolveRecord" },
        { http: "GET /plain/:id", pipeline: "plainRecord" },
        { http: "GET /odd/:id", pipeline: "oddRecord" },
      ],
      http: null,
    },
    modules: [records],
    pipelines: [
      definePipeline({ name: "getRecord", steps: ["records.get", "records.cutItem"] }),
      definePipeline({ name: "listRecords", steps: ["records.list", "records.cutList"] }),
      definePipeline({ name: "listRules", steps: ["records.rules", "records.cutRules"] }),
      definePipeline({ name: "getFile", steps: ["records.file", "records.cutFile"] }),
      definePipeline({ name: "resolveRecord", steps: ["records.maybeEnd", "records.get", "records.cutItem"] }),
      definePipeline({ name: "plainRecord", steps: ["records.get"] }),
      definePipeline({ name: "oddRecord", steps: ["records.get", "records.cutOdd"] }),
    ],
    logger: silentLogger,
  });
  const doc = boundaryCast<{ paths: Record<string, Record<string, { responses: Record<string, Record<string, unknown>> }>>; components: { schemas: Record<string, JsonSchema> } }>(generateOpenApi(kestrel, { title: "t", version: "1" }), "json");
  await kestrel.stop();
  return doc;
}

describe("openapi: an operation ending with a narrowing step", () => {
  it("documents the full answer and one answer per audience as components, and the 200 as any of them", async () => {
    const doc = await document();
    const ok = doc.paths["/records/{id}"]!.get!.responses["200"]!;
    expect(ok.content).toEqual({ "application/json": { schema: { anyOf: [{ $ref: "#/components/schemas/getRecord" }, { $ref: "#/components/schemas/getRecord.anonymous" }, { $ref: "#/components/schemas/getRecord.role.reviewer" }] } } });
    expect(ok["x-kestrel-answers"]).toEqual({ anonymous: { $ref: "#/components/schemas/getRecord.anonymous" }, "role:reviewer": { $ref: "#/components/schemas/getRecord.role.reviewer" } });
    expect(doc.components.schemas.getRecord).toEqual(ITEM);
    expect(doc.components.schemas["getRecord.anonymous"]).toEqual(NARROWED_ITEM);
    expect(doc.components.schemas["getRecord.role.reviewer"]).toEqual({ ...NARROWED_ITEM, properties: { id: { type: "string" }, folder: { type: "string" }, ...boundaryCast<Record<string, unknown>>(NARROWED_ITEM.properties, "json") }, required: ["id", "folder", "provenance", "variants"] });
  });

  it("narrows every item of a list and keeps only items and total of its envelope", async () => {
    const doc = await document();
    expect(doc.components.schemas["listRecords.anonymous"]).toEqual({ type: "object", properties: { items: { type: "array", items: NARROWED_ITEM }, total: { type: "number" } }, required: ["items", "total"], additionalProperties: false });
  });

  it("narrows every element of an array answer", async () => {
    const doc = await document();
    expect(doc.components.schemas["listRules.anonymous"]).toEqual({ type: "array", items: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false } });
  });

  it("keeps an answer a step ends the run with before the narrowing step as it is", async () => {
    const doc = await document();
    expect(doc.components.schemas["resolveRecord.anonymous"]).toEqual({ anyOf: [NARROWED_ITEM, TERMINAL] });
    expect(doc.components.schemas.resolveRecord).toEqual({ anyOf: [ITEM, TERMINAL] });
  });

  it("keeps a file operation's binary 200 and lists the headers each audience receives", async () => {
    const doc = await document();
    const ok = doc.paths["/records/{id}/file"]!.get!.responses["200"]!;
    expect(ok.content).toEqual({ "*/*": { schema: { type: "string", format: "binary" } } });
    expect(ok["x-kestrel-answers"]).toEqual({ anonymous: { headers: ["cache-control", "x-content-provenance"] } });
    expect(doc.components.schemas).not.toHaveProperty("getFile");
  });

  it("prints an operation without a narrowing step as before", async () => {
    const doc = await document();
    const ok = doc.paths["/plain/{id}"]!.get!.responses["200"]!;
    expect(ok).toEqual({ description: "ok", content: { "application/json": { schema: ITEM } } });
    expect(doc.components.schemas).not.toHaveProperty("plainRecord");
  });

  it("leaves out an audience label that cannot name a component", async () => {
    const doc = await document();
    expect(doc.paths["/odd/{id}"]!.get!.responses["200"]!["x-kestrel-answers"]).toEqual({ anonymous: { $ref: "#/components/schemas/oddRecord.anonymous" } });
  });
});
