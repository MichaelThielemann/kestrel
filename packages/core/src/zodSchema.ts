import { globalRegistry, type core } from "zod";
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

type Schema = core.$ZodType;
type Def = core.$ZodTypes["_zod"]["def"];

interface CheckDef {
  check: string;
  format?: string;
  pattern?: RegExp;
  prefix?: string;
  suffix?: string;
  minimum?: number;
  maximum?: number;
  length?: number;
  value?: unknown;
  inclusive?: boolean;
}

interface Unwrapped {
  inner: Schema;
  optional: boolean;
  nullable: boolean;
  reshapes: boolean;
  defaultValue?: () => unknown;
  defaultKind?: "default" | "prefault";
  description?: string;
  lazies: Schema[];
}

const MIN_ZOD: readonly [number, number, number] = [4, 6, 6];

function zodVersionOf(internals: unknown): [number, number, number] | undefined {
  const version: unknown = typeof internals === "object" && internals !== null ? Reflect.get(internals, "version") : undefined;
  if (typeof version !== "object" || version === null) return undefined;
  const major: unknown = Reflect.get(version, "major");
  const minor: unknown = Reflect.get(version, "minor");
  const patch: unknown = Reflect.get(version, "patch");
  return typeof major === "number" && typeof minor === "number" && typeof patch === "number" ? [major, minor, patch] : undefined;
}

function nodeProblem(internals: unknown): string | undefined {
  if (internals === undefined) return "is not a zod 4 schema";
  const version = zodVersionOf(internals);
  if (version === undefined) return "was built with a zod copy that reports no version";
  const [major, minor, patch] = version;
  const atLeast = major === MIN_ZOD[0] && (minor - MIN_ZOD[1] || patch - MIN_ZOD[2]) >= 0;
  return atLeast ? undefined : `was built with zod ${major}.${minor}.${patch}`;
}

const WRAPPER_TYPES = new Set(["optional", "nullable", "default", "prefault", "nonoptional", "catch", "readonly", "success", "promise"]);

function field(d: object, key: string): unknown {
  return Reflect.get(d, key);
}

function childNodes(d: object): Array<[string, unknown]> {
  const type = field(d, "type");
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const present = (entries: Array<[string, unknown]>): Array<[string, unknown]> => entries.filter(([, child]) => child !== undefined && child !== null);
  if (typeof type === "string" && WRAPPER_TYPES.has(type)) return present([["", field(d, "innerType")]]);
  switch (type) {
    case "object": {
      const shape = field(d, "shape");
      const entries = typeof shape === "object" && shape !== null ? Object.keys(shape).map((key): [string, unknown] => [`.${key}`, Reflect.get(shape, key)]) : [];
      return present([...entries, [".*", field(d, "catchall")]]);
    }
    case "record":
    case "map":
      return present([[".<key>", field(d, "keyType")], [".*", field(d, "valueType")]]);
    case "set":
      return present([["[]", field(d, "valueType")]]);
    case "array":
      return present([["[]", field(d, "element")]]);
    case "tuple":
      return present([...list(field(d, "items")).map((item, i): [string, unknown] => [`[${i}]`, item]), ["[]", field(d, "rest")]]);
    case "union":
      return present(list(field(d, "options")).map((option): [string, unknown] => ["", option]));
    case "intersection":
      return present([["", field(d, "left")], ["", field(d, "right")]]);
    case "pipe":
      return present([["", field(d, "in")], ["", field(d, "out")]]);
    case "lazy": {
      const getter = field(d, "getter");
      return typeof getter === "function" ? present([["", Reflect.apply(getter, d, [])]]) : [];
    }
    default:
      return [];
  }
}

