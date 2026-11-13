import type { JsonSchema, Kestrel, ResolvedPipeline, Route, StepDescription } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { resolveOutputSchema, resolveResultSchema } from "@michaelthielemann/kestrel/schema";
import { grantedHeaders, narrowAnswer } from "./narrow.ts";

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
  servers?: string[];
  mountPath?: string;
}

type Instance = Pick<Kestrel, "triggers" | "pipelines">;

const ERROR_SCHEMA: JsonSchema = {
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
};
const DEFAULT_ERRORS: Record<number, string> = { 500: "internal error", 503: "temporarily unavailable; retry after the Retry-After header" };
const RETRY_AFTER_HEADER = {
  description: "seconds until the client may retry",
  schema: { type: "integer" },
};

function pathOf(route: Route, mountPath: string): { path: string; params: string[] } {
  const params: string[] = [];
  const segments = route.segments.map((s) => {
    if (s.startsWith(":") || s.startsWith("*")) {
      params.push(s.slice(1));
      return `{${s.slice(1)}}`;
    }
    return s;
  });
  return { path: `${mountPath}/${segments.join("/")}`.replace(/\/+$/, "") || "/", params };
}

function mergeObjects(schemas: JsonSchema[]): JsonSchema | undefined {
  if (schemas.length === 0) return undefined;
  if (schemas.length === 1) return schemas[0];
  const propertiesOf = (s: JsonSchema): Record<string, unknown> => boundaryCast<Record<string, unknown>>(s.properties ?? {}, "json");
  const closed = schemas.filter((s) => s.additionalProperties === false).map((s) => new Set(Object.keys(propertiesOf(s))));
  const allowed = (name: string): boolean => closed.every((names) => names.has(name));
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const s of schemas) {
    for (const [name, property] of Object.entries(propertiesOf(s))) if (allowed(name)) properties[name] = property;
    for (const r of boundaryCast<string[]>(s.required ?? [], "json")) if (allowed(r)) required.add(r);
  }
  const merged: JsonSchema = { type: "object", properties };
  if (required.size > 0) merged.required = [...required].sort();
  if (closed.length > 0) merged.additionalProperties = false;
  return merged;
}

const COMPONENT_NAME = /^[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)*$/;

