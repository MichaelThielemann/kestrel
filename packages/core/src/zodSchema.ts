import type { ZodIssue, ZodTypeAny } from "zod";
import { boundaryCast } from "./cast.ts";
import { canHoldSecret, isSecretName, isSecretSchema, isSecretValue, REDACTED, redactCredentialUrls, snapshotValue, type JsonValue } from "./configValue.ts";
import type { JsonSchema } from "./defineModule.ts";
import { isPlainObject } from "./guards.ts";

export type ConfigStatus = "set" | "default" | "missing";

export interface ConfigVariable {
  path: string;
  type: string;
  required: boolean;
  /** The default the path falls back to, as a JSON snapshot redacted like `value`; absent when there is none or the variable is redacted. */
  default?: unknown;
  secret: boolean;
  set: boolean;
  status: ConfigStatus;
  /** The name of the host layer that supplied this default; present only when `status` is `"default"` and the value comes from a module entry's `defaults`. */
  source?: string;
  /** The effective value as a JSON-serialisable snapshot: what the config sets, else the default, `null` when missing or redacted. */
  value: JsonValue;
  /** True when the value is withheld because the schema marks it secret, the key name looks like a credential or an ancestor is redacted. */
  redacted: boolean;
}

/** Config values a host supplies for a module entry as defaults, named after their source. The entry's own `config` wins at every path. */
export interface ConfigDefaults {
  from: string;
  values: Record<string, unknown>;
}

export interface ConfigDescription {
  schema: JsonSchema;
  variables: ConfigVariable[];
}

export const SECRET = "secret";

interface Def {
  typeName?: string;
  description?: string;
  innerType: ZodTypeAny;
  schema: ZodTypeAny;
  type: ZodTypeAny;
  in: ZodTypeAny;
  out?: ZodTypeAny;
  getter: () => ZodTypeAny;
  shape?: () => Record<string, ZodTypeAny>;
  unknownKeys?: string;
  catchall?: ZodTypeAny;
  keyType?: ZodTypeAny;
  valueType: ZodTypeAny;
  values: Record<string, unknown>;
  value?: unknown;
  options?: ZodTypeAny[] | Map<unknown, ZodTypeAny>;
  items?: ZodTypeAny[];
  rest?: ZodTypeAny | null;
  left: ZodTypeAny;
  right: ZodTypeAny;
  checks?: Array<{ kind: string; value?: unknown; regex?: RegExp; inclusive?: boolean }>;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  exactLength?: { value: number } | null;
  defaultValue?: () => unknown;
  effect?: { type: string };
}

interface Unwrapped {
  inner: ZodTypeAny;
  optional: boolean;
  nullable: boolean;
  reshapes: boolean;
  defaultValue?: () => unknown;
  description?: string;
}

const def = (schema: ZodTypeAny): Def => boundaryCast<Def>(schema._def, "host");
const kind = (schema: ZodTypeAny): string => def(schema).typeName ?? "";

function unwrap(schema: ZodTypeAny): Unwrapped {
  const out: Unwrapped = { inner: schema, optional: false, nullable: false, reshapes: false };
  let current = schema;
  for (;;) {
    const d = def(current);
    if (d.description !== undefined && out.description === undefined) out.description = d.description;
    const name = d.typeName;
    if (name === "ZodOptional") {
      out.optional = true;
      current = d.innerType;
    } else if (name === "ZodDefault") {
      out.optional = true;
      if (out.defaultValue === undefined && d.defaultValue !== undefined) out.defaultValue = d.defaultValue;
      current = d.innerType;
    } else if (name === "ZodNullable") {
      out.nullable = true;
      current = d.innerType;
    } else if (name === "ZodCatch") {
      current = d.innerType;
    } else if (name === "ZodEffects") {
      if (d.effect?.type !== "refinement") out.reshapes = true;
      current = d.schema;
    } else if (name === "ZodBranded") {
      current = d.type;
    } else if (name === "ZodPipeline") {
      out.reshapes = true;
      current = d.in;
    } else if (name === "ZodLazy") {
      current = d.getter();
    } else {
      break;
    }
  }
  out.inner = current;
  return out;
}