function firstNodeProblem(node: unknown, path: string, visited: Set<object>): string | undefined {
  const internals: unknown = typeof node === "object" && node !== null ? Reflect.get(node, "_zod") : undefined;
  const problem = nodeProblem(internals);
  if (problem !== undefined) return `${path} ${problem}`;
  if (typeof node !== "object" || node === null || visited.has(node)) return undefined;
  visited.add(node);
  const d: unknown = typeof internals === "object" && internals !== null ? Reflect.get(internals, "def") : undefined;
  if (typeof d !== "object" || d === null) return undefined;
  for (const [segment, child] of childNodes(d)) {
    const found = firstNodeProblem(child, `${path}${segment}`, visited);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Why kestrel cannot read `value` as a module config schema, or `undefined` when it can: a schema
 * whose every node, from the root through object fields, catchalls, record keys and values, array and
 * tuple elements, union and intersection members, wrappers, pipes and lazy getters, is built with zod
 * 4.6.6 or a later 4.x. A zod 3 node, one from an older zod 4 copy such as zod 3.25's `zod/v4` (which
 * reports 4.0.0) and one from another major keep their descriptions, and with them the `"secret"`
 * marks, where kestrel cannot see them. The problem names the path of the first such node.
 */
export function zodSchemaProblem(value: unknown): string | undefined {
  return firstNodeProblem(value, "configSchema", new Set());
}

/** True when `value` is a schema whose every node is built with zod 4.6.6 or a later 4.x, the only kind whose definitions kestrel reads. */
export function isZod4Schema(value: unknown): boolean {
  return zodSchemaProblem(value) === undefined;
}

const def = (schema: Schema): Def => boundaryCast<core.$ZodTypes>(schema, "host")._zod.def;
const kind = (schema: Schema): string => schema._zod.def.type;
const descriptionOf = (schema: Schema): string | undefined => globalRegistry.get(schema)?.description;

function checksOf(d: Def): CheckDef[] {
  const own = "check" in d && typeof d.check === "string" ? [boundaryCast<CheckDef>(d, "host")] : [];
  return [...own, ...(d.checks ?? []).map((check) => boundaryCast<CheckDef>(check._zod.def, "host"))];
}

function catchallOf(d: core.$ZodObjectDef): Schema | undefined {
  const catchall = d.catchall;
  return catchall === undefined || kind(catchall) === "never" || kind(catchall) === "unknown" ? undefined : catchall;
}

function unwrap(schema: Schema): Unwrapped {
  const out: Unwrapped = { inner: schema, optional: false, nullable: false, reshapes: false, lazies: [] };
  let current = schema;
  let required = false;
  for (;;) {
    const description = descriptionOf(current);
    if (description !== undefined && out.description === undefined) out.description = description;
    const d = def(current);
    if (d.type === "optional") {
      if (!required) out.optional = true;
      current = d.innerType;
    } else if (d.type === "default" || d.type === "prefault") {
      if (!required) out.optional = true;
      if (!required && out.defaultValue === undefined) {
        out.defaultValue = () => d.defaultValue;
        out.defaultKind = d.type;
      }
      current = d.innerType;
    } else if (d.type === "nonoptional") {
      required = true;
      current = d.innerType;
    } else if (d.type === "nullable") {
      out.nullable = true;
      current = d.innerType;
    } else if (d.type === "catch" || d.type === "readonly") {
      current = d.innerType;
    } else if (d.type === "pipe") {
      out.reshapes = true;
      current = kind(d.in) === "transform" ? d.out : d.in;
    } else if (d.type === "lazy" && !out.lazies.includes(current)) {
      out.lazies.push(current);
      current = d.getter();
    } else {
      break;
    }
  }
  out.inner = current;
  return out;
}

const STRING_FORMATS: Readonly<Record<string, string>> = { email: "email", url: "url", uuid: "uuid", date: "date", datetime: "date-time", time: "time", ipv4: "ip", ipv6: "ip", cidrv4: "cidr", cidrv6: "cidr" };

function stringSchema(d: Def): JsonSchema {
  const out: JsonSchema = { type: "string" };
  for (const check of checksOf(d)) {
    if (check.check === "min_length") out.minLength = check.minimum;
    else if (check.check === "max_length") out.maxLength = check.maximum;
    else if (check.check === "length_equals") out.minLength = out.maxLength = check.length;
    else if (check.check !== "string_format") continue;
    else if (check.format === "regex" && check.pattern) out.pattern = check.pattern.source;
    else if (check.format === "starts_with") out.pattern = `^${escapeRegex(String(check.prefix))}`;
    else if (check.format === "ends_with") out.pattern = `${escapeRegex(String(check.suffix))}$`;
    else if (check.format !== undefined && Object.hasOwn(STRING_FORMATS, check.format)) out.format = STRING_FORMATS[check.format];
  }
  return out;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const INTEGER_FORMATS = new Set(["safeint", "int32", "uint32"]);

function isInteger(d: Def): boolean {
  return checksOf(d).some((c) => c.check === "number_format" && c.format !== undefined && INTEGER_FORMATS.has(c.format));
}

function numberSchema(d: Def): JsonSchema {
  const out: JsonSchema = { type: isInteger(d) ? "integer" : "number" };
  for (const check of checksOf(d)) {
    if (check.check === "greater_than") out[check.inclusive === false ? "exclusiveMinimum" : "minimum"] = check.value;
    else if (check.check === "less_than") out[check.inclusive === false ? "exclusiveMaximum" : "maximum"] = check.value;
    else if (check.check === "multiple_of") out.multipleOf = check.value;
  }
  return out;
}

function arraySchema(d: core.$ZodArrayDef): JsonSchema {
  let min: number | undefined;
  let max: number | undefined;
  let exact: number | undefined;
  for (const check of checksOf(d)) {
    if (check.check === "min_length") min = check.minimum;
    else if (check.check === "max_length") max = check.maximum;
    else if (check.check === "length_equals") exact = check.length;
  }
  const out: JsonSchema = { type: "array", items: toJsonSchema(d.element) };
  if (min !== undefined) out.minItems = min;
  if (max !== undefined) out.maxItems = max;
  if (exact !== undefined) out.minItems = out.maxItems = exact;
  return out;
}

function enumSchema(d: core.$ZodEnumDef): JsonSchema {
  const entries = Object.entries(d.entries);
  const values = entries.map(([, value]) => value);
  if (entries.every(([key, value]) => key === value)) return { type: "string", enum: values };
  const numeric = values.filter((v) => typeof v === "number");
  return { enum: numeric.length > 0 ? numeric : values };
}

function objectSchema(d: core.$ZodObjectDef): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(d.shape)) {
    const property = toJsonSchema(child);
    if (isSecretName(key) && canHoldSecret(typeOf(unwrap(child).inner))) delete property.default;
    properties[key] = property;
    if (!unwrap(child).optional) required.push(key);
  }
  const out: JsonSchema = { type: "object", properties };
  if (required.length > 0) out.required = required;
  if (d.catchall !== undefined && kind(d.catchall) === "never") out.additionalProperties = false;
  else if (d.catchall !== undefined && kind(d.catchall) === "unknown") out.additionalProperties = true;
  else if (d.catchall !== undefined) out.additionalProperties = toJsonSchema(d.catchall);
  return out;
}

