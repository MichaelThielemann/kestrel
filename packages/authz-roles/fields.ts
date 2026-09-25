import { isBinaryResult } from "@michaelthielemann/kestrel/context";
import type { JsonSchema, NarrowsDeclaration } from "@michaelthielemann/kestrel/defineModule";

/** Where the items of an answer are; see {@link NarrowsDeclaration.shape}. */
export type AnswerShape = NarrowsDeclaration["shape"];

export const ANSWER_SHAPES: readonly AnswerShape[] = ["item", "list", "array", "file"];

export const RESOURCE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(\[\])?(\.[A-Za-z_][A-Za-z0-9_-]*(\[\])?)*$/;

/** A granted field path set as a tree: `true` keeps a member whole, a subtree keeps only the members it names. */
export type FieldTree = ReadonlyMap<string, FieldTree | true>;

type MutableTree = Map<string, MutableTree | true>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShape(value: string | null): value is AnswerShape {
  return ANSWER_SHAPES.some((shape) => shape === value);
}

/** The resource and the answer shape an `authz.fields:<resource>?shape=<shape>` argument names; `undefined` unless it names both and nothing else. */
export function parseFieldsArgument(arg: string): { resource: string; shape: AnswerShape } | undefined {
  const question = arg.indexOf("?");
  if (question === -1) return undefined;
  const resource = arg.slice(0, question);
  const query = new URLSearchParams(arg.slice(question + 1));
  const shape = query.get("shape");
  if (!RESOURCE.test(resource) || !isShape(shape) || [...query.keys()].some((key) => key !== "shape")) return undefined;
  return { resource, shape };
}

function segmentsOf(path: string): Array<{ name: string; list: boolean }> {
  return path.split(".").map((segment) => (segment.endsWith("[]") ? { name: segment.slice(0, -2), list: true } : { name: segment, list: false }));
}

/** Builds the tree of a grant's paths; a whole grant of a member wins over any subtree of it. */
export function fieldTree(paths: readonly string[]): FieldTree {
  const root: MutableTree = new Map();
  for (const path of paths) {
    const segments = segmentsOf(path);
    let node = root;
    for (const [index, { name }] of segments.entries()) {
      const existing = node.get(name);
      if (existing === true) break;
      if (index === segments.length - 1) {
        node.set(name, true);
        break;
      }
      const next: MutableTree = existing ?? new Map<string, MutableTree | true>();
      node.set(name, next);
      node = next;
    }
  }
  return root;
}

function cutValue(value: unknown, tree: FieldTree): unknown {
  if (Array.isArray(value)) return value.map((element) => cutValue(element, tree));
  if (!isRecord(value)) return value;
  const kept: Array<[string, unknown]> = [];
  for (const key of Object.keys(value)) {
    const grant = tree.get(key);
    if (grant === undefined) continue;
    kept.push([key, grant === true ? value[key] : cutValue(value[key], grant)]);
  }
  return Object.fromEntries(kept);
}

function cutHeaders(headers: Record<string, string>, grant: FieldTree | true | undefined): Record<string, string> | undefined {
  if (grant === undefined) return undefined;
  if (grant === true) return headers;
  const names = new Set([...grant.keys()].map((name) => name.toLowerCase()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => names.has(name.toLowerCase())));
}

/** Keeps of `answer` what `tree` grants, with the items where `shape` says they are. Pure; a value that is not an object is kept as it is. */
export function cutAnswer(answer: unknown, shape: AnswerShape, tree: FieldTree): unknown {
  if (shape === "list" && isRecord(answer)) {
    const kept: Array<[string, unknown]> = [];
    if (Array.isArray(answer.items)) kept.push(["items", answer.items.map((item) => cutValue(item, tree))]);
    if (Object.hasOwn(answer, "total")) kept.push(["total", answer.total]);
    return Object.fromEntries(kept);
  }
  if (shape === "file" && isBinaryResult(answer)) {
    const { headers, ...file } = answer;
    const kept = headers === undefined ? undefined : cutHeaders(headers, tree.get("headers"));
    return kept === undefined ? file : { ...file, headers: kept };
  }
  return cutValue(answer, tree);
}

function branchesOf(schema: JsonSchema): JsonSchema[] {
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (union === undefined) return [schema];
  return union.filter(isRecord).flatMap(branchesOf);
}

