import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boundaryCast } from "./cast.ts";
import { describeConfig, toJsonSchema } from "./zodSchema.ts";

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

  it("keeps the secret marker and secret defaults out of the schema", () => {
    const props = boundaryCast<Record<string, Record<string, unknown>>>(toJsonSchema(schema).properties, "json");
    expect(props.passwordHash).toEqual({ type: "string", pattern: "^scrypt\\$" });
    const bootstrap = boundaryCast<Record<string, unknown>>(props.bootstrap?.properties, "json");
    expect(bootstrap.token).toEqual({ type: "string" });
    expect(JSON.stringify(toJsonSchema(schema))).not.toContain("secret");
  });

  it("carries a plain description through", () => {
    expect(toJsonSchema(z.string().describe("the file"))).toEqual({ type: "string", description: "the file" });
  });
});

describe("describeConfig", () => {
  it("lists one row per path with type, required, default, secret, set and status", () => {
    const { variables } = describeConfig(schema, { file: "./x.db", buckets: {}, passwordHash: "scrypt$abc", bootstrap: { username: "admin" }, kind: "a", up: () => {}, ttl: null });
    const byPath = Object.fromEntries(variables.map((v) => [v.path, v]));
    expect(byPath.file).toEqual({ path: "file", type: "string", required: true, secret: false, set: true, status: "set" });
    expect(byPath.port).toEqual({ path: "port", type: "integer", required: false, default: 3000, secret: false, set: false, status: "default" });
    expect(byPath.mode).toEqual({ path: "mode", type: "enum", required: false, default: "apply", secret: false, set: false, status: "default" });
    expect(byPath.tags).toEqual({ path: "tags", type: "array", required: false, secret: false, set: false, status: "missing" });
    expect(byPath.buckets).toEqual({ path: "buckets", type: "record", required: true, secret: false, set: true, status: "set" });
    expect(byPath.passwordHash).toEqual({ path: "passwordHash", type: "string", required: true, secret: true, set: true, status: "set" });
    expect(byPath.bootstrap).toEqual({ path: "bootstrap", type: "object", required: false, secret: false, set: true, status: "set" });
    expect(byPath["bootstrap.username"]).toEqual({ path: "bootstrap.username", type: "string", required: false, secret: false, set: true, status: "set" });
    expect(byPath["bootstrap.token"]).toEqual({ path: "bootstrap.token", type: "string", required: false, secret: true, set: false, status: "default" });
    expect(byPath.kind).toEqual({ path: "kind", type: "union", required: true, secret: false, set: true, status: "set" });
    expect(byPath.up).toEqual({ path: "up", type: "unknown", required: true, secret: false, set: true, status: "set" });
    expect(byPath.ttl).toEqual({ path: "ttl", type: "number", required: true, secret: false, set: true, status: "set" });
  });

  it("a defaulted object hands its default down: the child is optional and reports the inherited value", () => {
    const nested = z.object({ media: z.object({ collection: z.string().min(1) }).default({ collection: "media_items" }) }).strict();
    const byPath = Object.fromEntries(describeConfig(nested, {}).variables.map((v) => [v.path, v]));
    expect(byPath.media).toEqual({ path: "media", type: "object", required: false, default: { collection: "media_items" }, secret: false, set: false, status: "default" });
    expect(byPath["media.collection"]).toEqual({ path: "media.collection", type: "string", required: false, default: "media_items", secret: false, set: false, status: "default" });
  });

  it("a spelled-out parent gets no inherited default, an own default still applies", () => {
    const nested = z.object({ media: z.object({ collection: z.string(), locale: z.string().default("de") }).default({ collection: "media_items" }) }).strict();
    const byPath = Object.fromEntries(describeConfig(nested, { media: { collection: "assets" } }).variables.map((v) => [v.path, v]));
    expect(byPath["media.collection"]).toEqual({ path: "media.collection", type: "string", required: false, secret: false, set: true, status: "set" });
    expect(byPath["media.locale"]).toEqual({ path: "media.locale", type: "string", required: false, default: "de", secret: false, set: false, status: "default" });
  });

  it("a required child of an optional object is optional and missing, of a required object required and missing", () => {
    const nested = z
      .object({
        maybe: z.object({ token: z.string() }).optional(),
        always: z.object({ token: z.string() }),
      })
      .strict();
    const byPath = Object.fromEntries(describeConfig(nested, { always: {} }).variables.map((v) => [v.path, v]));
    expect(byPath["maybe.token"]).toEqual({ path: "maybe.token", type: "string", required: false, secret: false, set: false, status: "missing" });
    expect(byPath.always).toEqual({ path: "always", type: "object", required: true, secret: false, set: true, status: "set" });
    expect(byPath["always.token"]).toEqual({ path: "always.token", type: "string", required: true, secret: false, set: false, status: "missing" });
  });

  it("a top-level default reaches a grandchild the raw config never mentions", () => {
    const nested = z.object({ store: z.object({ media: z.object({ collection: z.string() }) }).default({ media: { collection: "media_items" } }) }).strict();
    const byPath = Object.fromEntries(describeConfig(nested, undefined).variables.map((v) => [v.path, v]));
    expect(byPath["store.media"]).toMatchObject({ required: false, set: false, status: "default", default: { collection: "media_items" } });
    expect(byPath["store.media.collection"]).toEqual({ path: "store.media.collection", type: "string", required: false, default: "media_items", secret: false, set: false, status: "default" });
  });

  it("never copies a value into the output", () => {
    const out = describeConfig(schema, { file: "/very/secret/path.db", passwordHash: "scrypt$topsecret" });
    const text = JSON.stringify(out);
    expect(text).not.toContain("/very/secret/path.db");
    expect(text).not.toContain("topsecret");
  });

  it("yields no rows for a non-object schema", () => {
    expect(describeConfig(z.string(), "x").variables).toEqual([]);
  });
});
