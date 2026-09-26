/** A JSON Schema object node. */
export type SchemaNode = Record<string, unknown>;

/** Whether `value` is a JSON object (not an array, not `null`). */
export function isSchemaNode(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(root: SchemaNode, ref: string): unknown {
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((node, key) => (isSchemaNode(node) ? node[key] : undefined), root);
}

/**
 * Resolves `node` against `root`, following a chain of local `$ref`s (`#/...`). Keywords next to a `$ref` are
 * kept and win over the target's. Answers `undefined` for a non-object, a remote or unknown ref, and a cycle.
 */
export function resolveSchema(root: SchemaNode, node: unknown): SchemaNode | undefined {
  if (!isSchemaNode(node)) return undefined;
  const seen = new Set<string>();
  let current: SchemaNode = node;
  let siblings: SchemaNode = {};
  while (typeof current.$ref === "string") {
    const ref = current.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return undefined;
    seen.add(ref);
    const rest = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "$ref"));
    siblings = { ...rest, ...siblings };
    const target = pointer(root, ref);
    if (!isSchemaNode(target)) return undefined;
    current = target;
  }
  return Object.keys(siblings).length === 0 ? current : { ...current, ...siblings };
}

/** The JSON type name of `value`: `null`, `array`, `object`, `string`, `number` or `boolean`. */
export function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Whether `schema` declares `type` as the JSON type of `value`, as a name or in a list of names. An absent `type` declares nothing. */
export function declaresType(schema: SchemaNode, value: unknown): boolean {
  const kind = jsonTypeOf(value);
  return schema.type === kind || (Array.isArray(schema.type) && schema.type.includes(kind));
}

/** The `properties.type.const` of an object schema, the tag of a tagged union branch; `undefined` without one. */
export function typeTag(schema: SchemaNode | undefined): unknown {
  const properties = schema?.properties;
  const type = isSchemaNode(properties) ? properties.type : undefined;
  return isSchemaNode(type) ? type.const : undefined;
}