function hasType(schema: JsonSchema, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function propertiesOf(schema: JsonSchema): Record<string, unknown> | undefined {
  return isRecord(schema.properties) ? schema.properties : undefined;
}

function itemsOf(schema: JsonSchema): JsonSchema | undefined {
  return hasType(schema, "array") && isRecord(schema.items) ? schema.items : undefined;
}

function isObjectSchema(schema: JsonSchema | undefined): boolean {
  return schema !== undefined && (hasType(schema, "object") || propertiesOf(schema) !== undefined);
}

function branchShape(schema: JsonSchema): AnswerShape {
  const items = propertiesOf(schema)?.items;
  if (isObjectSchema(schema) && isRecord(items) && isObjectSchema(itemsOf(items))) return "list";
  if (isObjectSchema(itemsOf(schema))) return "array";
  return "item";
}

/**
 * The shape of an answer declared by `fold` (the folded output of the steps before the cut): `file` after a
 * binary step, `list` for an object whose `items` is an array of objects, `array` for an array of objects,
 * `item` otherwise; `undefined` for a union whose branches disagree.
 */
export function answerShape(fold: JsonSchema | undefined, binary: boolean): AnswerShape | undefined {
  if (binary) return "file";
  if (fold === undefined) return "item";
  const shapes = new Set(branchesOf(fold).map(branchShape));
  return shapes.size === 1 ? [...shapes][0] : undefined;
}

/** The item schemas of an answer declared by `fold` and cut as `shape`. */
export function itemSchemas(fold: JsonSchema | undefined, shape: AnswerShape): JsonSchema[] {
  if (fold === undefined || shape === "file") return [];
  return branchesOf(fold).flatMap((branch) => {
    if (shape === "item") return [branch];
    if (shape === "array") return [itemsOf(branch) ?? {}];
    const items = propertiesOf(branch)?.items;
    return isRecord(items) ? [itemsOf(items) ?? {}] : [];
  });
}

export type PathDeclaration = { declared: true } | { declared: false; hint?: string };

function declaredFrom(schemas: readonly JsonSchema[], segments: ReadonlyArray<{ name: string; list: boolean }>, index: number, prefix: string): PathDeclaration {
  const segment = segments[index]!;
  const path = prefix === "" ? segment.name : `${prefix}.${segment.name}`;
  let hint: string | undefined;
  for (const schema of schemas.flatMap(branchesOf)) {
    const properties = propertiesOf(schema);
    if (properties === undefined) {
      if (prefix !== "") hint ??= `grant "${prefix}" whole`;
      continue;
    }
    const member = properties[segment.name];
    if (!isRecord(member)) continue;
    const branches = branchesOf(member);
    const elements = branches.flatMap((branch) => {
      const items = itemsOf(branch);
      return items === undefined ? [] : [items];
    });
    const rest = segments.slice(index + 1).map((s) => `${s.name}${s.list ? "[]" : ""}`);
    if (segment.list && elements.length === 0) {
      hint ??= `"${path}" is not a list, write "${[path, ...rest].join(".")}"`;
      continue;
    }
    if (index === segments.length - 1) return { declared: true };
    if (!segment.list && elements.length > 0 && !branches.some((branch) => propertiesOf(branch) !== undefined)) {
      hint ??= `"${path}" is a list, write "${[`${path}[]`, ...rest].join(".")}"`;
      continue;
    }
    const found = declaredFrom(segment.list ? elements : branches, segments, index + 1, path);
    if (found.declared) return found;
    hint ??= found.hint;
  }
  return hint === undefined ? { declared: false } : { declared: false, hint };
}

/** Whether `path` names a member one of `item`'s schemas declares, and if not, how the path would have to be written when the schema reaches it differently. */
export function declaredPath(item: JsonSchema | readonly JsonSchema[], path: string): PathDeclaration {
  return declaredFrom(Array.isArray(item) ? item : [item], segmentsOf(path), 0, "");
}

export type Uncovered = { kind: "ungranted"; path: string } | { kind: "open"; path: string };

function join(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

/** The first member an answer declared by `schema` can carry that `tree` does not grant, or the first object it cannot bound because the schema leaves it open; `undefined` when every member is granted. */
export function uncoveredMember(schema: JsonSchema, tree: FieldTree, at = ""): Uncovered | undefined {
  for (const branch of branchesOf(schema)) {
    const items = itemsOf(branch);
    if (items !== undefined) {
      const inner = uncoveredMember(items, tree, at);
      if (inner !== undefined) return inner;
      continue;
    }
    if (!isObjectSchema(branch)) continue;
    if (branch.additionalProperties !== false) return { kind: "open", path: at };
    for (const [key, member] of Object.entries(propertiesOf(branch) ?? {})) {
      const grant = tree.get(key);
      if (grant === undefined) return { kind: "ungranted", path: join(at, key) };
      if (grant === true || !isRecord(member)) continue;
      const inner = uncoveredMember(member, grant, join(at, key));
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}
