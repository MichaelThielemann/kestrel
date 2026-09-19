import { z } from "zod";
import { INSIGHTS } from "@michaelthielemann/kestrel-contracts/insights";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule, type JsonSchema } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import { createInsights, type InsightsDefault } from "./impl.ts";

export const configSchema = z.object({ recentFailures: z.number().int().min(0).max(500).default(50) }).strict();

const STRINGS: JsonSchema = { type: "array", items: { type: "string" } };
const NULLABLE_NUMBER: JsonSchema = { type: ["number", "null"] };
const STEP_DESCRIPTION: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    reads: STRINGS,
    writes: STRINGS,
    input: { type: "object" },
    output: { type: "object" },
    extendsOutput: { type: "object" },
    extendsItems: { type: "object" },
    query: { type: "object", additionalProperties: { type: "object" } },
    errors: { type: "object", additionalProperties: { type: "string" } },
    security: { type: "string", enum: ["required", "optional"] },
    multipart: { type: "boolean" },
    binary: { type: "boolean" },
  },
  required: ["summary", "reads", "writes"],
};
const VARIABLE: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    type: { type: "string" },
    required: { type: "boolean" },
    default: {},
    secret: { type: "boolean" },
    set: { type: "boolean" },
    status: { type: "string", enum: ["set", "default", "missing"], description: "set: the raw config carries the path; default: it does not and the value comes from this node's or an ancestor's default; missing: no value at all" },
    value: { description: "The effective value as a JSON snapshot: what the config sets, else the default; null when the variable is missing or redacted" },
    redacted: { type: "boolean", description: "The value is withheld: the schema marks the variable secret, its key name looks like a credential, or an ancestor is redacted" },
  },
  required: ["path", "type", "required", "secret", "set", "status", "value", "redacted"],
};
const MODULE: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    use: { type: "string" },
    version: { type: ["string", "null"] },
    provides: STRINGS,
    requires: STRINGS,
    optional: STRINGS,
    config: { type: "object", properties: { schema: { type: "object" }, variables: { type: "array", items: VARIABLE } }, required: ["schema", "variables"] },
    steps: STRINGS,
    eventHook: { type: "boolean" },
    emits: STRINGS,
  },
  required: ["name", "use", "version", "provides", "requires", "optional", "config", "steps", "eventHook", "emits"],
};
const PIPELINE_STEP: JsonSchema = { type: "object", properties: { spec: { type: "string" }, name: { type: "string" }, module: { type: "string" }, description: STEP_DESCRIPTION }, required: ["spec", "name", "module", "description"] };
const TRIGGER = (key: string): JsonSchema => ({ type: "object", properties: { [key]: { type: "string" }, pipeline: { type: "string" } }, required: [key, "pipeline"] });

export const MANIFEST_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    generatedAt: { type: "number" },
    core: { type: "object", properties: { version: { type: "string" } }, required: ["version"] },
    contracts: STRINGS,
    modules: { type: "array", items: MODULE },
    steps: { type: "array", items: { type: "object", properties: { name: { type: "string" }, module: { type: "string" }, factory: { type: "boolean" }, description: STEP_DESCRIPTION }, required: ["name", "module", "factory", "description"] } },
    pipelines: { type: "array", items: { type: "object", properties: { name: { type: "string" }, steps: { type: "array", items: PIPELINE_STEP } }, required: ["name", "steps"] } },
    triggers: {
      type: "object",
      properties: {
        http: { type: "array", items: { type: "object", properties: { method: { type: "string" }, path: { type: "string" }, pipeline: { type: "string" } }, required: ["method", "path", "pipeline"] } },
        events: { type: "array", items: TRIGGER("event") },
        crons: { type: "array", items: TRIGGER("expression") },
      },
      required: ["http", "events", "crons"],
    },
  },
  required: ["generatedAt", "core", "contracts", "modules", "steps", "pipelines", "triggers"],
};

const TIMING = { count: { type: "number" }, failed: { type: "number" }, errors: { type: "number" }, p50Ms: { type: "number" }, p95Ms: { type: "number" } };
const RECENT_FAILURE: JsonSchema = {
  type: "object",
  properties: {
    at: { type: "number" },
    runId: { type: "string" },
    pipeline: { type: "string" },
    trigger: { type: "object", properties: { kind: { type: "string" }, name: { type: "string" } }, required: ["kind", "name"] },
    status: { type: "number" },
    ms: { type: "number" },
    code: { type: "string" },
    step: { type: "string" },
    message: { type: "string", description: "The failure text a client would see, truncated; never a stack" },
  },
  required: ["at", "runId", "pipeline", "trigger", "status", "ms"],
};
export const STATS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    generatedAt: { type: "number" },
    process: { type: "object", properties: { pid: { type: "number" }, startedAt: { type: "number" }, uptimeMs: { type: "number" } }, required: ["pid", "startedAt", "uptimeMs"] },
    runs: { type: "object", properties: { active: { type: "number" }, total: { type: "number" }, failed: { type: "number" }, errors: { type: "number" } }, required: ["active", "total", "failed", "errors"] },
    pipelines: { type: "array", items: { type: "object", properties: { name: { type: "string" }, ...TIMING, lastAt: NULLABLE_NUMBER }, required: ["name", "count", "failed", "errors", "p50Ms", "p95Ms", "lastAt"] } },
    steps: { type: "array", items: { type: "object", properties: { pipeline: { type: "string" }, step: { type: "string" }, ...TIMING }, required: ["pipeline", "step", "count", "failed", "errors", "p50Ms", "p95Ms"] } },
    events: { type: "array", items: { type: "object", properties: { name: { type: "string" }, count: { type: "number" }, lastAt: NULLABLE_NUMBER }, required: ["name", "count", "lastAt"] } },
    ratelimit: { type: "array", items: { type: "object", properties: { key: { type: "string" }, remaining: { type: "number" }, resetAt: { type: "number" } }, required: ["key", "remaining", "resetAt"] } },
    recentFailures: { type: "array", items: RECENT_FAILURE },
  },
  required: ["generatedAt", "process", "runs", "pipelines", "steps", "events", "ratelimit", "recentFailures"],
};

export default defineModule({
  name: "insights/default",
  provides: [INSIGHTS],
  requires: [],
  configSchema,

  async setup(config): Promise<InsightsDefault> {
    return createInsights({ recentFailureSize: config.recentFailures });
  },

  attach: (insights, kestrel) => insights.attach(kestrel),

  steps: (insights) => ({
    readManifest: async (ctx: Context) => ok({ ...ctx, result: { generatedAt: Date.now(), ...insights.manifest() } }),
    readStats: async (ctx: Context) => ok({ ...ctx, result: insights.stats() }),
  }),

  describe: () => ({
    readManifest: { summary: "The static manifest of this instance: modules, contracts, config schemas, steps, pipelines, triggers", reads: [], writes: ["result"], output: MANIFEST_SCHEMA },
    readStats: { summary: "Live counters of this process: runs, pipelines, steps, events, and the most recent failed runs", reads: [], writes: ["result"], output: STATS_SCHEMA },
  }),
});