function componentRef(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

function answersResponse(pipeline: ResolvedPipeline, descriptions: readonly StepDescription[], output: JsonSchema | undefined, schemas: Record<string, JsonSchema>): Record<string, unknown> | undefined {
  const narrows = pipeline.steps.at(-1)?.description.narrows;
  if (narrows === undefined || narrows.shape === "file") return undefined;
  const fold = resolveOutputSchema(descriptions);
  const terminals: unknown[] = output !== undefined && output !== fold ? arrayOf(output.anyOf).slice(1) : [];
  const op = pipeline.name;
  schemas[op] = output ?? {};
  const answers: Record<string, { $ref: string }> = {};
  for (const [label, paths] of Object.entries(narrows.answers)) {
    if (!COMPONENT_NAME.test(label)) continue;
    const name = `${op}.${label.split(":").join(".")}`;
    const narrowed = fold === undefined ? undefined : narrowAnswer(fold, narrows.shape, paths);
    const shapes = narrowed === undefined ? terminals : [narrowed, ...terminals];
    const [only] = shapes;
    schemas[name] = shapes.length === 0 ? {} : shapes.length === 1 && isSchema(only) ? only : { anyOf: shapes };
    answers[label] = componentRef(name);
  }
  return {
    description: "ok; x-kestrel-answers names the answer each audience receives",
    content: { "application/json": { schema: { anyOf: [componentRef(op), ...Object.values(answers)] } } },
    "x-kestrel-answers": answers,
  };
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileResponse(pipeline: ResolvedPipeline): Record<string, unknown> {
  const narrows = pipeline.steps.at(-1)?.description.narrows;
  const response: Record<string, unknown> = { description: "the file", content: { "*/*": { schema: { type: "string", format: "binary" } } } };
  if (narrows?.shape !== "file") return response;
  const answers = Object.entries(narrows.answers)
    .filter(([label]) => COMPONENT_NAME.test(label))
    .map(([label, paths]): [string, { headers: string[] }] => [label, { headers: grantedHeaders(paths) }]);
  return { ...response, "x-kestrel-answers": Object.fromEntries(answers) };
}

function operation(route: Route, pipeline: ResolvedPipeline, params: string[], schemas: Record<string, JsonSchema>): Record<string, unknown> {
  const descriptions = pipeline.steps.map((s) => s.description).filter((d): d is StepDescription => d !== undefined);
  const inputs = descriptions.map((d) => d.input).filter((i): i is JsonSchema => i !== undefined);
  const output = resolveResultSchema(descriptions);
  const binary = descriptions.some((d) => d.binary);
  const multipart = descriptions.some((d) => d.multipart);
  const errors: Record<number, string> = { ...DEFAULT_ERRORS };
  for (const d of descriptions) Object.assign(errors, d.errors ?? {});
  if (["POST", "PUT", "PATCH"].includes(route.method)) errors[400] = errors[400] ?? "invalid body";
  const security = descriptions.map((d) => d.security).filter((s) => s !== undefined);
  const query: Record<string, JsonSchema> = {};
  for (const d of descriptions) Object.assign(query, d.query ?? {});

  const parameters: unknown[] = [
    ...params.map((name) => ({ name, in: "path", required: true, schema: { type: "string" }, ...(name === "path" ? { description: "rest of the path, may contain slashes" } : {}) })),
    ...Object.entries(query).map(([name, schema]) => ({ name, in: "query", required: false, schema })),
  ];

  const op: Record<string, unknown> = {
    operationId: pipeline.name,
    summary: descriptions.map((d) => d.summary).filter(Boolean).join(" → ") || pipeline.name,
    tags: [route.segments[0]?.replace(/^[:*]/, "") ?? "root"],
    "x-kestrel-pipeline": pipeline.name,
    "x-kestrel-steps": pipeline.steps.map((s) => s.name),
    parameters,
    responses: {
      "200": binary ? fileResponse(pipeline) : (answersResponse(pipeline, descriptions, output, schemas) ?? { description: "ok", content: { "application/json": { schema: output ?? {} } } }),
      ...Object.fromEntries(
        Object.entries(errors)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([status, description]) => [
            status,
            {
              description,
              ...(status === "429" || status === "503" ? { headers: { "Retry-After": RETRY_AFTER_HEADER } } : {}),
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          ]),
      ),
    },
  };
  const body = mergeObjects(inputs);
  if (multipart) {
    const properties = { ...boundaryCast<Record<string, unknown>>(body?.properties ?? {}, "json"), file: { type: "string", format: "binary" } };
    op.requestBody = { required: true, content: { "multipart/form-data": { schema: { type: "object", properties, required: ["file"] } } } };
  } else if (body && ["POST", "PUT", "PATCH", "DELETE"].includes(route.method)) {
    op.requestBody = { required: true, content: { "application/json": { schema: body } } };
  }
  if (security.includes("required")) op.security = [{ bearerAuth: [] }];
  else if (security.includes("optional")) op.security = [{ bearerAuth: [] }, {}];
  return op;
}

export function generateOpenApi(kestrel: Instance, info: OpenApiInfo): Record<string, unknown> {
  const mountPath = (info.mountPath ?? "").replace(/\/+$/, "");
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, JsonSchema> = { Error: ERROR_SCHEMA };
  const routes = [...kestrel.triggers.http].sort((a, b) => a.segments.join("/").localeCompare(b.segments.join("/")) || a.method.localeCompare(b.method));
  for (const route of routes) {
    const pipeline = kestrel.pipelines.get(route.pipeline);
    if (!pipeline) throw new Error(`openapi: trigger references unknown pipeline "${route.pipeline}"`);
    const { path, params } = pathOf(route, mountPath);
    paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation(route, pipeline, params, schemas) };
  }
  const doc: Record<string, unknown> = {
    openapi: "3.1.0",
    info: { title: info.title, version: info.version, ...(info.description === undefined ? {} : { description: info.description }) },
    paths,
    components: {
      schemas,
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "token from the login pipeline" } },
    },
  };
  if (info.servers) doc.servers = info.servers.map((url) => ({ url }));
  return doc;
}
