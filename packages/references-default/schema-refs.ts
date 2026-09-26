import { boundaryCast } from "@michaelthielemann/kestrel/cast";

/** The JSON Schema keyword that marks a string position as holding an id of a references target. */
export const REF_KEYWORD = "x-kestrel-ref";

/** An id found at a marked position of a json field, with the target the schema names for it. */
export interface SchemaRef {
  target: string;
  id: string;
}

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRef(root: Node, node: unknown): Node | undefined {
  if (!isNode(node)) return undefined;
  if (typeof node.$ref !== "string") return node;
  if (!node.$ref.startsWith("#/")) return undefined;
  const found = node.$ref.slice(2).split("/").reduce<unknown>((o, k) => (isNode(o) ? o[k] : undefined), root);
  return isNode(found) ? found : undefined;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function pickBranch(root: Node, branches: unknown[], value: unknown): Node | undefined {
  const schemas = branches.map((b) => resolveRef(root, b));
  const tag = isNode(value) ? value.type : undefined;
  let tagged = false;
  for (const schema of schemas) {
    const properties = schema && isNode(schema.properties) ? schema.properties : undefined;
    const typeNode = properties && isNode(properties.type) ? properties.type : undefined;
    const constant = typeNode?.const;
    if (constant === undefined) continue;
    tagged = true;
    if (constant === tag) return schema;
  }
  if (tagged) return undefined;
  const kind = jsonType(value);
  return schemas.find((schema) => schema?.type === kind || (Array.isArray(schema?.type) && schema.type.includes(kind)));
}

function walk(root: Node, schema: unknown, value: unknown, out: Map<string, SchemaRef>): void {
  const s = resolveRef(root, schema);
  if (!s) return;
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
    const branch = pickBranch(root, boundaryCast<unknown[]>(s.oneOf ?? s.anyOf, "json"), value);
    if (branch) walk(root, branch, value, out);
    return;
  }
  if (typeof value === "string") {
    const target = s[REF_KEYWORD];
    if (typeof target === "string" && target !== "" && value !== "") out.set(`${target}\u0000${value}`, { target, id: value });
    return;
  }
  if (Array.isArray(value)) {
    if (s.items === undefined) return;
    for (const item of value) walk(root, s.items, item, out);
    return;
  }
  if (isNode(value)) {
    const properties = isNode(s.properties) ? s.properties : {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key] ?? (isNode(s.additionalProperties) ? s.additionalProperties : undefined);
      if (childSchema !== undefined) walk(root, childSchema, child, out);
    }
  }
}

/**
 * Every non-empty string in `value` whose position in `schema` carries `"x-kestrel-ref": "<target>"`,
 * deduped. The walk follows local `$ref`s, picks a `oneOf`/`anyOf` branch by its `type` const or else by
 * the value's JSON type, and descends `properties`, `additionalProperties` and `items`.
 */
export function collectSchemaRefs(schema: Record<string, unknown>, value: unknown): SchemaRef[] {
  const out = new Map<string, SchemaRef>();
  walk(schema, schema, value, out);
  return [...out.values()];
}
