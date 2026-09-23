import { boundaryCast } from "./cast.ts";
import type { JsonSchema, StepDescription } from "./defineModule.ts";
import { isRecord } from "./guards.ts";

export interface SchemaProblem {
  path: string;
  message: string;
}

const ROOT = "$";

function child(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
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

function mergeObjects(schemas: JsonSchema[]): JsonSchema | undefined {
  if (schemas.length === 0) return undefined;
  if (schemas.length === 1) return schemas[0];
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const s of schemas) {
    Object.assign(properties, boundaryCast<Record<string, unknown>>(s.properties ?? {}, "json"));
    for (const r of boundaryCast<string[]>(s.required ?? [], "json")) required.add(r);
  }
  const merged: JsonSchema = { type: "object", properties };
  if (required.size > 0) merged.required = [...required].sort();
  if (schemas.some((s) => s.additionalProperties === false)) merged.additionalProperties = false;
  return merged;
}

function isObjectSchema(schema: JsonSchema): boolean {
  return schema.type === "object";
}

interface Union {
  keyword: "oneOf" | "anyOf";
  branches: JsonSchema[];
}

function unionOf(schema: JsonSchema): Union | undefined {
  if (schema.type !== undefined) return undefined;
  if (Array.isArray(schema.oneOf)) return { keyword: "oneOf", branches: schema.oneOf.filter(isRecord) };
  if (Array.isArray(schema.anyOf)) return { keyword: "anyOf", branches: schema.anyOf.filter(isRecord) };
  return undefined;
}

function typeReason(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) return `a type array (${schema.type.map((t) => JSON.stringify(t)).join(", ")})`;
  if (typeof schema.type === "string") return `type "${schema.type}", not "object"`;
  if (Array.isArray(schema.allOf)) return "an allOf schema";
  return "a schema without a declared type";
}

function isListShaped(schema: JsonSchema): boolean {
  if (!isObjectSchema(schema)) return false;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const list = subSchema(properties?.items);
  return list !== undefined && list.type === "array" && isRecord(list.items);
}

function mergeIntoListBranch(branch: JsonSchema, extension: JsonSchema): JsonSchema {
  const properties = isRecord(branch.properties) ? branch.properties : {};
  const list = subSchema(properties.items)!;
  const item = subSchema(list.items)!;
  return { ...branch, properties: { ...properties, items: { ...list, items: mergeObjects([item, extension])! } } };
}

function walkForMissingRequired(schema: unknown, path: string, hits: string[]): void {
  if (!isRecord(schema)) return;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (properties !== undefined && !Object.hasOwn(schema, "required")) hits.push(path);
  if (properties !== undefined) {
    for (const [key, sub] of Object.entries(properties)) walkForMissingRequired(sub, `${path}.properties.${key}`, hits);
  }
  const items = schema.items;
  if (Array.isArray(items)) items.forEach((item, i) => walkForMissingRequired(item, `${path}.items[${i}]`, hits));
  else if (items !== undefined) walkForMissingRequired(items, `${path}.items`, hits);
  if (isRecord(schema.additionalProperties)) walkForMissingRequired(schema.additionalProperties, `${path}.additionalProperties`, hits);
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) branches.forEach((branch, i) => walkForMissingRequired(branch, `${path}.${keyword}[${i}]`, hits));
  }
}

/** JSON paths (dotted, `$`-rooted) of every object schema under `schema` — including `schema` itself, its properties, array items, an object-valued `additionalProperties` and `oneOf`/`anyOf`/`allOf` branches — that declares `properties` without a `required` key. */
export function findMissingRequired(schema: JsonSchema, path = ROOT): string[] {
  const hits: string[] = [];
  walkForMissingRequired(schema, path, hits);
  return hits;
}

