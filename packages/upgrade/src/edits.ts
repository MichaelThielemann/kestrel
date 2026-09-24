import type { Edit } from "./report.ts";
import { findAll, findCalls, firstArgument, isAstNode, objectProperty, objectPropertyNodes, parseTs, propertyKeyName, propertyKeyNode, span, stringValue, walk, type AstNode } from "./ast.ts";

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

function eolOf(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
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

function entryUseNode(entry: AstNode): AstNode | undefined {
  return objectProperty(entry, "use");
}

/** Locates the `modules: [...]` array of a `defineConfig({...})` call or a default-exported config object literal. */
export function moduleListArray(source: string): AstNode | undefined {
  return findModuleArray(parseTs(source));
}

function entryLiteral(quote: '"' | "'", use: string, config?: string): string {
  return config === undefined ? `{ use: ${quote}${use}${quote} }` : `{ use: ${quote}${use}${quote}, config: ${config} }`;
}

export interface ReplaceModuleEntryOptions {
  use: string;
  newUse: string;
  config?: string;
}

/** Replaces a module-list entry named `use` with a new `{ use: newUse, config }` literal; `undefined` when the array or the entry cannot be found. */
export function replaceModuleListEntry(file: string, source: string, options: ReplaceModuleEntryOptions): Edit | undefined {
  const array = moduleListArray(source);
  if (array === undefined) return undefined;
  const entry = elements(array).find((e) => entryUse(e) === options.use);
  if (entry === undefined) return undefined;
  const quote = quoteOf(source, entryUseNode(entry));
  const { start, end } = span(entry);
  return { file, start, end, text: entryLiteral(quote, options.newUse, options.config) };
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
  const quote = quoteOf(source, entryNodes.map(entryUseNode).find((n) => n !== undefined));
  const literal = entryLiteral(quote, options.use, options.config);
  return insertRelativeToAnchor(file, source, array, anchor, options.position, literal);
}

export interface SetModuleConfigOptions {
  use: string;
  assignments: Record<string, string>;
}

/**
 * Sets one or more properties on a module-list entry's `config` object literal, creating
 * `config: {}` first if the entry has none. An assignment whose key already exists splices just
 * that property's value; a new one is appended after the last property. `undefined` when the
 * config literal has a spread or a method — rebuilding it as plain properties would silently drop
 * either, so the caller's finding falls back to manual instead.
 */
export function setModuleConfigProperties(file: string, source: string, options: SetModuleConfigOptions): Edit[] | undefined {
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
    return [{ file, start: insertAt, end: closeBrace, text: `, config: { ${props} } ` }];
  }
  const members = Array.isArray(config.properties) ? config.properties : [];
  if (members.some((m) => isAstNode(m) && m.type !== "ObjectProperty")) return undefined;
  const remaining = new Map(Object.entries(options.assignments));
  const edits: Edit[] = [];
  for (const prop of objectPropertyNodes(config)) {
    const key = propertyKeyName(prop);
    const value = key === undefined ? undefined : remaining.get(key);
    if (key === undefined || value === undefined) continue;
    remaining.delete(key);
    if (!isAstNode(prop.value)) continue;
    const { start, end } = span(prop.value);
    edits.push({ file, start, end, text: value });
  }
  if (remaining.size > 0) {
    const text = [...remaining].map(([key, value]) => `${key}: ${value}`).join(", ");
    edits.push(appendProperty(source, config, file, text));
  }
  return edits;
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

function pipelineStepsArrays(root: AstNode, pipelineName: string): AstNode[] {
  const arrays: AstNode[] = [];
  for (const call of findCalls(root, "definePipeline")) {
    const arg = firstArgument(call);
    if (arg === undefined || arg.type !== "ObjectExpression") continue;
    if (stringValue(objectProperty(arg, "name")) !== pipelineName) continue;
    const steps = objectProperty(arg, "steps");
    if (isArray(steps)) arrays.push(steps);
  }
  return arrays;
}

function stepArraysOf(top: AstNode): AstNode[] {
  const arrays = [top];
  for (const el of elements(top)) {
    if (el.type !== "ObjectExpression") continue;
    const atomic = objectProperty(el, "atomic");
    if (isArray(atomic)) arrays.push(atomic);
  }
  return arrays;
}

function insertRelativeToAnchor(file: string, source: string, array: AstNode, anchor: AstNode, position: "before" | "after", literal: string): Edit {
  const eol = eolOf(source);
  if (!isMultiline(source, array)) {
    const { start, end } = span(anchor);
    return position === "after" ? { file, start: end, end, text: `, ${literal}` } : { file, start, end: start, text: `${literal}, ` };
  }
  const { indent } = lineOf(source, span(anchor).start);
  if (position === "after") {
    const { end } = span(anchor);
    const nlIndex = source.indexOf("\n", end);
    if (nlIndex === -1) return { file, start: end, end, text: `, ${literal}` };
    const lineEnd = source[nlIndex - 1] === "\r" ? nlIndex - 1 : nlIndex;
    const insertAt = nlIndex + 1;
    const restOfLine = source.slice(end, lineEnd);
    const needsComma = !restOfLine.includes(",");
    return { file, start: end, end: insertAt, text: `${needsComma ? "," : ""}${restOfLine}${eol}${indent}${literal},${eol}` };
  }
  const { lineStart } = lineOf(source, span(anchor).start);
  return { file, start: lineStart, end: lineStart, text: `${indent}${literal},${eol}` };
}

export interface InsertStepOptions {
  pipelineName: string;
  anchorStep: string;
  position: "before" | "after";
  newStep: string;
}

/** Inserts `newStep` next to `anchorStep` in the named pipeline's step list, including inside an atomic group; `undefined` when the pipeline, the array or the anchor cannot be found, or `newStep` is already there. */
export function insertPipelineStep(file: string, source: string, options: InsertStepOptions): Edit | undefined {
  const root = parseTs(source);
  for (const top of pipelineStepsArrays(root, options.pipelineName)) {
    for (const array of stepArraysOf(top)) {
      const stepElements = elements(array);
      if (stepElements.some((e) => stringValue(e) === options.newStep)) return undefined;
      const anchorIndex = stepElements.findIndex((e) => stringValue(e) === options.anchorStep);
      if (anchorIndex === -1) continue;
      const anchor = stepElements[anchorIndex]!;
      const quote = quoteOf(source, stepElements.find((e) => stringValue(e) !== undefined));
      const literal = `${quote}${options.newStep}${quote}`;
      return insertRelativeToAnchor(file, source, array, anchor, options.position, literal);
    }
  }
  return undefined;
}

export interface InsertAfterEmitOptions {
  pipelineName: string;
  emitStep: string;
  newStep: string;
}

/**
 * Inserts `newStep` after `emitStep` in the named pipeline — after the whole atomic group in the
 * top-level step list when the emit sits inside one, never inside it, since a step placed there
 * must declare `atomicSafe` and a relay is not. `undefined` when the pipeline, the step or the
 * array cannot be found, or `newStep` is already in place.
 */
export function insertStepAfterEmitOutsideGroup(file: string, source: string, options: InsertAfterEmitOptions): Edit | undefined {
  const root = parseTs(source);
  for (const top of pipelineStepsArrays(root, options.pipelineName)) {
    const topElements = elements(top);
    for (let i = topElements.length - 1; i >= 0; i--) {
      const el = topElements[i]!;
      let matched = stringValue(el) === options.emitStep;
      if (!matched && el.type === "ObjectExpression") {
        const atomic = objectProperty(el, "atomic");
        matched = isArray(atomic) && elements(atomic).some((e) => stringValue(e) === options.emitStep);
      }
      if (!matched) continue;
      const next = topElements[i + 1];
      if (next !== undefined && stringValue(next) === options.newStep) return undefined;
      const quote = quoteOf(source, topElements.find((e) => stringValue(e) !== undefined));
      return insertRelativeToAnchor(file, source, top, el, "after", `${quote}${options.newStep}${quote}`);
    }
  }
  return undefined;
}

/** Adds `events` to a local module's `emits: [...]`, creating the property when it has none; already-listed events are skipped. `undefined` when there is nothing left to add, or no `defineModule({...})` call is found. */
export function addModuleEmits(file: string, source: string, events: readonly string[]): Edit | undefined {
  const root = parseTs(source);
  const calls = findCalls(root, "defineModule");
  const arg = calls[0] && firstArgument(calls[0]);
  if (arg === undefined || arg.type !== "ObjectExpression") return undefined;
  const existing = objectProperty(arg, "emits");
  if (existing !== undefined && isArray(existing)) {
    const already = new Set(elements(existing).flatMap((e) => (stringValue(e) !== undefined ? [stringValue(e)!] : [])));
    const toAdd = events.filter((e) => !already.has(e));
    if (toAdd.length === 0) return undefined;
    const quote = quoteOf(source, elements(existing)[0]);
    const insertion = toAdd.map((e) => `${quote}${e}${quote}`).join(", ");
    const existingElements = elements(existing);
    if (existingElements.length === 0) {
      const { start, end } = span(existing);
      return { file, start: start + 1, end: end - 1, text: insertion };
    }
    const { end } = span(existingElements[existingElements.length - 1]!);
    return { file, start: end, end, text: `, ${insertion}` };
  }
  const props = objectPropertyNodes(arg);
  const literal = `[${events.map((e) => `"${e}"`).join(", ")}]`;
  if (props.length === 0) {
    const { start, end } = span(arg);
    return { file, start: start + 1, end: end - 1, text: `emits: ${literal}` };
  }
  const first = props[0]!;
  const { end } = span(first);
  if (!isMultiline(source, arg)) return { file, start: end, end, text: `, emits: ${literal}` };
  const eol = eolOf(source);
  const { indent } = lineOf(source, span(first).start);
  const nlIndex = source.indexOf("\n", end);
  if (nlIndex === -1) return { file, start: end, end, text: `, emits: ${literal}` };
  const lineEnd = source[nlIndex - 1] === "\r" ? nlIndex - 1 : nlIndex;
  const insertAt = nlIndex + 1;
  const restOfLine = source.slice(end, lineEnd);
  const needsComma = !restOfLine.includes(",");
  return { file, start: end, end: insertAt, text: `${needsComma ? "," : ""}${restOfLine}${eol}${indent}emits: ${literal},${eol}` };
}

function describeObjectsOf(root: AstNode): AstNode[] {
  const bodies: AstNode[] = [];
  walk(root, (node) => {
    if (node.type !== "ObjectProperty" || propertyKeyName(node) !== "describe") return;
    const value = node.value;
    if (!isAstNode(value)) return;
    const body = value.type === "ArrowFunctionExpression" && isAstNode(value.body) ? value.body : value;
    if (body.type === "ObjectExpression") bodies.push(body);
  });
  return bodies;
}

function describeStepObject(root: AstNode, stepName: string): AstNode | undefined {
  for (const body of describeObjectsOf(root)) {
    const entry = objectProperty(body, stepName);
    if (entry?.type === "ObjectExpression") return entry;
  }
  return undefined;
}

/** Every step key and its (non-factory) describe object literal, across every `describe: () => ({...})` in the file. */
export function allDescribedSteps(source: string): Array<{ key: string; node: AstNode }> {
  const out: Array<{ key: string; node: AstNode }> = [];
  for (const body of describeObjectsOf(parseTs(source))) {
    for (const prop of objectPropertyNodes(body)) {
      const key = propertyKeyName(prop);
      if (key !== undefined && isAstNode(prop.value) && prop.value.type === "ObjectExpression") out.push({ key, node: prop.value });
    }
  }
  return out;
}

function appendProperty(source: string, obj: AstNode, file: string, text: string): Edit {
  const props = objectPropertyNodes(obj);
  if (props.length === 0) {
    const { start, end } = span(obj);
    return { file, start: start + 1, end: end - 1, text };
  }
  const { end } = span(props[props.length - 1]!);
  return { file, start: end, end, text: `, ${text}` };
}

/** Adds `binary: true` to a non-factory step's `describe()` entry; `undefined` when the step, its describe object or the module cannot be located, or `binary` is already set. */
export function markStepBinary(file: string, source: string, stepName: string): Edit | undefined {
  const obj = describeStepObject(parseTs(source), stepName);
  if (obj === undefined || objectProperty(obj, "binary") !== undefined) return undefined;
  return appendProperty(source, obj, file, "binary: true");
}

/** Sets (or adds) `required` on a non-factory step's `output` schema; `undefined` when the step or its `output` object cannot be located this way — a nested schema path stays manual. */
export function setStepRequired(file: string, source: string, stepName: string, properties: readonly string[]): Edit | undefined {
  const obj = describeStepObject(parseTs(source), stepName);
  const output = obj && objectProperty(obj, "output");
  if (output === undefined || output.type !== "ObjectExpression") return undefined;
  const literal = `[${properties.map((p) => `"${p}"`).join(", ")}]`;
  const existing = objectProperty(output, "required");
  if (existing !== undefined) {
    const { start, end } = span(existing);
    return { file, start, end, text: literal };
  }
  return appendProperty(source, output, file, `required: ${literal}`);
}

export interface RenameContentFieldOptions {
  use: string;
  typeName: string;
  from: string;
  to: string;
}

/** Renames a content type's field key, `config.types.<typeName>.fields.<from>`, on a module-list entry named `use`. */
export function renameContentField(file: string, source: string, options: RenameContentFieldOptions): Edit | undefined {
  const array = moduleListArray(source);
  if (array === undefined) return undefined;
  const entry = elements(array).find((e) => entryUse(e) === options.use);
  const config = entry && objectProperty(entry, "config");
  const types = config?.type === "ObjectExpression" ? objectProperty(config, "types") : undefined;
  const typeObj = types?.type === "ObjectExpression" ? objectProperty(types, options.typeName) : undefined;
  const fields = typeObj?.type === "ObjectExpression" ? objectProperty(typeObj, "fields") : undefined;
  if (fields === undefined || fields.type !== "ObjectExpression") return undefined;
  const prop = objectPropertyNodes(fields).find((p) => propertyKeyName(p) === options.from);
  const key = prop && propertyKeyNode(prop);
  if (key === undefined) return undefined;
  const { start, end } = span(key);
  if (key.type === "StringLiteral") {
    const quote = source[start] === "'" ? "'" : '"';
    return { file, start, end, text: `${quote}${options.to}${quote}` };
  }
  return { file, start, end, text: options.to };
}

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function packageIdentifier(packageName: string): string {
  return kebabToCamel(packageName.replace(/^@[^/]+\/kestrel-/, ""));
}

function findModulesIdentifierArray(root: AstNode): AstNode | undefined {
  let found: AstNode | undefined;
  walk(root, (node) => {
    if (found || node.type !== "VariableDeclarator") return;
    const rawInit = node.init;
    let init: AstNode | undefined = isAstNode(rawInit) ? rawInit : undefined;
    if (init !== undefined && init.type === "TSAsExpression" && isAstNode(init.expression)) init = init.expression;
    if (!isArray(init)) return;
    const els = elements(init);
    if (els.length > 0 && els.every((e) => e.type === "Identifier")) found = init;
  });
  return found;
}

function insertLineAfter(file: string, source: string, node: AstNode, line: string): Edit {
  const eol = eolOf(source);
  const { end } = span(node);
  const nlIndex = source.indexOf("\n", end);
  const insertAt = nlIndex === -1 ? source.length : nlIndex + 1;
  return { file, start: insertAt, end: insertAt, text: `${line}${eol}` };
}

/**
 * Adds a default-imported module to a `modules.ts`-style file: a plain array of module-object
 * identifiers (`const modules = [a, b] as const`) a project derives its `KnownStep` union from,
 * separate from `kestrel.config.ts`'s runtime `use` strings. `undefined` when the package is
 * already imported, or the file is not shaped like this array-of-identifiers pattern at all.
 */
export function insertModulesTsEntry(file: string, source: string, packageName: string): Edit[] | undefined {
  if (source.includes(`"${packageName}"`) || source.includes(`'${packageName}'`)) return undefined;
  const root = parseTs(source);
  const array = findModulesIdentifierArray(root);
  if (array === undefined) return undefined;
  const imports = findAll(root, "ImportDeclaration");
  const lastImport = imports[imports.length - 1];
  if (lastImport === undefined) return undefined;
  const firstImportSource = imports[0]?.source;
  const quote = quoteOf(source, isAstNode(firstImportSource) ? firstImportSource : undefined);
  const identifier = packageIdentifier(packageName);
  const importEdit = insertLineAfter(file, source, lastImport, `import ${identifier} from ${quote}${packageName}${quote};`);
  const els = elements(array);
  const arrayEdit = insertRelativeToAnchor(file, source, array, els[els.length - 1]!, "after", identifier);
  return [importEdit, arrayEdit];
}
