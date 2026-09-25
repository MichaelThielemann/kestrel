import type { Edit } from "./report.ts";

interface Brace {
  keyEnd: number;
  openBrace: number;
  closeBrace: number;
}

function findObjectBlock(source: string, key: string): Brace | undefined {
  const keyPattern = new RegExp(`"${key}"\\s*:\\s*\\{`, "g");
  const match = keyPattern.exec(source);
  if (!match) return undefined;
  const openBrace = source.indexOf("{", match.index);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openBrace; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return { keyEnd: match.index + match[0].length, openBrace, closeBrace: i };
    }
  }
  return undefined;
}

function indentOf(source: string, pos: number): string {
  const lineStart = source.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "  ";
}

function containerIndent(source: string, openBrace: number): string {
  return indentOf(source, openBrace);
}

function childIndent(source: string, openBrace: number, closeBrace: number): string {
  const inner = source.slice(openBrace + 1, closeBrace);
  const contentIndex = /\S/.exec(inner)?.index;
  if (contentIndex !== undefined) return indentOf(source, openBrace + 2 + contentIndex);
  return `${containerIndent(source, openBrace)}  `;
}

function entries(block: string): Array<{ name: string; valueStart: number; valueEnd: number }> {
  const out: Array<{ name: string; valueStart: number; valueEnd: number }> = [];
  const pattern = /"([^"\\]+)"\s*:\s*"([^"\\]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block))) {
    const valueStart = match.index + match[0].indexOf(match[2]!, match[0].indexOf(":"));
    out.push({ name: match[1]!, valueStart, valueEnd: valueStart + match[2]!.length });
  }
  return out;
}

/** Sets (or adds) `name`'s range in the named dependency map; the map is created if the map key itself is absent. */
export function setDependencyRange(file: string, source: string, mapKey: "dependencies" | "devDependencies" | "peerDependencies", name: string, range: string): Edit {
  const block = findObjectBlock(source, mapKey);
  if (block === undefined) {
    const rootOpen = source.indexOf("{");
    const insertAt = source.lastIndexOf("}");
    const indent = childIndent(source, rootOpen, insertAt);
    const before = source.slice(0, insertAt).replace(/\s*$/, "");
    const needsComma = !before.endsWith("{") && !before.endsWith(",");
    return { file, start: insertAt, end: insertAt, text: `${needsComma ? "," : ""}\n${indent}"${mapKey}": {\n${indent}  "${name}": "${range}"\n${indent}}\n${containerIndent(source, rootOpen)}` };
  }
  const inner = source.slice(block.openBrace + 1, block.closeBrace);
  const existing = entries(inner).find((e) => e.name === name);
  if (existing) {
    return { file, start: block.openBrace + 1 + existing.valueStart, end: block.openBrace + 1 + existing.valueEnd, text: range };
  }
  const list = entries(inner);
  const indent = childIndent(source, block.openBrace, block.closeBrace);
  const sorted = list.every((e, i) => i === 0 || list[i - 1]!.name.localeCompare(e.name) <= 0);
  const newLine = `${indent}"${name}": "${range}"`;
  if (list.length === 0) {
    return { file, start: block.openBrace + 1, end: block.closeBrace, text: `\n${newLine}\n${containerIndent(source, block.openBrace)}` };
  }
  if (sorted) {
    const insertBefore = list.find((e) => name.localeCompare(e.name) < 0);
    if (insertBefore) {
      const lineStart = source.lastIndexOf("\n", block.openBrace + 1 + insertBefore.valueStart) + 1;
      return { file, start: lineStart, end: lineStart, text: `${newLine},\n` };
    }
  }
  const last = list[list.length - 1]!;
  const afterValue = block.openBrace + 1 + last.valueEnd + 1;
  const lineEnd = source.indexOf("\n", afterValue);
  const insertAt = lineEnd === -1 ? block.closeBrace : lineEnd + 1;
  const between = source.slice(afterValue, insertAt);
  const needsComma = !between.trimStart().startsWith(",");
  return { file, start: afterValue, end: insertAt, text: `${needsComma ? "," : ""}${between}${newLine}\n` };
}

/** Removes a dependency from the named map when present; `undefined` when it is not listed there. */
export function removeDependency(file: string, source: string, mapKey: "dependencies" | "devDependencies" | "peerDependencies", name: string): Edit | undefined {
  const block = findObjectBlock(source, mapKey);
  if (block === undefined) return undefined;
  const inner = source.slice(block.openBrace + 1, block.closeBrace);
  const pattern = new RegExp(`\\n?[ \\t]*"${name}"\\s*:\\s*"[^"]*",?`);
  const match = pattern.exec(inner);
  if (!match) return undefined;
  return { file, start: block.openBrace + 1 + match.index, end: block.openBrace + 1 + match.index + match[0].length, text: "" };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces one dependency with another in the named map, in a single edit that swaps the key and
 * value text in place and never touches a neighbouring comma — a separate remove-this plus
 * append-that computes both against the same unedited text and can leave two edits fighting over
 * the same comma when the removed entry was the last one. Falls back to a plain remove-and-set
 * when `to` already has its own entry elsewhere in the map, since an in-place swap would then
 * create a duplicate key.
 */
export function replaceDependency(file: string, source: string, mapKey: "dependencies" | "devDependencies" | "peerDependencies", from: string, to: string, range: string): Edit[] {
  const block = findObjectBlock(source, mapKey);
  if (block === undefined) return [setDependencyRange(file, source, mapKey, to, range)];
  const inner = source.slice(block.openBrace + 1, block.closeBrace);
  if (!entries(inner).some((e) => e.name === to)) {
    const pattern = new RegExp(`"${escapeRegExp(from)}"(\\s*:\\s*)"[^"]*"`);
    const match = pattern.exec(inner);
    if (match) {
      const start = block.openBrace + 1 + match.index;
      const end = start + match[0].length;
      return [{ file, start, end, text: `"${to}"${match[1]}"${range}"` }];
    }
  }
  const edits: Edit[] = [setDependencyRange(file, source, mapKey, to, range)];
  const removed = removeDependency(file, source, mapKey, from);
  if (removed) edits.push(removed);
  return edits;
}