/**
 * Folds a pipeline's step descriptions, in order, into the schema its result ends up matching: `output`
 * replaces the active schema; `extendsOutput` merges into it, becomes the output if there was none yet,
 * or merges into every branch of a `oneOf`/`anyOf`; `extendsItems` merges into a list output's
 * `items[]` — the list-shaped branches of a union, or the root of a non-list object schema. Every
 * schema an `extendsOutput`/`extendsItems` merges is itself required to be an object schema.
 *
 * `onFoldContradiction`, when given, is called instead of applying a merge that cannot be expressed this
 * way: the index of the step, which of the two keywords it used, a plain-text reason, and the index of
 * the earlier step that set the active schema it tried to fold onto (absent when there was none). The
 * active schema is left unchanged when this fires.
 */
export function resolveOutputSchema(
  descriptions: readonly StepDescription[],
  onFoldContradiction?: (index: number, keyword: "extendsOutput" | "extendsItems", reason: string, sourceIndex?: number) => void,
): JsonSchema | undefined {
  let current: JsonSchema | undefined;
  let sourceIndex = -1;
  const fail = (index: number, keyword: "extendsOutput" | "extendsItems", reason: string): void => {
    onFoldContradiction?.(index, keyword, reason, sourceIndex === -1 ? undefined : sourceIndex);
  };

  descriptions.forEach((d, index) => {
    if (d.output !== undefined) {
      current = d.output;
      sourceIndex = index;
    } else if (d.extendsOutput !== undefined) {
      const extension = d.extendsOutput;
      if (!isObjectSchema(extension)) {
        fail(index, "extendsOutput", "the extension is not an object schema");
      } else if (current === undefined) {
        current = extension;
        sourceIndex = index;
      } else if (isObjectSchema(current)) {
        current = mergeObjects([current, extension]);
      } else {
        const union = unionOf(current);
        if (union === undefined) fail(index, "extendsOutput", typeReason(current));
        else if (!union.branches.every(isObjectSchema)) fail(index, "extendsOutput", "a union with a non-object branch");
        else current = { ...current, [union.keyword]: union.branches.map((b) => mergeObjects([b, extension])) };
      }
    }
    if (d.extendsItems !== undefined) {
      const extension = d.extendsItems;
      if (!isObjectSchema(extension)) {
        fail(index, "extendsItems", "the extension is not an object schema");
      } else if (current === undefined) {
        current = extension;
        sourceIndex = index;
      } else if (isListShaped(current)) {
        current = mergeIntoListBranch(current, extension);
      } else if (isObjectSchema(current)) {
        current = mergeObjects([current, extension]);
      } else {
        const union = unionOf(current);
        if (union === undefined) fail(index, "extendsItems", typeReason(current));
        else if (!union.branches.every(isObjectSchema)) fail(index, "extendsItems", "a union with a non-object branch");
        else if (!union.branches.some(isListShaped)) fail(index, "extendsItems", "a union with no list-shaped branch");
        else current = { ...current, [union.keyword]: union.branches.map((b) => (isListShaped(b) ? mergeIntoListBranch(b, extension) : mergeObjects([b, extension]))) };
      }
    }
  });
  return current;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  return value;
}

function sameSchema(a: JsonSchema, b: JsonSchema): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

/**
 * Every shape a successful run's `result` can take: the fold of {@link resolveOutputSchema}, then
 * each step's `terminalOutput` in pipeline order, as one `anyOf`. A schema equal to one already
 * listed (keys sorted) is left out; without a fold or without a distinct `terminalOutput` the fold
 * is returned as is.
 */
export function resolveResultSchema(descriptions: readonly StepDescription[]): JsonSchema | undefined {
  const fold = resolveOutputSchema(descriptions);
  const shapes: JsonSchema[] = fold === undefined ? [] : [fold];
  for (const d of descriptions) {
    const terminal = d.terminalOutput;
    if (terminal === undefined || shapes.some((s) => sameSchema(s, terminal))) continue;
    shapes.push(terminal);
  }
  return shapes.length < 2 ? shapes[0] : { anyOf: shapes };
}