function bareSchema(schema: Schema): JsonSchema {
  const d = def(schema);
  switch (d.type) {
    case "string":
      return stringSchema(d);
    case "number":
      return numberSchema(d);
    case "bigint":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date-time" };
    case "null":
      return { type: "null" };
    case "literal":
      return d.values.length === 1 ? { const: d.values[0] } : { enum: d.values };
    case "enum":
      return enumSchema(d);
    case "array":
      return arraySchema(d);
    case "tuple": {
      const out: JsonSchema = { type: "array", prefixItems: d.items.map(toJsonSchema) };
      if (d.rest) out.items = toJsonSchema(d.rest);
      return out;
    }
    case "object":
      return objectSchema(d);
    case "record":
      return { type: "object", additionalProperties: toJsonSchema(d.valueType) };
    case "union":
      return { anyOf: d.options.map(toJsonSchema) };
    case "intersection":
      return { allOf: [toJsonSchema(d.left), toJsonSchema(d.right)] };
    default:
      return {};
  }
}

const expanding = new Set<Schema>();

export function toJsonSchema(schema: Schema): JsonSchema {
  const { inner, nullable, defaultValue, description, lazies } = unwrap(schema);
  if (lazies.some((lazy) => expanding.has(lazy))) return {};
  for (const lazy of lazies) expanding.add(lazy);
  try {
    return annotatedSchema(schema, inner, nullable, defaultValue, description);
  } finally {
    for (const lazy of lazies) expanding.delete(lazy);
  }
}

