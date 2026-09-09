import type { JsonSchema } from "./defineModule.ts";

export interface SchemaProblem {
  path: string;
  message: string;
}

const ROOT = "$";

function child(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function subSchema(value: unknown): JsonSchema | undefined {
  return isRecord(value) ? value : undefined;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  return jsonType(value) === type;
}

function typeNames(type: unknown): string[] {
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function present(object: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(object, key) && object[key] !== undefined;
}

function check(schema: JsonSchema, value: unknown, path: string, problems: SchemaProblem[]): void {
  const types = typeNames(schema.type);
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    problems.push({ path, message: `expected ${types.join(" or ")}, got ${jsonType(value)}` });
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => deepEqual(allowed, value))) {
    problems.push({ path, message: `expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}` });
  }
  if (Object.hasOwn(schema, "const") && !deepEqual(schema.const, value)) {
    problems.push({ path, message: `expected ${JSON.stringify(schema.const)}` });
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      problems.push({ path, message: `does not match ${schema.pattern}` });
    }
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      problems.push({ path, message: `shorter than minLength ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      problems.push({ path, message: `longer than maxLength ${schema.maxLength}` });
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) problems.push({ path, message: `below minimum ${schema.minimum}` });
    if (typeof schema.maximum === "number" && value > schema.maximum) problems.push({ path, message: `above maximum ${schema.maximum}` });
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      problems.push({ path, message: `fewer than minItems ${schema.minItems}` });
    }
    const items = schema.items;
    if (Array.isArray(items)) {
      items.forEach((item, i) => {
        const sub = subSchema(item);
        if (sub && i < value.length) check(sub, value[i], `${path}[${i}]`, problems);
      });
    } else {
      const sub = subSchema(items);
      if (sub) value.forEach((item, i) => check(sub, item, `${path}[${i}]`, problems));
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !present(value, key)) problems.push({ path: child(path, key), message: "is required" });
      }
    }
    for (const [key, raw] of Object.entries(properties)) {
      const sub = subSchema(raw);
      if (sub && present(value, key)) check(sub, value[key], child(path, key), problems);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) problems.push({ path: child(path, key), message: "is not allowed by additionalProperties: false" });
      }
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((raw) => {
      const sub = subSchema(raw);
      return sub !== undefined && validateSchema(sub, value).length === 0;
    }).length;
    if (matched !== 1) problems.push({ path, message: `matches ${String(matched)} of ${String(schema.oneOf.length)} oneOf schemas, expected exactly 1` });
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((raw) => {
      const sub = subSchema(raw);
      return sub !== undefined && validateSchema(sub, value).length === 0;
    });
    if (!matched) problems.push({ path, message: `matches none of the ${String(schema.anyOf.length)} anyOf schemas` });
  }
}

function coerceValue(schema: JsonSchema, value: unknown): unknown {
  const types = typeNames(schema.type);
  if (typeof value === "string") {
    if (types.includes("integer") && /^-?\d+$/.test(value)) return Number(value);
    if (types.includes("number") && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    if (types.includes("boolean") && (value === "true" || value === "false")) return value === "true";
    if (types.includes("array") && !types.includes("string")) return [coerceValue(subSchema(schema.items) ?? {}, value)];
  }
  if (Array.isArray(value) && types.includes("array")) {
    const items = subSchema(schema.items);
    return items ? value.map((item) => coerceValue(items, item)) : value;
  }
  return value;
}

/** Query parameters arrive as strings (or string arrays); this returns a copy converted to the declared types where the text allows it, leaving everything else untouched. */
export function coerceQuery(query: Record<string, JsonSchema>, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(query)) {
    if (!present(values, key)) continue;
    out[key] = coerceValue(schema, values[key]);
  }
  return out;
}

/** The subset of JSON Schema the shipped `describe().input` blocks use; unknown keywords are ignored. */
export function validateSchema(schema: JsonSchema, value: unknown): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  check(schema, value, ROOT, problems);
  return problems;
}
