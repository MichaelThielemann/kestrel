import type { JsonSchema, Kestrel, ResolvedPipeline, Route, StepDescription } from "@michaelthielemann/kestrel";

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
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const s of schemas) {
    Object.assign(properties, (s.properties as Record<string, unknown> | undefined) ?? {});
    for (const r of (s.required as string[] | undefined) ?? []) required.add(r);
  }
  const merged: JsonSchema = { type: "object", properties };
  if (required.size > 0) merged.required = [...required].sort();
  return merged;
}

function mergeIntoItems(current: JsonSchema | undefined, extension: JsonSchema): JsonSchema {
  const properties = current?.properties as Record<string, JsonSchema> | undefined;
  const list = properties?.items;
  const item = list?.items as JsonSchema | undefined;
  if (current === undefined || item === undefined || typeof item !== "object" || Array.isArray(item)) {
    return current === undefined ? extension : mergeObjects([current, extension])!;
  }
  return { ...current, properties: { ...properties, items: { ...list, items: mergeObjects([item, extension])! } } };
}

function resolveOutput(descriptions: StepDescription[]): JsonSchema | undefined {
  let current: JsonSchema | undefined;
  for (const d of descriptions) {
    if (d.output !== undefined) current = d.output;
    else if (d.extendsOutput !== undefined) current = current === undefined ? d.extendsOutput : mergeObjects([current, d.extendsOutput]);
    if (d.extendsItems !== undefined) current = mergeIntoItems(current, d.extendsItems);
  }
  return current;
}

function operation(route: Route, pipeline: ResolvedPipeline, params: string[]): Record<string, unknown> {
  const descriptions = pipeline.steps.map((s) => s.description).filter((d): d is StepDescription => d !== undefined);
  const inputs = descriptions.map((d) => d.input).filter((i): i is JsonSchema => i !== undefined);
  const output = resolveOutput(descriptions);
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
      "200": binary
        ? { description: "the file", content: { "*/*": { schema: { type: "string", format: "binary" } } } }
        : { description: "ok", content: { "application/json": { schema: output ?? {} } } },
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
    const properties = { ...((body?.properties as Record<string, unknown> | undefined) ?? {}), file: { type: "string", format: "binary" } };
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
  const routes = [...kestrel.triggers.http].sort((a, b) => a.segments.join("/").localeCompare(b.segments.join("/")) || a.method.localeCompare(b.method));
  for (const route of routes) {
    const pipeline = kestrel.pipelines.get(route.pipeline);
    if (!pipeline) throw new Error(`openapi: trigger references unknown pipeline "${route.pipeline}"`);
    const { path, params } = pathOf(route, mountPath);
    paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation(route, pipeline, params) };
  }
  const doc: Record<string, unknown> = {
    openapi: "3.1.0",
    info: { title: info.title, version: info.version, ...(info.description === undefined ? {} : { description: info.description }) },
    paths,
    components: {
      schemas: { Error: ERROR_SCHEMA },
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "token from the login pipeline" } },
    },
  };
  if (info.servers) doc.servers = info.servers.map((url) => ({ url }));
  return doc;
}