function annotatedSchema(schema: Schema, inner: Schema, nullable: boolean, defaultValue: (() => unknown) | undefined, description: string | undefined): JsonSchema {
  const secret = isSecretNode(schema);
  let out = bareSchema(inner);
  if (nullable) out = { anyOf: [out, { type: "null" }] };
  if (defaultValue && !secret) out = { ...out, default: redactedSnapshot(inner, defaultValue()) };
  if (description !== undefined && description !== SECRET) out = { ...out, description };
  if (secret) out = { ...out, writeOnly: true };
  return out;
}

const MAX_REDACT_DEPTH = 8;

function isSecretField(key: string, child: Schema): boolean {
  return isSecretSchema(toJsonSchema(child)) || (isSecretName(key) && canHoldSecret(typeOf(unwrap(child).inner)));
}

function assign(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function containsSecret(schema: Schema, depth: number): boolean {
  if (depth > MAX_REDACT_DEPTH) return true;
  if (descriptionOf(schema) === SECRET) return true;
  const next = (child: Schema | null | undefined): boolean => child !== undefined && child !== null && containsSecret(child, depth + 1);
  const d = def(schema);
  switch (d.type) {
    case "optional":
    case "default":
    case "prefault":
    case "nonoptional":
    case "nullable":
    case "catch":
    case "readonly":
      return next(d.innerType);
    case "pipe":
      return next(d.in) || next(d.out);
    case "lazy":
      return next(d.getter());
    case "object":
      return Object.entries(d.shape).some(([key, child]) => (isSecretName(key) && canHoldSecret(typeOf(unwrap(child).inner))) || next(child)) || next(catchallOf(d));
    case "record":
      return next(d.valueType);
    case "array":
      return next(d.element);
    case "tuple":
      return d.items.some((item) => next(item)) || next(d.rest);
    case "union":
      return d.options.some((option) => next(option));
    case "intersection":
      return next(d.left) || next(d.right);
    default:
      return false;
  }
}

function isSecretNode(schema: Schema): boolean {
  const { description, reshapes } = unwrap(schema);
  return description === SECRET || (reshapes && containsSecret(schema, 0));
}

function redactEntries(value: Record<string, unknown>, childOf: (key: string) => Schema | undefined, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const child = childOf(key);
    const secret = child === undefined ? isSecretName(key) && canHoldSecret(typeof item) : isSecretField(key, child);
    assign(out, key, secret ? REDACTED : child === undefined ? item : redactSecrets(child, item, depth + 1));
  }
  return out;
}

