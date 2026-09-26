import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boundaryCast } from "./cast.ts";
import { describeConfig, effectiveModuleConfig, mergeConfigDefaults, toJsonSchema } from "./zodSchema.ts";

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

  it("stops reporting host values below a parent the config replaces with a non-object", () => {
    const nullable = z.object({ dep: z.object({ render: z.string().default("background") }).strict().nullable().default({}) }).strict();
    const hostDefaults = { from: "site-preset", values: { dep: { render: "events" } } };
    const raw = { dep: null };
    const byPath = Object.fromEntries(describeConfig(nullable, raw, nullable.parse(mergeConfigDefaults(hostDefaults.values, raw)), hostDefaults).variables.map((v) => [v.path, v]));
    expect(byPath.dep).toMatchObject({ set: true, status: "set", value: null });
    expect(byPath["dep.render"]).not.toHaveProperty("source");
    expect(byPath["dep.render"]?.default).not.toBe("events");
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

  it("lets a config object replace a default that is not a plain object", () => {
    const when = new Date(0);
    expect(mergeConfigDefaults({ at: when, link: new URL("https://example.org/") }, { at: { day: 1 }, link: { host: "a" } })).toEqual({ at: { day: 1 }, link: { host: "a" } });
    expect(mergeConfigDefaults({ at: { day: 1 } }, { at: when })).toEqual({ at: when });
  });

  it("copies a __proto__ key as a plain property and leaves the prototype alone", () => {
    const config: unknown = JSON.parse('{ "__proto__": { "polluted": true }, "a": 1 }');
    const merged = mergeConfigDefaults({ b: 2 }, config);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.keys(boundaryCast<object>(merged, "host"))).toEqual(["b", "__proto__", "a"]);
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });

  it("leaves both inputs untouched", () => {
    const values = { b: { c: 1 } };
    const config = { b: { d: 2 } };
    mergeConfigDefaults(values, config);
    expect(values).toEqual({ b: { c: 1 } });
    expect(config).toEqual({ b: { d: 2 } });
  });
});

describe("effectiveModuleConfig", () => {
  it("is the config alone for an entry without defaults", () => {
    const config = { a: 1 };
    expect(effectiveModuleConfig({ config })).toBe(config);
    expect(effectiveModuleConfig({})).toBeUndefined();
  });

  it("lays the config over the defaults' values", () => {
    expect(effectiveModuleConfig({ config: { b: { c: 2 } }, defaults: { from: "site-preset", values: { a: 1, b: { d: 3 } } } })).toEqual({ a: 1, b: { d: 3, c: 2 } });
  });
});

describe("secrets nested in a default", () => {
  const nested = z
    .object({
      bootstrap: z
        .object({ username: z.string(), passwordHash: z.string(), signing: z.string().describe("secret") })
        .strict()
        .default({ username: "admin", passwordHash: "scrypt$schema-default-hash", signing: "schema-default-signing" }),
      store: z.object({ url: z.string() }).strict().optional(),
      tenants: z.record(z.object({ apiSeed: z.string().describe("secret") }).strict()).default({ one: { apiSeed: "schema-default-seed" } }),
    })
    .strict();

  it("never puts a secret from a schema default into the rows or the schema", () => {
    const text = JSON.stringify(describeConfig(nested, {}, nested.parse({})));
    expect(text).not.toContain("schema-default-hash");
    expect(text).not.toContain("schema-default-signing");
    expect(text).not.toContain("schema-default-seed");
    expect(text).toContain("admin");
  });

  it("never puts a secret from host-supplied defaults into the rows", () => {
    const defaults = { from: "site-preset", values: { bootstrap: { username: "host-admin", passwordHash: "scrypt$host-default-hash", signing: "host-default-signing" }, store: { url: "postgres://app:host-db-pass@db/app" }, tenants: { two: { apiSeed: "host-default-seed" } } } };
    const merged = mergeConfigDefaults(defaults.values, {});
    const out = describeConfig(nested, {}, nested.parse(merged), defaults);
    const text = JSON.stringify(out);
    for (const secret of ["host-default-hash", "host-default-signing", "host-db-pass", "host-default-seed"]) expect(text).not.toContain(secret);
    const bootstrap = out.variables.find((v) => v.path === "bootstrap");
    expect(bootstrap).toMatchObject({ status: "default", source: "site-preset", default: { username: "host-admin", passwordHash: "[redacted]", signing: "[redacted]" }, value: { username: "host-admin", passwordHash: "[redacted]", signing: "[redacted]" } });
  });

  it("redacts a schema-marked secret inside a configured parent's value", () => {
    const text = JSON.stringify(describeConfig(nested, { bootstrap: { username: "a", passwordHash: "scrypt$x", signing: "configured-signing" } }));
    expect(text).not.toContain("configured-signing");
  });
});