function stringSchema(d: Def): JsonSchema {
  const out: JsonSchema = { type: "string" };
  for (const check of d.checks ?? []) {
    if (check.kind === "min") out.minLength = check.value;
    else if (check.kind === "max") out.maxLength = check.value;
    else if (check.kind === "length") out.minLength = out.maxLength = check.value;
    else if (check.kind === "regex" && check.regex) out.pattern = check.regex.source;
    else if (check.kind === "startsWith") out.pattern = `^${escapeRegex(String(check.value))}`;
    else if (check.kind === "endsWith") out.pattern = `${escapeRegex(String(check.value))}$`;
    else if (["email", "url", "uuid", "date", "datetime", "time", "ip", "cidr"].includes(check.kind)) out.format = check.kind === "datetime" ? "date-time" : check.kind;
  }
  return out;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberSchema(d: Def): JsonSchema {
  const checks = d.checks ?? [];
  const out: JsonSchema = { type: checks.some((c) => c.kind === "int") ? "integer" : "number" };
  for (const check of checks) {
    if (check.kind === "min") out[check.inclusive === false ? "exclusiveMinimum" : "minimum"] = check.value;
    else if (check.kind === "max") out[check.inclusive === false ? "exclusiveMaximum" : "maximum"] = check.value;
    else if (check.kind === "multipleOf") out.multipleOf = check.value;
  }
  return out;
}

function optionsOf(d: Def): ZodTypeAny[] {
  const options = d.options;
  if (options instanceof Map) return [...options.values()];
  return options ?? [];
}

function objectSchema(d: Def): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(d.shape?.() ?? {})) {
    const property = toJsonSchema(child);
    if (isSecretName(key) && canHoldSecret(typeOf(unwrap(child).inner))) delete property.default;
    properties[key] = property;
    if (!unwrap(child).optional) required.push(key);
  }
  const out: JsonSchema = { type: "object", properties };
  if (required.length > 0) out.required = required;
  if (d.unknownKeys === "strict") out.additionalProperties = false;
  else if (d.unknownKeys === "passthrough") out.additionalProperties = true;
  else if (d.catchall !== undefined && kind(d.catchall) !== "ZodNever") out.additionalProperties = toJsonSchema(d.catchall);
  return out;
}

