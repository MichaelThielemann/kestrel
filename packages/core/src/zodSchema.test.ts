import { describe, expect, it } from "vitest";
import { z } from "zod";
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
    const props = out.properties as Record<string, Record<string, unknown>>;
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
    const props = toJsonSchema(schema).properties as Record<string, Record<string, unknown>>;
    expect(props.passwordHash).toEqual({ type: "string", pattern: "^scrypt\\$" });
    const bootstrap = props.bootstrap!.properties as Record<string, unknown>;
    expect(bootstrap.token).toEqual({ type: "string" });
    expect(JSON.stringify(toJsonSchema(schema))).not.toContain("secret");
  });

  it("carries a plain description through", () => {
    expect(toJsonSchema(z.string().describe("the file"))).toEqual({ type: "string", description: "the file" });
  });
});

describe("describeConfig", () => {
  it("lists one row per path with type, required, default, secret and set", () => {
    const { variables } = describeConfig(schema, { file: "./x.db", buckets: {}, passwordHash: "scrypt$abc", bootstrap: { username: "admin" }, kind: "a", up: () => {}, ttl: null });
    const byPath = Object.fromEntries(variables.map((v) => [v.path, v]));
    expect(byPath.file).toEqual({ path: "file", type: "string", required: true, secret: false, set: true });
    expect(byPath.port).toEqual({ path: "port", type: "integer", required: false, default: 3000, secret: false, set: false });
    expect(byPath.mode).toEqual({ path: "mode", type: "enum", required: false, default: "apply", secret: false, set: false });
    expect(byPath.tags).toEqual({ path: "tags", type: "array", required: false, secret: false, set: false });
    expect(byPath.buckets).toEqual({ path: "buckets", type: "record", required: true, secret: false, set: true });
    expect(byPath.passwordHash).toEqual({ path: "passwordHash", type: "string", required: true, secret: true, set: true });
    expect(byPath.bootstrap).toEqual({ path: "bootstrap", type: "object", required: false, secret: false, set: true });
    expect(byPath["bootstrap.username"]).toEqual({ path: "bootstrap.username", type: "string", required: true, secret: false, set: true });
    expect(byPath["bootstrap.token"]).toEqual({ path: "bootstrap.token", type: "string", required: false, secret: true, set: false });
    expect(byPath.kind).toEqual({ path: "kind", type: "union", required: true, secret: false, set: true });
    expect(byPath.up).toEqual({ path: "up", type: "unknown", required: true, secret: false, set: true });
    expect(byPath.ttl).toEqual({ path: "ttl", type: "number", required: true, secret: false, set: true });
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