describe("secrets reachable anywhere in a config", () => {
  function emitted(schema: z.ZodTypeAny, raw: unknown): string {
    return JSON.stringify(describeConfig(schema, raw, schema.parse(raw)));
  }

  it("keeps the default of a secret-named leaf out of the JSON Schema, at the top and nested", () => {
    const schema = z.object({ apiKey: z.string().default("leaf-default-key"), db: z.object({ password: z.string().default("leaf-default-pass") }).strict().default({}) }).strict();
    const text = emitted(schema, {});
    expect(text).not.toContain("leaf-default-key");
    expect(text).not.toContain("leaf-default-pass");
  });

  it("redacts secret elements of records, arrays and tuples, configured or defaulted", () => {
    const secretString = z.string().describe("secret");
    const schema = z
      .object({
        byName: z.record(secretString).default({ a: "record-default-secret" }),
        list: z.array(secretString).default(["array-default-secret"]),
        pair: z.tuple([z.string(), secretString]).default(["visible-first", "tuple-default-secret"]),
      })
      .strict();
    const defaulted = emitted(schema, {});
    for (const secret of ["record-default-secret", "array-default-secret", "tuple-default-secret"]) expect(defaulted).not.toContain(secret);
    expect(defaulted).toContain("visible-first");
    const configured = emitted(schema, { byName: { b: "record-set-secret" }, list: ["array-set-secret"], pair: ["x", "tuple-set-secret"] });
    for (const secret of ["record-set-secret", "array-set-secret", "tuple-set-secret"]) expect(configured).not.toContain(secret);
  });

  it("redacts a secret field inside arrays of objects and under a catchall", () => {
    const schema = z
      .object({
        users: z.array(z.object({ name: z.string(), pin: z.string().describe("secret") }).strict()).default([{ name: "visible-user", pin: "array-object-secret" }]),
        extra: z.object({}).catchall(z.string().describe("secret")).default({ anything: "catchall-default-secret" }),
      })
      .strict();
    const defaulted = emitted(schema, {});
    expect(defaulted).not.toContain("array-object-secret");
    expect(defaulted).not.toContain("catchall-default-secret");
    expect(defaulted).toContain("visible-user");
    const configured = emitted(schema, { users: [{ name: "u", pin: "array-object-set" }], extra: { other: "catchall-set-secret" } });
    expect(configured).not.toContain("array-object-set");
    expect(configured).not.toContain("catchall-set-secret");
  });

  it("redacts a secret field of any union, discriminated union or intersection member, configured or defaulted", () => {
    const withPass = z.object({ kind: z.literal("basic"), pass: z.string().describe("secret") }).strict();
    const withNothing = z.object({ kind: z.literal("none") }).strict();
    const schema = z
      .object({
        either: z.union([withNothing, withPass]).default({ kind: "basic", pass: "union-default-secret" }),
        tagged: z.discriminatedUnion("kind", [withNothing, withPass]).default({ kind: "basic", pass: "tagged-default-secret" }),
        both: z.intersection(z.object({ user: z.string() }), z.object({ pin: z.string().describe("secret") })).default({ user: "visible-both", pin: "intersection-default-secret" }),
      })
      .strict();
    const defaulted = emitted(schema, {});
    for (const secret of ["union-default-secret", "tagged-default-secret", "intersection-default-secret"]) expect(defaulted).not.toContain(secret);
    expect(defaulted).toContain("visible-both");
    const configured = emitted(schema, { either: { kind: "basic", pass: "union-set-secret" }, tagged: { kind: "basic", pass: "tagged-set-secret" }, both: { user: "u", pin: "intersection-set-secret" } });
    for (const secret of ["union-set-secret", "tagged-set-secret", "intersection-set-secret"]) expect(configured).not.toContain(secret);
  });

  it("does not redact plain settings next to secrets", () => {
    const schema = z.object({ bootstrap: z.object({ username: z.string(), minPasswordLength: z.number(), keyName: z.string() }).strict() }).strict();
    expect(emitted(schema, { bootstrap: { username: "admin", minPasswordLength: 12, keyName: "main" } })).toContain('"value":{"username":"admin","minPasswordLength":12,"keyName":"main"}');
  });
});

describe("secrets behind a wrapper that changes the value", () => {
  function emitted(schema: z.ZodTypeAny, raw: unknown): string {
    return JSON.stringify(describeConfig(schema, raw, schema.parse(raw)));
  }

  it("redacts the whole output of a transform over a secret field", () => {
    const schema = z.object({ outer: z.object({ creds: z.string().describe("secret") }).strict().transform((o) => ({ c: o.creds })) }).strict();
    expect(emitted(schema, { outer: { creds: "transform-secret" } })).not.toContain("transform-secret");
  });

  it("redacts a pipe into a secret schema and marks it secret in the JSON Schema", () => {
    const schema = z.object({ piped: z.string().pipe(z.string().describe("secret")) }).strict();
    const out = describeConfig(schema, { piped: "pipe-secret" }, schema.parse({ piped: "pipe-secret" }));
    expect(JSON.stringify(out)).not.toContain("pipe-secret");
    expect(out.variables.find((v) => v.path === "piped")).toMatchObject({ secret: true, redacted: true, value: null });
  });

  it("redacts a preprocess over a credential-like key", () => {
    const schema = z.object({ conn: z.preprocess((v) => v, z.object({ password: z.string() }).strict()).transform((o) => ({ p: o.password })) }).strict();
    expect(emitted(schema, { conn: { password: "preprocess-secret" } })).not.toContain("preprocess-secret");
  });

  it("sees through refine and superRefine, which keep the value as it is", () => {
    const schema = z
      .object({
        refined: z.object({ user: z.string(), pin: z.string().describe("secret") }).strict().refine(() => true),
        checked: z.object({ user: z.string(), pin: z.string().describe("secret") }).strict().superRefine(() => {}),
      })
      .strict();
    const text = emitted(schema, { refined: { user: "refined-user", pin: "refine-secret" }, checked: { user: "checked-user", pin: "superrefine-secret" } });
    expect(text).not.toContain("refine-secret");
    expect(text).not.toContain("superrefine-secret");
    expect(text).toContain("refined-user");
    expect(text).toContain("checked-user");
  });
});
