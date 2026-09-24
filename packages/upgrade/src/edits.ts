import type { Edit } from "./report.ts";
import { findAll, objectProperty, objectPropertyNodes, parseTs, propertyKeyName, span, stringValue, walk, type AstNode } from "./ast.ts";

function isArray(node: AstNode | undefined): node is AstNode {
  return node?.type === "ArrayExpression";
}

function elements(array: AstNode): AstNode[] {
  return Array.isArray(array.elements) ? array.elements.filter((e): e is AstNode => typeof e === "object" && e !== null) : [];
}

function lineOf(source: string, pos: number): { lineStart: number; indent: string } {
  const start = source.lastIndexOf("\n", pos - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(start));
  return { lineStart: start, indent: match?.[0] ?? "" };
}

function isMultiline(source: string, array: AstNode): boolean {
  const { start, end } = span(array);
  return source.slice(start, end).includes("\n");
}

function quoteOf(source: string, node: AstNode | undefined): '"' | "'" {
  if (node === undefined) return '"';
  const { start } = span(node);
  return source[start] === "'" ? "'" : '"';
}

function findModuleArray(root: AstNode): AstNode | undefined {
  let found: AstNode | undefined;
  walk(root, (node) => {
    if (found || node.type !== "ObjectExpression") return;
    const modules = objectProperty(node, "modules");
    if (isArray(modules)) found = modules;
  });
  return found;
}

function entryUse(entry: AstNode): string | undefined {
  return stringValue(objectProperty(entry, "use"));
}

/** Locates the `modules: [...]` array of a `defineConfig({...})` call or a default-exported config object literal. */
export function moduleListArray(source: string): AstNode | undefined {
  return findModuleArray(parseTs(source));
}

function entryLiteral(quote: '"' | "'", use: string, config?: string): string {
  return config === undefined ? `{ use: ${quote}${use}${quote} }` : `{ use: ${quote}${use}${quote}, config: ${config} }`;
}

export interface InsertModuleEntryOptions {
  anchorUse: string;
  position: "before" | "after";
  use: string;
  config?: string;
}

/** Inserts a module-list entry next to the entry named `anchorUse`; `undefined` when the array or the anchor cannot be found (the finding falls back to manual). */
export function insertModuleListEntry(file: string, source: string, options: InsertModuleEntryOptions): Edit | undefined {
  const array = moduleListArray(source);
  if (array === undefined) return undefined;
  const entryNodes = elements(array);
  if (entryNodes.some((e) => entryUse(e) === options.use)) return undefined;
  const anchorIndex = entryNodes.findIndex((e) => entryUse(e) === options.anchorUse);
  if (anchorIndex === -1) return undefined;
  const anchor = entryNodes[anchorIndex]!;
  const quote = quoteOf(source, entryNodes.find((e) => entryUse(e) !== undefined));
  const literal = entryLiteral(quote, options.use, options.config);
  const multiline = isMultiline(source, array);
  if (!multiline) {
    const { start, end } = span(anchor);
    return options.position === "after" ? { file, start: end, end, text: `, ${literal}` } : { file, start, end: start, text: `${literal}, ` };
  }
  const { indent } = lineOf(source, span(anchor).start);
  if (options.position === "after") {
    const { end } = span(anchor);
    const lineEnd = source.indexOf("\n", end);
    const insertAt = lineEnd === -1 ? end : lineEnd + 1;
    return { file, start: insertAt, end: insertAt, text: `${indent}${literal},\n` };
  }
  const { lineStart } = lineOf(source, span(anchor).start);
  return { file, start: lineStart, end: lineStart, text: `${indent}${literal},\n` };
}

export interface SetModuleConfigOptions {
  use: string;
  assignments: Record<string, string>;
}

/**
 * Sets one or more properties on a module-list entry's `config` object literal, creating
 * `config: {}` first if the entry has none. An assignment whose key already exists replaces that
 * property's whole `key: value` text instead of appending a duplicate.
 */
export function setModuleConfigProperties(file: string, source: string, options: SetModuleConfigOptions): Edit | undefined {
  const array = moduleListArray(source);
  if (array === undefined) return undefined;
  const entry = elements(array).find((e) => entryUse(e) === options.use);
  if (entry === undefined) return undefined;
  const config = objectProperty(entry, "config");
  if (config === undefined || config.type !== "ObjectExpression") {
    const props = Object.entries(options.assignments)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");
    const { end } = span(entry);
    const closeBrace = source.lastIndexOf("}", end);
    let insertAt = closeBrace;
    while (insertAt > 0 && /\s/.test(source[insertAt - 1] ?? "")) insertAt--;
    return { file, start: insertAt, end: closeBrace, text: `, config: { ${props} } ` };
  }
  const remaining = new Map(Object.entries(options.assignments));
  const parts: string[] = [];
  for (const prop of objectPropertyNodes(config)) {
    const key = propertyKeyName(prop);
    if (key !== undefined && remaining.has(key)) {
      parts.push(`${key}: ${remaining.get(key)}`);
      remaining.delete(key);
    } else {
      const { start: propStart, end: propEnd } = span(prop);
      parts.push(source.slice(propStart, propEnd));
    }
  }
  for (const [key, value] of remaining) parts.push(`${key}: ${value}`);
  const { start, end } = span(config);
  return { file, start, end, text: `{ ${parts.join(", ")} }` };
}

/** Every string-literal occurrence of `from` in the file becomes `to`, keeping the original quote character. */
export function renameStringLiterals(file: string, source: string, from: string, to: string): Edit[] {
  const root = parseTs(source);
  const literals = findAll(root, "StringLiteral").filter((n) => n.value === from);
  return literals.map((node) => {
    const { start, end } = span(node);
    const quote = source[start] === "'" ? "'" : '"';
    return { file, start, end, text: `${quote}${to}${quote}` };
  });
}
