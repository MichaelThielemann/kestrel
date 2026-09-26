import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boundaryCast } from "./cast.ts";
import { describeConfig, mergeConfigDefaults, toJsonSchema } from "./zodSchema.ts";

const schema = z
  .object({
    file: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(3000),
    mode: z.enum(["apply", "check", "off"]).default("apply"),
    tags: z.array(z.string()).optional(),
    buckets: z.record(z.object({ limit: z.number().int().positive() }).strict()),
    passwordHash: z.string().startsWith("scrypt$").describe("secret"),
    bootstrap: z.object({ username: z.string().min(1), token: z.string().describe("secret").default("x") }).strict().optional(),
    kind: z.union([z.literal("a"), z.literal("b")]),
    up: z.custom<() => void>((v) => typeof v === "function"),
    ttl: z.number().nullable(),
  })
  .strict();

describe("toJsonSchema", () => {
  it("maps objects, strings, numbers, enums, arrays, records, unions and defaults", () => {
    const out = toJsonSchema(schema);
    expect(out.type).toBe("object");
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual(["file", "buckets", "passwordHash", "kind", "up", "ttl"]);
    const props = boundaryCast<Record<string, Record<string, unknown>>>(out.properties, "json");
    expect(props.file).toEqual({ type: "string", minLength: 1 });
    expect(props.port).toEqual({ type: "integer", minimum: 1, maximum: 65535, default: 3000 });
    expect(props.mode).toEqual({ type: "string", enum: ["apply", "check", "off"], default: "apply" });
    expect(props.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(props.buckets).toEqual({ type: "object", additionalProperties: { type: "object", properties: { limit: { type: "integer", exclusiveMinimum: 0 } }, required: ["limit"], additionalProperties: false } });
    expect(props.kind).toEqual({ anyOf: [{ const: "a" }, { const: "b" }] });
    expect(props.up).toEqual({});
    expect(props.ttl).toEqual({ anyOf: [{ type: "number" }, { type: "null" }] });
  });

  it("keeps the secret marker and secret defaults out of the schema and marks the property writeOnly", () => {
    const props = boundaryCast<Record<string, Record<string, unknown>>>(toJsonSchema(schema).properties, "json");
    expect(props.passwordHash).toEqual({ type: "string", pattern: "^scrypt\\$", writeOnly: true });
    const bootstrap = boundaryCast<Record<string, unknown>>(props.bootstrap?.properties, "json");
    expect(bootstrap.token).toEqual({ type: "string", writeOnly: true });
    expect(JSON.stringify(toJsonSchema(schema))).not.toContain('"secret"');
  });

  it("carries a plain description through", () => {
    expect(toJsonSchema(z.string().describe("the file"))).toEqual({ type: "string", description: "the file" });
  });
});

describe("describeConfig", () => {
  it("lists one row per path with type, required, default, secret, set, status, value and redacted", () => {
    const { variables } = describeConfig(schema, { file: "./x.db", buckets: {}, passwordHash: "scrypt$abc", bootstrap: { username: "admin" }, kind: "a", up: () => {}, ttl: null });
    const byPath = Object.fromEntries(variables.map((v) => [v.path, v]));
    expect(byPath.file).toEqual({ path: "file", type: "string", required: true, secret: false, set: true, status: "set", value: "./x.db", redacted: false });
    expect(byPath.port).toEqual({ path: "port", type: "integer", required: false, default: 3000, secret: false, set: false, status: "default", value: 3000, redacted: false });
    expect(byPath.mode).toEqual({ path: "mode", type: "enum", required: false, default: "apply", secret: false, set: false, status: "default", value: "apply", redacted: false });
    expect(byPath.tags).toEqual({ path: "tags", type: "array", required: false, secret: false, set: false, status: "missing", value: null, redacted: false });
    expect(byPath.buckets).toEqual({ path: "buckets", type: "record", required: true, secret: false, set: true, status: "set", value: {}, redacted: false });
    expect(byPath.passwordHash).toEqual({ path: "passwordHash", type: "string", required: true, secret: true, set: true, status: "set", value: null, redacted: true });
    expect(byPath.bootstrap).toEqual({ path: "bootstrap", type: "object", required: false, secret: false, set: true, status: "set", value: { username: "admin" }, redacted: false });
    expect(byPath["bootstrap.username"]).toEqual({ path: "bootstrap.username", type: "string", required: false, secret: false, set: true, status: "set", value: "admin", redacted: false });
    expect(byPath["bootstrap.token"]).toEqual({ path: "bootstrap.token", type: "string", required: false, secret: true, set: false, status: "default", value: null, redacted: true });
    expect(byPath.kind).toEqual({ path: "kind", type: "union", required: true, secret: false, set: true, status: "set", value: "a", redacted: false });
    expect(byPath.up).toEqual({ path: "up", type: "unknown", required: true, secret: false, set: true, status: "set", value: "[function]", redacted: false });
    expect(byPath.ttl).toEqual({ path: "ttl", type: "number", required: true, secret: false, set: true, status: "set", value: null, redacted: false });
  });

  it("a defaulted object hands its default down: the child is optional and reports the inherited value", () => {
    const nested = z.object({ archive: z.object({ folder: z.string().min(1) }).default({ folder: "old_posts" }) }).strict();
    const byPath = Object.fromEntries(describeConfig(nested, {}).variables.map((v) => [v.path, v]));
    expect(byPath.archive).toEqual({ path: "archive", type: "object", required: false, default: { folder: "old_posts" }, secret: false, set: false, status: "default", value: { folder: "old_posts" }, redacted: false });
    expect(byPath["archive.folder"]).toEqual({ path: "archive.folder", type: "string", required: false, default: "old_posts", secret: false, set: false, status: "default", value: "old_posts", redacted: false });
  });

  it("a spelled-out parent gets no inherited default, an own default still applies", () => {
    const nested = z.object({ archive: z.object({ folder: z.string(), format: z.string().default("zip") }).default({ folder: "old_posts" }) }).strict();
    const byPath = Object.fromEntries(describeConfig(nested, { archive: { folder: "drafts" } }).variables.map((v) => [v.path, v]));
    expect(byPath["archive.folder"]).toEqual({ path: "archive.folder", type: "string", required: false, secret: false, set: true, status: "set", value: "drafts", redacted: false });
    expect(byPath["archive.format"]).toEqual({ path: "archive.format", type: "string", required: false, default: "zip", secret: false, set: false, status: "default", value: "zip", redacted: false });
  });

  it("a required child of an optional object is optional and missing, of a required object required and missing", () => {
    const nested = z
      .object({
        maybe: z.object({ name: z.string() }).optional(),
        always: z.object({ name: z.string() }),
      })
      .strict();
    const byPath = Object.fromEntries(describeConfig(nested, { always: {} }).variables.map((v) => [v.path, v]));
    expect(byPath["maybe.name"]).toEqual({ path: "maybe.name", type: "string", required: false, secret: false, set: false, status: "missing", value: null, redacted: false });
    expect(byPath.always).toEqual({ path: "always", type: "object", required: true, secret: false, set: true, status: "set", value: {}, redacted: false });
    expect(byPath["always.name"]).toEqual({ path: "always.name", type: "string", required: true, secret: false, set: false, status: "missing", value: null, redacted: false });
  });

  it("a top-level default reaches a grandchild the raw config never mentions", () => {
    const nested = z.object({ store: z.object({ archive: z.object({ folder: z.string() }) }).default({ archive: { folder: "old_posts" } }) }).strict();
    const byPath = Object.fromEntries(describeConfig(nested, undefined).variables.map((v) => [v.path, v]));
    expect(byPath["store.archive"]).toMatchObject({ required: false, set: false, status: "default", default: { folder: "old_posts" }, value: { folder: "old_posts" } });
    expect(byPath["store.archive.folder"]).toEqual({ path: "store.archive.folder", type: "string", required: false, default: "old_posts", secret: false, set: false, status: "default", value: "old_posts", redacted: false });
  });

  it("reads the effective value from the parsed config, defaults included", () => {
    const parsed = schema.parse({ file: "./x.db", buckets: { a: { limit: 1 } }, passwordHash: "scrypt$abc", kind: "a", up: () => {}, ttl: null });
    const byPath = Object.fromEntries(describeConfig(schema, { file: "./x.db", buckets: { a: { limit: 1 } }, passwordHash: "scrypt$abc", kind: "a", up: () => {}, ttl: null }, parsed).variables.map((v) => [v.path, v]));
    expect(byPath.port).toMatchObject({ status: "default", value: 3000 });
    expect(byPath.buckets).toMatchObject({ status: "set", value: { a: { limit: 1 } } });
    expect(byPath.passwordHash).toMatchObject({ redacted: true, value: null });
  });

  it("never copies a secret value into the output", () => {
    const out = describeConfig(schema, { file: "/very/public/path.db", passwordHash: "scrypt$topsecret", bootstrap: { username: "admin", token: "hunter2" } });
    const text = JSON.stringify(out);
    expect(text).toContain("/very/public/path.db");
    expect(text).not.toContain("topsecret");
    expect(text).not.toContain("hunter2");
  });

  it("redacts a key that only looks like a credential, and everything below it", () => {
    const nested = z.object({ apiKey: z.string(), store: z.object({ url: z.string() }), credentials: z.object({ user: z.string() }) }).strict();
    const byPath = Object.fromEntries(
      describeConfig(nested, { apiKey: "abc123", store: { url: "postgres://user:pw@db/app" }, credentials: { user: "admin" } }).variables.map((v) => [v.path, v]),
    );
    expect(byPath.apiKey).toMatchObject({ secret: false, redacted: true, value: null });
    expect(byPath["store.url"]).toMatchObject({ redacted: true, value: null });
    expect(byPath.credentials).toMatchObject({ redacted: true, value: null });
    expect(byPath["credentials.user"]).toMatchObject({ redacted: true, value: null });
  });

  it("yields no rows for a non-object schema", () => {
    expect(describeConfig(z.string(), "x").variables).toEqual([]);
  });
});

describe("describeConfig with host-supplied defaults", () => {
  const hosted = z
    .object({
      publicPath: z.string().default("/media"),
      dependencies: z
        .object({
          render: z.enum(["background", "events"]).default("background"),
          maxPerRender: z.number().int().default(1000),
          timeoutSeconds: z.number().int().default(60),
        })
        .strict()
        .default({}),
      backoffSeconds: z.array(z.number()).default([60, 300]),
      reservedPaths: z.array(z.string()).default([]),
      apiToken: z.string().optional(),
    })
    .strict();
  const defaults = { from: "site-preset", values: { publicPath: "/files", dependencies: { render: "events" }, backoffSeconds: [1, 2, 3], apiToken: "host-token-value" } };

  function rows(raw: unknown): Record<string, ReturnType<typeof describeConfig>["variables"][number]> {
    const merged = mergeConfigDefaults(defaults.values, raw);
    return Object.fromEntries(describeConfig(hosted, raw, hosted.parse(merged), defaults).variables.map((v) => [v.path, v]));
  }

  it("reports a host value the config leaves out as a default with its source", () => {
    expect(rows(undefined).publicPath).toEqual({ path: "publicPath", type: "string", required: false, default: "/files", secret: false, set: false, status: "default", source: "site-preset", value: "/files", redacted: false });
  });

  it("marks only the host-supplied child of a nested object with the source", () => {
    const byPath = rows({ dependencies: { timeoutSeconds: 5 } });
    expect(byPath.dependencies).toMatchObject({ set: true, status: "set", value: { render: "events", maxPerRender: 1000, timeoutSeconds: 5 } });
    expect(byPath.dependencies).not.toHaveProperty("source");
    expect(byPath["dependencies.render"]).toMatchObject({ set: false, status: "default", source: "site-preset", default: "events", value: "events" });
    expect(byPath["dependencies.maxPerRender"]).toMatchObject({ set: false, status: "default", default: 1000, value: 1000 });
    expect(byPath["dependencies.maxPerRender"]).not.toHaveProperty("source");
    expect(byPath["dependencies.timeoutSeconds"]).toMatchObject({ set: true, status: "set", value: 5 });
  });

  it("reports a host-supplied parent object as a default with its source", () => {
    const byPath = rows(undefined);
    expect(byPath.dependencies).toMatchObject({ set: false, status: "default", source: "site-preset", value: { render: "events", maxPerRender: 1000, timeoutSeconds: 60 } });
  });

  it("reports a host-supplied array as a default and a configured array as set, replacing it whole", () => {
    expect(rows(undefined).backoffSeconds).toMatchObject({ status: "default", source: "site-preset", default: [1, 2, 3], value: [1, 2, 3] });
    const overridden = rows({ backoffSeconds: [9] }).backoffSeconds;
    expect(overridden).toMatchObject({ set: true, status: "set", value: [9] });
    expect(overridden).not.toHaveProperty("source");
  });

  it("reports a config value that overrides a host default as set, without a source", () => {
    const row = rows({ publicPath: "/assets" }).publicPath;
    expect(row).toMatchObject({ set: true, status: "set", value: "/assets" });
    expect(row).not.toHaveProperty("source");
  });

  it("leaves a path neither the host nor the config mentions to the schema default", () => {
    const row = rows(undefined).reservedPaths;
    expect(row).toMatchObject({ status: "default", default: [], value: [] });
    expect(row).not.toHaveProperty("source");
  });

  it("redacts a host-supplied secret and keeps its source", () => {
    const out = describeConfig(hosted, undefined, hosted.parse(defaults.values), defaults);
    expect(JSON.stringify(out)).not.toContain("host-token-value");
    const row = out.variables.find((v) => v.path === "apiToken");
    expect(row).toEqual({ path: "apiToken", type: "string", required: false, secret: false, set: false, status: "default", source: "site-preset", value: null, redacted: true });
  });
});

describe("mergeConfigDefaults", () => {
  it("merges plain objects deeply, the config winning at every path", () => {
    expect(mergeConfigDefaults({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 4 }, e: 5 })).toEqual({ a: 1, b: { c: 2, d: 4 }, e: 5 });
  });

  it("replaces arrays and scalars whole", () => {
    expect(mergeConfigDefaults({ list: [1, 2], b: { c: 1 } }, { list: [3], b: "flat" })).toEqual({ list: [3], b: "flat" });
  });

  it("keeps an explicit null from the config", () => {
    expect(mergeConfigDefaults({ max: 10 }, { max: null })).toEqual({ max: null });
  });

  it("returns the defaults for an absent config and the config itself when it is not an object", () => {
    expect(mergeConfigDefaults({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(mergeConfigDefaults({ a: 1 }, "raw")).toBe("raw");
  });

  it("leaves both inputs untouched", () => {
    const values = { b: { c: 1 } };
    const config = { b: { d: 2 } };
    mergeConfigDefaults(values, config);
    expect(values).toEqual({ b: { c: 1 } });
    expect(config).toEqual({ b: { d: 2 } });
  });
});
