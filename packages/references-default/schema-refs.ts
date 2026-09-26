import { declaresType, isSchemaNode, resolveSchema, typeTag, type SchemaNode } from "@michaelthielemann/kestrel-contracts/helpers/json-schema";

/** The JSON Schema keyword that marks a string position as holding an id of a references target. */
export const REF_KEYWORD = "x-kestrel-ref";

/** An id found at a marked position of a json field, with the target the schema names for it. */
export interface SchemaRef {
  target: string;
  id: string;
}

const WALKED_KEYWORDS = new Set(["$ref", "$defs", "definitions", "oneOf", "anyOf", "allOf", "properties", "additionalProperties", "items", "type", "const", REF_KEYWORD]);
const NAME_MAPS = new Set(["$defs", "definitions", "properties"]);

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function branches(root: SchemaNode, candidates: unknown[], value: unknown): unknown[] {
  const resolved = candidates.map((candidate) => ({ candidate, schema: resolveSchema(root, candidate) }));
  const tag = isSchemaNode(value) ? value.type : undefined;
  return resolved
    .filter(({ schema }) => {
      if (schema === undefined) return false;
      const own = typeTag(schema);
      if (own !== undefined) return own === tag;
      return schema.type === undefined || declaresType(schema, value);
    })
    .map(({ candidate }) => candidate);
}

function walk(root: SchemaNode, schema: unknown, value: unknown, out: Map<string, SchemaRef>, seen: Set<unknown>): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const s = resolveSchema(root, schema);
  if (!s) return;
  if (seen.has(s) && s !== schema) return;
  seen.add(s);
  const target = s[REF_KEYWORD];
  if (typeof value === "string" && typeof target === "string" && target !== "" && value !== "") out.set(`${target}\u0000${value}`, { target, id: value });
  for (const member of list(s.allOf)) walk(root, member, value, out, seen);
  for (const union of [s.oneOf, s.anyOf]) {
    for (const branch of branches(root, list(union), value)) walk(root, branch, value, out, seen);
  }
  if (Array.isArray(value)) {
    if (s.items !== undefined) for (const item of value) walk(root, s.items, item, out, new Set());
    return;
  }
  if (isSchemaNode(value)) {
    const properties = isSchemaNode(s.properties) ? s.properties : {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key] ?? (isSchemaNode(s.additionalProperties) ? s.additionalProperties : undefined);
      if (childSchema !== undefined) walk(root, childSchema, child, out, new Set());
    }
  }
}

/**
 * Every non-empty string in `value` whose position in `schema` carries `"x-kestrel-ref": "<target>"`, deduped.
 * The walk follows local `$ref`s (a marker next to a `$ref` counts), every `allOf` member, every `oneOf`/`anyOf`
 * branch that fits the value (by its `type` const, else by its `type`), `properties`, `additionalProperties` and
 * `items`. It errs towards finding an id: a branch without `type` is walked for any value.
 */
export function collectSchemaRefs(schema: Record<string, unknown>, value: unknown): SchemaRef[] {
  const out = new Map<string, SchemaRef>();
  walk(schema, schema, value, out, new Set());
  return [...out.values()];
}

/** The keywords of `schema` that decide what `collectSchemaRefs` finds, dropping annotations and validation-only keywords. */
export function walkedProjection(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(walkedProjection);
  if (!isSchemaNode(schema)) return schema;
  const out: SchemaNode = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!WALKED_KEYWORDS.has(key)) continue;
    out[key] = NAME_MAPS.has(key) && isSchemaNode(value) ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, walkedProjection(child)])) : walkedProjection(value);
  }
  return out;
}
