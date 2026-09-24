import { parse } from "@babel/parser";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";

/** A babel AST node, read generically: this module never depends on a specific node's precise shape beyond `type`, `start` and `end`. */
export interface AstNode {
  type: string;
  start: number | null;
  end: number | null;
  [key: string]: unknown;
}

export function parseTs(source: string): AstNode {
  const file = parse(source, { sourceType: "module", plugins: ["typescript"] });
  return boundaryCast<AstNode>(file, "host");
}

export function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
const isNode = isAstNode;

/** Depth-first, pre-order walk over every node in the tree, skipping location bookkeeping fields. */
export function walk(root: AstNode, visit: (node: AstNode, parent: AstNode | undefined) => void): void {
  const seen = new Set<AstNode>();
  const visitValue = (value: unknown, parent: AstNode | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) visitValue(item, parent);
      return;
    }
    if (!isNode(value) || seen.has(value)) return;
    seen.add(value);
    visit(value, parent);
    for (const [key, child] of Object.entries(value)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type" || key === "leadingComments" || key === "trailingComments" || key === "extra") continue;
      if (child && typeof child === "object") visitValue(child, value);
    }
  };
  visitValue(root, undefined);
}

export function findAll(root: AstNode, type: string): AstNode[] {
  const out: AstNode[] = [];
  walk(root, (node) => {
    if (node.type === type) out.push(node);
  });
  return out;
}

/**
 * True once any array literal in the tree has an elision (`[a, , b]`) -- a raw `null` in babel's own
 * `elements`, never legitimate in this codebase's own source, and the shape a comma inserted next to
 * an already-comma-separated entry leaves behind even though the file still parses.
 */
export function hasArrayHole(root: AstNode): boolean {
  let found = false;
  walk(root, (node) => {
    if (found || node.type !== "ArrayExpression") return;
    if (Array.isArray(node.elements) && node.elements.some((e) => e === null)) found = true;
  });
  return found;
}

export function stringValue(node: AstNode | undefined): string | undefined {
  if (node?.type !== "StringLiteral") return undefined;
  return typeof node.value === "string" ? node.value : undefined;
}

export function propertyKeyName(prop: AstNode): string | undefined {
  const key = prop.key;
  if (!isNode(key)) return undefined;
  if (key.type === "Identifier" && typeof key.name === "string") return key.name;
  return stringValue(key);
}

export function objectPropertyNodes(obj: AstNode): AstNode[] {
  if (obj.type !== "ObjectExpression") return [];
  const properties = Array.isArray(obj.properties) ? obj.properties : [];
  return properties.filter((p): p is AstNode => isNode(p) && p.type === "ObjectProperty");
}

export function objectProperty(obj: AstNode, key: string): AstNode | undefined {
  for (const prop of objectPropertyNodes(obj)) {
    if (propertyKeyName(prop) !== key) continue;
    return isNode(prop.value) ? prop.value : undefined;
  }
  return undefined;
}

export function propertyKeyNode(prop: AstNode): AstNode | undefined {
  return isNode(prop.key) ? prop.key : undefined;
}

export function isArrayExpression(node: unknown): node is AstNode {
  return isAstNode(node) && node.type === "ArrayExpression";
}

export function arrayElements(node: AstNode): AstNode[] {
  return isArrayExpression(node) && Array.isArray(node.elements) ? node.elements.filter((e): e is AstNode => isAstNode(e)) : [];
}

/** Every `<calleeName>(...)` call in the file, by the callee's plain identifier name. */
export function findCalls(root: AstNode, calleeName: string): AstNode[] {
  return findAll(root, "CallExpression").filter((node) => {
    const callee = node.callee;
    return isAstNode(callee) && callee.type === "Identifier" && callee.name === calleeName;
  });
}

export function firstArgument(call: AstNode): AstNode | undefined {
  return Array.isArray(call.arguments) && isAstNode(call.arguments[0]) ? call.arguments[0] : undefined;
}

export function span(node: AstNode): { start: number; end: number } {
  if (typeof node.start !== "number" || typeof node.end !== "number") throw new Error(`ast node "${node.type}" has no source position`);
  return { start: node.start, end: node.end };
}