function redactSecrets(schema: Schema, value: unknown, depth: number): unknown {
  if (value === undefined || value === null) return value;
  if (isSecretNode(schema)) return REDACTED;
  if (depth > MAX_REDACT_DEPTH) return REDACTED;
  const d = def(unwrap(schema).inner);
  switch (d.type) {
    case "object": {
      if (!isPlainObject(value)) return value;
      const shape = d.shape;
      const catchall = catchallOf(d);
      return redactEntries(value, (key) => (Object.hasOwn(shape, key) ? shape[key] : catchall), depth);
    }
    case "record":
      return isPlainObject(value) ? redactEntries(value, () => d.valueType, depth) : value;
    case "array":
      return Array.isArray(value) ? value.map((item: unknown) => redactSecrets(d.element, item, depth + 1)) : value;
    case "tuple": {
      if (!Array.isArray(value)) return value;
      return value.map((item: unknown, i) => {
        const element = d.items[i] ?? d.rest ?? undefined;
        return element === undefined ? item : redactSecrets(element, item, depth + 1);
      });
    }
    case "union":
      return d.options.reduce<unknown>((current, option) => redactSecrets(option, current, depth + 1), value);
    case "intersection":
      return redactSecrets(d.right, redactSecrets(d.left, value, depth + 1), depth + 1);
    default:
      return value;
  }
}

function childAt(schema: Schema, key: PropertyKey): Schema | undefined {
  const d = def(unwrap(schema).inner);
  switch (d.type) {
    case "object":
      if (typeof key === "string" && Object.hasOwn(d.shape, key)) return d.shape[key];
      return catchallOf(d);
    case "record":
      return d.valueType;
    case "array":
      return d.element;
    case "tuple":
      return (typeof key === "number" ? d.items[key] : undefined) ?? d.rest ?? undefined;
    default:
      return undefined;
  }
}

function isSecretPath(schema: Schema, path: readonly PropertyKey[]): boolean {
  let node: Schema | undefined = schema;
  for (const key of path) {
    if (node === undefined) return false;
    if (isSecretNode(node)) return true;
    const kindName = kind(unwrap(node).inner);
    if (kindName === "union" || kindName === "intersection") return true;
    if (typeof key === "string" && isSecretName(key)) return true;
    node = childAt(node, key);
  }
  return node !== undefined && isSecretNode(node);
}

function nodeAt(schema: Schema, path: readonly PropertyKey[]): Schema | undefined {
  let node: Schema | undefined = schema;
  for (const key of path) node = node === undefined ? undefined : childAt(node, key);
  return node;
}

function isEnumAt(schema: Schema, path: readonly PropertyKey[]): boolean {
  const node = nodeAt(schema, path);
  return node !== undefined && kind(unwrap(node).inner) === "enum";
}

function missingRequiredMessage(schema: Schema, issue: core.$ZodIssue): string | undefined {
  if (issue.code !== "invalid_type" || issue.expected !== "nonoptional") return undefined;
  const node = nodeAt(schema, issue.path);
  return node === undefined ? undefined : `Invalid input: expected ${kind(unwrap(node).inner)}, received undefined`;
}

const TYPE_MISMATCH = new Set(["invalid_type", "invalid_value", "invalid_union"]);

/**
 * The issues behind a failed union, with their full paths, when the value fits one option: an
 * option without a type mismatch at the union's own path and, among several, the first without a
 * type mismatch anywhere. Nested unions are resolved the same way. Any other issue, and a union
 * whose value fits no option or several equally, is returned as it is.
 */
export function unionIssues(issue: core.$ZodIssue): core.$ZodIssue[] {
  if (issue.code !== "invalid_union") return [issue];
  const fitting = issue.errors.filter((option) => option.length > 0 && !option.some((i) => i.path.length === 0 && TYPE_MISMATCH.has(i.code)));
  const chosen = fitting.find((option) => !option.some((i) => i.code === "invalid_type")) ?? (fitting.length === 1 ? fitting[0] : undefined);
  if (chosen === undefined) return [issue];
  return chosen.flatMap((inner) => unionIssues({ ...inner, path: [...issue.path, ...inner.path] }));
}

/**
 * One line per config validation problem. A secret path (a secret schema node, a credential-like key
 * or a path through a union or intersection) reports only the issue code and an enum mismatch only
 * what it expected; any other message is kept as its check wrote it, with credential URLs redacted.
 * An invalid record key or element reports the message of the key or element schema's own issue.
 * A missing key that `.required()` or `.nonoptional()` demands names the type the key expects.
 * A failed union reports the issues of the option the value fits, as {@link unionIssues} picks it.
 */