function bareSchema(schema: ZodTypeAny): JsonSchema {
  const d = def(schema);
  switch (d.typeName) {
    case "ZodString":
      return stringSchema(d);
    case "ZodNumber":
      return numberSchema(d);
    case "ZodBigInt":
      return { type: "integer" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodDate":
      return { type: "string", format: "date-time" };
    case "ZodNull":
      return { type: "null" };
    case "ZodLiteral":
      return { const: d.value };
    case "ZodEnum":
      return { type: "string", enum: d.values };
    case "ZodNativeEnum": {
      const values = Object.values(d.values);
      const numeric = values.filter((v) => typeof v === "number");
      return { enum: numeric.length > 0 ? numeric : values };
    }
    case "ZodArray": {
      const out: JsonSchema = { type: "array", items: toJsonSchema(d.type) };
      if (d.minLength) out.minItems = d.minLength.value;
      if (d.maxLength) out.maxItems = d.maxLength.value;
      if (d.exactLength) out.minItems = out.maxItems = d.exactLength.value;
      return out;
    }
    case "ZodTuple": {
      const out: JsonSchema = { type: "array", prefixItems: (d.items ?? []).map(toJsonSchema) };
      if (d.rest) out.items = toJsonSchema(d.rest);
      return out;
    }
    case "ZodObject":
      return objectSchema(d);
    case "ZodRecord":
      return { type: "object", additionalProperties: toJsonSchema(d.valueType) };
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return { anyOf: optionsOf(d).map(toJsonSchema) };
    case "ZodIntersection":
      return { allOf: [toJsonSchema(d.left), toJsonSchema(d.right)] };
    default:
      return {};
  }
}

export function toJsonSchema(schema: ZodTypeAny): JsonSchema {
  const { inner, nullable, defaultValue, description } = unwrap(schema);
  const secret = isSecretNode(schema);
  let out = bareSchema(inner);
  if (nullable) out = { anyOf: [out, { type: "null" }] };
  if (defaultValue && !secret) out = { ...out, default: redactedSnapshot(inner, defaultValue()) };
  if (description !== undefined && description !== SECRET) out = { ...out, description };
  if (secret) out = { ...out, writeOnly: true };
  return out;
}

const MAX_REDACT_DEPTH = 8;

function isSecretField(key: string, child: ZodTypeAny): boolean {
  return isSecretSchema(toJsonSchema(child)) || (isSecretName(key) && canHoldSecret(typeOf(unwrap(child).inner)));
}

function assign(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function containsSecret(schema: ZodTypeAny, depth: number): boolean {
  if (depth > MAX_REDACT_DEPTH) return true;
  const d = def(schema);
  if (d.description === SECRET) return true;
  const next = (child: ZodTypeAny | null | undefined): boolean => child !== undefined && child !== null && containsSecret(child, depth + 1);
  switch (d.typeName) {
    case "ZodOptional":
    case "ZodDefault":
    case "ZodNullable":
    case "ZodCatch":
      return next(d.innerType);
    case "ZodEffects":
      return next(d.schema);
    case "ZodBranded":
      return next(d.type);
    case "ZodPipeline":
      return next(d.in) || next(d.out);
    case "ZodLazy":
      return next(d.getter());
    case "ZodObject":
      return Object.entries(d.shape?.() ?? {}).some(([key, child]) => (isSecretName(key) && canHoldSecret(typeOf(unwrap(child).inner))) || next(child)) || next(d.catchall);
    case "ZodRecord":
      return next(d.valueType);
    case "ZodArray":
      return next(d.type);
    case "ZodTuple":
      return (d.items ?? []).some((item) => next(item)) || next(d.rest);
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return optionsOf(d).some((option) => next(option));
    case "ZodIntersection":
      return next(d.left) || next(d.right);
    default:
      return false;
  }
}

function isSecretNode(schema: ZodTypeAny): boolean {
  const { description, reshapes } = unwrap(schema);
  return description === SECRET || (reshapes && containsSecret(schema, 0));
}

function redactEntries(value: Record<string, unknown>, childOf: (key: string) => ZodTypeAny | undefined, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const child = childOf(key);
    const secret = child === undefined ? isSecretName(key) && canHoldSecret(typeof item) : isSecretField(key, child);
    assign(out, key, secret ? REDACTED : child === undefined ? item : redactSecrets(child, item, depth + 1));
  }
  return out;
}

function redactSecrets(schema: ZodTypeAny, value: unknown, depth: number): unknown {
  if (value === undefined || value === null) return value;
  if (isSecretNode(schema)) return REDACTED;
  if (depth > MAX_REDACT_DEPTH) return REDACTED;
  const { inner } = unwrap(schema);
  const d = def(inner);
  switch (kind(inner)) {
    case "ZodObject": {
      if (!isPlainObject(value)) return value;
      const shape = d.shape?.() ?? {};
      const catchall = d.catchall !== undefined && kind(d.catchall) !== "ZodNever" ? d.catchall : undefined;
      return redactEntries(value, (key) => (Object.hasOwn(shape, key) ? shape[key] : catchall), depth);
    }
    case "ZodRecord":
      return isPlainObject(value) ? redactEntries(value, () => d.valueType, depth) : value;
    case "ZodArray":
      return Array.isArray(value) ? value.map((item: unknown) => redactSecrets(d.type, item, depth + 1)) : value;
    case "ZodTuple": {
      if (!Array.isArray(value)) return value;
      const items = d.items ?? [];
      return value.map((item: unknown, i) => {
        const element = items[i] ?? d.rest ?? undefined;
        return element === undefined ? item : redactSecrets(element, item, depth + 1);
      });
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return optionsOf(d).reduce<unknown>((current, option) => redactSecrets(option, current, depth + 1), value);
    case "ZodIntersection":
      return redactSecrets(d.right, redactSecrets(d.left, value, depth + 1), depth + 1);
    default:
      return value;
  }
}

function childAt(schema: ZodTypeAny, key: string | number): ZodTypeAny | undefined {
  const { inner } = unwrap(schema);
  const d = def(inner);
  switch (kind(inner)) {
    case "ZodObject": {
      const shape = d.shape?.() ?? {};
      if (typeof key === "string" && Object.hasOwn(shape, key)) return shape[key];
      return d.catchall !== undefined && kind(d.catchall) !== "ZodNever" ? d.catchall : undefined;
    }
    case "ZodRecord":
      return d.valueType;
    case "ZodArray":
      return d.type;
    case "ZodTuple":
      return (typeof key === "number" ? d.items?.[key] : undefined) ?? d.rest ?? undefined;
    default:
      return undefined;
  }
}

function isSecretPath(schema: ZodTypeAny, path: ReadonlyArray<string | number>): boolean {
  let node: ZodTypeAny | undefined = schema;
  for (const key of path) {
    if (node === undefined) return false;
    if (isSecretNode(node)) return true;
    const kindName = kind(unwrap(node).inner);
    if (kindName === "ZodUnion" || kindName === "ZodDiscriminatedUnion" || kindName === "ZodIntersection") return true;
    if (typeof key === "string" && isSecretName(key)) return true;
    node = childAt(node, key);
  }
  return node !== undefined && isSecretNode(node);
}

/**
 * One line per config validation problem that never repeats the value it received: a secret path
 * (a secret schema node, a credential-like key or a path through a union) reports only the issue
 * code, an enum mismatch only what it expected, and any other message has its credential URLs redacted.
 */
export function describeConfigIssue(schema: ZodTypeAny, issue: ZodIssue): string {
  const where = issue.path.join(".") || "(root)";
  if (isSecretPath(schema, issue.path)) return `${where}: ${issue.code}`;
  if (issue.code === "invalid_enum_value") return `${where}: Invalid enum value. Expected ${issue.options.map((o) => `'${String(o)}'`).join(" | ")}`;
  return `${where}: ${redactCredentialUrls(issue.message)}`;
}

function redactedSnapshot(schema: ZodTypeAny, value: unknown): JsonValue {
  return snapshotValue(redactSecrets(schema, value, 0));
}

function typeOf(schema: ZodTypeAny): string {
  switch (kind(schema)) {
    case "ZodString":
    case "ZodDate":
      return "string";
    case "ZodNumber":
      return (def(schema).checks ?? []).some((c) => c.kind === "int") ? "integer" : "number";
    case "ZodBigInt":
      return "integer";
    case "ZodBoolean":
      return "boolean";
    case "ZodArray":
    case "ZodTuple":
      return "array";
    case "ZodObject":
      return "object";
    case "ZodRecord":
      return "record";
    case "ZodEnum":
    case "ZodNativeEnum":
      return "enum";
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return "union";
    case "ZodLiteral":
      return "literal";
    case "ZodFunction":
      return "function";
    default:
      return "unknown";
  }
}

function valueAt(raw: unknown, path: string[]): unknown {
  let current = raw;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/**
 * `config` laid over `values`: plain objects merge key by key, every other value — arrays included —
 * replaces the default whole. An absent `config` yields the defaults; a `config` that is not a plain
 * object replaces them. Neither input is modified.
 */
export function mergeConfigDefaults(values: unknown, config: unknown): unknown {
  if (config === undefined) return values;
  if (!isPlainObject(values) || !isPlainObject(config)) return config;
  const out: Record<string, unknown> = { ...values };
  for (const [key, value] of Object.entries(config)) Object.defineProperty(out, key, { value: mergeConfigDefaults(values[key], value), enumerable: true, writable: true, configurable: true });
  return out;
}

/** The config a module entry's module is set up with: `config` laid over `defaults.values`, or `config` alone when the entry has no defaults. */
export function effectiveModuleConfig(entry: { config?: unknown; defaults?: ConfigDefaults | undefined }): unknown {
  return entry.defaults === undefined ? entry.config : mergeConfigDefaults(entry.defaults.values, entry.config);
}

function hostValueAt(defaults: ConfigDefaults | undefined, raw: unknown, path: string[]): unknown {
  if (defaults === undefined) return undefined;
  let host: unknown = defaults.values;
  let own: unknown = raw;
  for (const key of path) {
    if (own !== undefined && !isPlainObject(own)) return undefined;
    if (!isPlainObject(host)) return undefined;
    host = host[key];
    own = own === undefined ? undefined : own[key];
  }
  return host;
}

interface Ancestors {
  optional: boolean;
  default: unknown;
  redacted: boolean;
}

function collectVariables(schema: ZodTypeAny, raw: unknown, parsedInput: unknown, defaults: ConfigDefaults | undefined, path: string[], out: ConfigVariable[], ancestors: Ancestors): void {
  const { inner, reshapes } = unwrap(schema);
  const parsed = reshapes ? undefined : parsedInput;
  if (kind(inner) !== "ZodObject") return;
  const inherited = valueAt(raw, path) === undefined ? ancestors.default : undefined;
  for (const [key, child] of Object.entries(def(inner).shape?.() ?? {})) {
    const childPath = [...path, key];
    const unwrapped = unwrap(child);
    const secret = isSecretSchema(toJsonSchema(child));
    const rawValue = valueAt(raw, childPath);
    const set = rawValue !== undefined;
    const hostValue = hostValueAt(defaults, raw, childPath);
    const fromAncestor = valueAt(inherited, [key]);
    const effective = hostValue !== undefined ? hostValue : fromAncestor === undefined ? unwrapped.defaultValue?.() : fromAncestor;
    const optional = ancestors.optional || unwrapped.optional;
    const status: ConfigStatus = set ? "set" : effective === undefined ? "missing" : "default";
    const parsedValue = valueAt(parsed, childPath);
    const configured = parsedValue !== undefined ? parsedValue : set ? rawValue : effective;
    const type = typeOf(unwrapped.inner);
    const redacted = secret || ancestors.redacted || (isSecretName(key) && canHoldSecret(type)) || isSecretValue(configured);
    const variable: ConfigVariable = { path: childPath.join("."), type, required: !optional, secret, set, status, value: redacted ? null : redactedSnapshot(child, configured), redacted };
    if (!set && hostValue !== undefined && defaults !== undefined) variable.source = defaults.from;
    if (effective !== undefined && !redacted) variable.default = redactedSnapshot(child, effective);
    out.push(variable);
    if (kind(unwrapped.inner) === "ZodObject") collectVariables(child, raw, parsed, defaults, childPath, out, { optional, default: effective, redacted });
  }
}

/**
 * JSON Schema plus one row per config path. `raw` is the consumer's entry before parsing and decides
 * `set`/`status`; `parsed` is the same entry after the schema applied its defaults and is the source
 * of the effective `value` — without it the value falls back to `raw` and the declared defaults.
 * Below a `transform`, `preprocess` or `pipe` the parsed output no longer lines up with the schema,
 * so the rows there read `raw` and the declared defaults.
 * `defaults` is the host layer merged under `raw`: a path it carries and `raw` does not is a
 * `"default"` with `source` set to `defaults.from`, ahead of any default the schema declares.
 */
export function describeConfig(schema: ZodTypeAny, raw: unknown, parsed?: unknown, defaults?: ConfigDefaults): ConfigDescription {
  const variables: ConfigVariable[] = [];
  collectVariables(schema, raw, parsed, defaults, [], variables, { optional: false, default: undefined, redacted: false });
  return { schema: toJsonSchema(schema), variables };
}
