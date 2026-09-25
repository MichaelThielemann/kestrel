import type { JsonSchema, NarrowsDeclaration } from "@michaelthielemann/kestrel";

type Tree = Map<string, Tree | true>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function treeOf(paths: readonly string[]): Tree {
  const root: Tree = new Map();
  for (const path of paths) {
    const names = path.split(".").map((segment) => (segment.endsWith("[]") ? segment.slice(0, -2) : segment));
    let node = root;
    for (const [index, name] of names.entries()) {
      const existing = node.get(name);
      if (existing === true) break;
      if (index === names.length - 1) {
        node.set(name, true);
        break;
      }
      const next: Tree = existing ?? new Map<string, Tree | true>();
      node.set(name, next);
      node = next;
    }
  }
  return root;
}

function hasType(schema: JsonSchema, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function mapUnion(schema: JsonSchema, narrow: (branch: JsonSchema) => JsonSchema): JsonSchema | undefined {
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches: unknown = schema[keyword];
    if (Array.isArray(branches)) return { ...schema, [keyword]: branches.map((branch: unknown) => (isRecord(branch) ? narrow(branch) : branch)) };
  }
  return undefined;
}

function requiredKept(schema: JsonSchema, kept: readonly string[]): string[] {
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  return required.filter((key) => kept.includes(key));
}

function narrowItem(schema: JsonSchema, tree: Tree): JsonSchema {
  const union = mapUnion(schema, (branch) => narrowItem(branch, tree));
  if (union !== undefined) return union;
  if (hasType(schema, "array") && isRecord(schema.items)) return { ...schema, items: narrowItem(schema.items, tree) };
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (properties === undefined) {
    if (!hasType(schema, "object")) return schema;
    const members = isRecord(schema.additionalProperties) ? schema.additionalProperties : {};
    const named = [...tree].map(([key, grant]): [string, unknown] => [key, grant === true ? members : narrowItem(members, grant)]);
    return { ...schema, properties: Object.fromEntries(named), required: [], additionalProperties: false };
  }
  const kept: Array<[string, unknown]> = [];
  for (const [key, member] of Object.entries(properties)) {
    const grant = tree.get(key);
    if (grant === undefined) continue;
    kept.push([key, grant === true || !isRecord(member) ? member : narrowItem(member, grant)]);
  }
  const keys = kept.map(([key]) => key);
  return { ...schema, properties: Object.fromEntries(kept), required: requiredKept(schema, keys), additionalProperties: false };
}

function narrowList(schema: JsonSchema, tree: Tree): JsonSchema {
  const union = mapUnion(schema, (branch) => narrowList(branch, tree));
  if (union !== undefined) return union;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const list = properties.items;
  if (!isRecord(list) || !isRecord(list.items)) return narrowItem(schema, tree);
  const kept: Array<[string, unknown]> = [["items", { ...list, items: narrowItem(list.items, tree) }]];
  if (Object.hasOwn(properties, "total")) kept.push(["total", properties.total]);
  const keys = kept.map(([key]) => key);
  return { ...schema, properties: Object.fromEntries(kept), required: requiredKept(schema, keys), additionalProperties: false };
}

/** The schema of what `paths` keep of an answer declared by `schema`, with the items where `shape` says they are; closed at every object a path passes through, a whole member as declared. */
export function narrowAnswer(schema: JsonSchema, shape: NarrowsDeclaration["shape"], paths: readonly string[]): JsonSchema {
  const tree = treeOf(paths);
  if (shape === "list") return narrowList(schema, tree);
  return narrowItem(schema, tree);
}

/** The response header names `paths` grant for a file answer (`headers.<name>`), lower-cased. */
export function grantedHeaders(paths: readonly string[]): string[] {
  return paths.filter((path) => path.startsWith("headers.")).map((path) => path.slice("headers.".length).toLowerCase());
}