export function describeConfigIssue(schema: Schema, issue: core.$ZodIssue): string {
  return unionIssues(issue)
    .map((one) => describeOneIssue(schema, one))
    .join("; ");
}

function describeOneIssue(schema: Schema, issue: core.$ZodIssue): string {
  const where = issue.path.map(String).join(".") || "(root)";
  if (isSecretPath(schema, issue.path)) return `${where}: ${issue.code}`;
  if (issue.code === "invalid_value" && isEnumAt(schema, issue.path)) return `${where}: Invalid enum value. Expected ${issue.values.map((o) => `'${String(o)}'`).join(" | ")}`;
  return `${where}: ${redactCredentialUrls(missingRequiredMessage(schema, issue) ?? innermostMessage(issue))}`;
}

function innermostMessage(issue: core.$ZodIssue | core.$ZodRawIssue): string {
  const nested = issue.code === "invalid_key" || issue.code === "invalid_element" ? issue.issues[0] : undefined;
  if (nested !== undefined) return innermostMessage(nested);
  return typeof issue.message === "string" ? issue.message : "Invalid input";
}

function redactedSnapshot(schema: Schema, value: unknown): JsonValue {
  return snapshotValue(redactSecrets(schema, value, 0));
}

function typeOf(schema: Schema): string {
  const d = def(schema);
  switch (d.type) {
    case "string":
    case "date":
      return "string";
    case "number":
      return isInteger(d) ? "integer" : "number";
    case "bigint":
      return "integer";
    case "boolean":
      return "boolean";
    case "array":
    case "tuple":
      return "array";
    case "object":
      return "object";
    case "record":
      return "record";
    case "enum":
      return "enum";
    case "union":
      return "union";
    case "literal":
      return "literal";
    case "function":
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
  unparsed: boolean;
}

function collectVariables(schema: Schema, raw: unknown, parsedInput: unknown, defaults: ConfigDefaults | undefined, path: string[], out: ConfigVariable[], ancestors: Ancestors): void {
  const { inner, reshapes } = unwrap(schema);
  const parsed = reshapes ? undefined : parsedInput;
  const d = def(inner);
  if (d.type !== "object") return;
  const inherited = valueAt(raw, path) === undefined ? ancestors.default : undefined;
  for (const [key, child] of Object.entries(d.shape)) {
    const childPath = [...path, key];
    const unwrapped = unwrap(child);
    const secret = isSecretSchema(toJsonSchema(child));
    const rawValue = valueAt(raw, childPath);
    const set = rawValue !== undefined;
    const hostValue = hostValueAt(defaults, raw, childPath);
    const fromAncestor = valueAt(inherited, [key]);
    const effective = hostValue !== undefined ? hostValue : fromAncestor === undefined ? (ancestors.unparsed ? undefined : unwrapped.defaultValue?.()) : fromAncestor;
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
    const unparsed = !set && hostValue === undefined && (ancestors.unparsed || (fromAncestor === undefined && unwrapped.defaultKind === "default"));
    if (kind(unwrapped.inner) === "object") collectVariables(child, raw, parsed, defaults, childPath, out, { optional, default: effective, redacted, unparsed });
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
export function describeConfig(schema: Schema, raw: unknown, parsed?: unknown, defaults?: ConfigDefaults): ConfigDescription {
  if (!isZod4Schema(schema)) return { schema: {}, variables: [] };
  const variables: ConfigVariable[] = [];
  collectVariables(schema, raw, parsed, defaults, [], variables, { optional: false, default: undefined, redacted: false, unparsed: false });
  const root = toJsonSchema(schema);
  if (root.writeOnly === true && unwrap(schema).description !== SECRET) delete root.writeOnly;
  return { schema: root, variables };
}
