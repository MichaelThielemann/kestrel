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
    const indent = indentOf(source, rootOpen + 1);
    const insertAt = source.lastIndexOf("}");
    const before = source.slice(0, insertAt).replace(/\s*$/, "");
    const needsComma = !before.endsWith("{") && !before.endsWith(",");
    return { file, start: insertAt, end: insertAt, text: `${needsComma ? "," : ""}\n${indent}"${mapKey}": {\n${indent}  "${name}": "${range}"\n${indent}}\n${indent.slice(0, -2)}` };
  }
  const inner = source.slice(block.openBrace + 1, block.closeBrace);
  const existing = entries(inner).find((e) => e.name === name);
  if (existing) {
    return { file, start: block.openBrace + 1 + existing.valueStart, end: block.openBrace + 1 + existing.valueEnd, text: range };
  }
  const list = entries(inner);
  const indent = indentOf(source, block.openBrace + 1) || "  ";
  const sorted = list.every((e, i) => i === 0 || list[i - 1]!.name.localeCompare(e.name) <= 0);
  const newLine = `${indent}"${name}": "${range}"`;
  if (list.length === 0) {
    return { file, start: block.openBrace + 1, end: block.closeBrace, text: `\n${newLine}\n${indent.slice(0, -2)}` };
  }
  if (sorted) {
    const insertBefore = list.find((e) => name.localeCompare(e.name) < 0);
    if (insertBefore) {
      const lineStart = source.lastIndexOf("\n", block.openBrace + 1 + insertBefore.valueStart) + 1;
      return { file, start: lineStart, end: lineStart, text: `${newLine},\n` };
    }
  }
  const last = list[list.length - 1]!;
  const lineEnd = source.indexOf("\n", block.openBrace + 1 + last.valueEnd);
  const insertAt = lineEnd === -1 ? block.closeBrace : lineEnd + 1;
  return { file, start: insertAt, end: insertAt, text: `${newLine},\n` };
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
