import { relative, resolve } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { findAll, isAstNode, parseTs, span, walk, type AstNode } from "./ast.ts";
import { isRecord } from "./guards.ts";
import { setDependencyRange } from "./packageJson.ts";
import type { SourceRule, SourceRuleContext } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { projectPackageJsonFiles, projectSourceFiles } from "./ruleContractHelpers.ts";
import { finding, packageJsonPath, upgradingDocs } from "./ruleHelpers.ts";

const ZOD_RANGE = "^4.6.6";
const FIXED: readonly [number, number, number] = [4, 6, 6];
const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "peerDependencies"] as const;
const PARSED_DEFAULT_FACTORIES = new Set(["object", "strictObject", "looseObject", "union", "discriminatedUnion", "intersection"]);
const COLLECTION_FACTORIES = new Set(["array", "record", "partialRecord", "looseRecord"]);
const UNTRACEABLE_FACTORIES = new Set(["preprocess", "lazy", "pipe", "custom"]);
const UNTRACEABLE_METHODS = new Set(["pipe", "transform"]);
const DEFAULT_METHODS = new Set(["default", "prefault"]);
const KNOWN_GLOBALS = new Set(["undefined", "Infinity", "NaN", "Number", "String", "Boolean", "Math", "Object", "Array", "Date", "RegExp", "JSON"]);
const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const PLAIN_LITERALS = new Set(["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral", "BigIntLiteral"]);
const DESCRIPTION_DROPPING = new Set(["strict", "passthrough", "strip", "catchall", "extend", "merge", "partial", "required", "pick", "omit", "safeExtend", "or", "and", "extract", "exclude", "rest"]);
const ZOD_IMPORT = /["']zod["']/;

type Version = readonly [number, number, number];

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function lowerBound(branch: string): Version | undefined {
  const trimmed = branch.trim();
  if (trimmed.startsWith("<")) return [0, 0, 0];
  const match = /(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/.exec(trimmed);
  if (!match) return undefined;
  const part = (value: string | undefined): number => (value === undefined || !/^\d+$/.test(value) ? 0 : Number(value));
  return [Number(match[1]), part(match[2]), part(match[3])];
}

/** True when the range admits a zod release other than a 4.x at or above 4.6.6; `undefined` when it names no version this rule can read (`latest`, `catalog:`, `workspace:*`, …). */
export function admitsUnfixedZod(range: string): boolean | undefined {
  if (range.includes(":")) return undefined;
  const bounds = range.split("||").map(lowerBound);
  if (bounds.every((bound) => bound === undefined)) return undefined;
  return bounds.some((bound) => bound !== undefined && (bound[0] !== FIXED[0] || compare(bound, FIXED) < 0));
}

/** `deps/zod-range`: a `zod` dependency range that admits a release below 4.6.6 or another major, in the project's `package.json` and in every other `package.json` of the project outside `node_modules`; kestrel 6 reads module config schemas built with zod 4. */
export const zodRangeRule: SourceRule = {
  id: "deps/zod-range",
  needs: "source",
  check(ctx) {
    const rootFile = packageJsonPath(ctx);
    const files = [rootFile, ...projectPackageJsonFiles(ctx.scratch).filter((file) => resolve(file) !== resolve(rootFile))];
    return files.flatMap((file) => zodRangeFindings(ctx, file, file === rootFile ? undefined : relative(ctx.scratch, file)));
  },
};

function zodRangeFindings(ctx: SourceRuleContext, pkgFile: string, label: string | undefined): Finding[] {
  const source = ctx.readFile(pkgFile);
  if (source === undefined) return [];
  let pkg: unknown;
  try {
    pkg = boundaryCast<unknown>(JSON.parse(source), "json");
  } catch {
    return [];
  }
  if (!isRecord(pkg)) return [];
  const findings: Finding[] = [];
  for (const map of DEPENDENCY_MAPS) {
    const deps = pkg[map];
    const range = isRecord(deps) ? deps.zod : undefined;
    if (typeof range !== "string" || admitsUnfixedZod(range) !== true) continue;
    const where = label === undefined ? map : `${map} of ${label}`;
    findings.push(
      finding(
        label === undefined ? `deps/zod-range:${map}` : `deps/zod-range:${label}:${map}`,
        "deps/zod-range",
        `zod is at ${range} in ${where}; kestrel 6 reads module config schemas built with zod 4.6.6 or later`,
        `set zod to "${ZOD_RANGE}" in ${where}`,
        { file: pkgFile, module: "zod" },
        [setDependencyRange(pkgFile, source, map, "zod", ZOD_RANGE)],
        upgradingDocs("deps-zod-range"),
      ),
    );
  }
  return findings;
}

function importedName(specifier: AstNode): string | undefined {
  const imported = specifier.imported;
  if (!isAstNode(imported)) return undefined;
  if (imported.type === "Identifier" && typeof imported.name === "string") return imported.name;
  return imported.type === "StringLiteral" && typeof imported.value === "string" ? imported.value : undefined;
}

function zodNamespaces(root: AstNode): Set<string> {
  const names = new Set<string>();
  for (const decl of findAll(root, "ImportDeclaration")) {
    if (decl.importKind === "type" || !isAstNode(decl.source) || decl.source.value !== "zod") continue;
    const specifiers: unknown[] = Array.isArray(decl.specifiers) ? decl.specifiers : [];
    for (const specifier of specifiers) {
      if (!isAstNode(specifier) || specifier.importKind === "type" || !isAstNode(specifier.local) || typeof specifier.local.name !== "string") continue;
      const isNamespace = specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier";
      if (isNamespace || (specifier.type === "ImportSpecifier" && importedName(specifier) === "z")) names.add(specifier.local.name);
    }
  }
  return names;
}

interface MemberCall {
  call: AstNode;
  object: AstNode;
  property: AstNode;
  name: string;
  args: AstNode[];
}

function memberCall(node: AstNode): MemberCall | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = node.callee;
  if (!isAstNode(callee) || callee.type !== "MemberExpression" || callee.computed === true) return undefined;
  const { object, property } = callee;
  if (!isAstNode(object) || !isAstNode(property) || property.type !== "Identifier" || typeof property.name !== "string") return undefined;
  const args = Array.isArray(node.arguments) ? node.arguments.filter((a): a is AstNode => isAstNode(a)) : [];
  return { call: node, object, property, name: property.name, args };
}

function namespaceOf(node: AstNode, namespaces: ReadonlySet<string>): string | undefined {
  return node.type === "Identifier" && typeof node.name === "string" && namespaces.has(node.name) ? node.name : undefined;
}

type ReceiverKind = "parsed" | "collection" | "other" | "unknown";

interface Receiver {
  kind: ReceiverKind;
  nodes: AstNode[];
}

const MAX_BINDING_DEPTH = 8;

function localBindings(root: AstNode): Map<string, AstNode | undefined> {
  const bindings = new Map<string, AstNode | undefined>();
  for (const declarator of findAll(root, "VariableDeclarator")) {
    const { id, init } = declarator;
    if (!isAstNode(id) || id.type !== "Identifier" || typeof id.name !== "string") continue;
    bindings.set(id.name, bindings.has(id.name) || !isAstNode(init) ? undefined : init);
  }
  return bindings;
}

function withoutTypeWrappers(node: AstNode): AstNode {
  let current = node;
  while ((current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression" || current.type === "TSNonNullExpression" || current.type === "ParenthesizedExpression") && isAstNode(current.expression)) current = current.expression;
  return current;
}

function factoryKind(name: string): ReceiverKind {
  if (UNTRACEABLE_FACTORIES.has(name)) return "unknown";
  if (PARSED_DEFAULT_FACTORIES.has(name)) return "parsed";
  return COLLECTION_FACTORIES.has(name) ? "collection" : "other";
}

function traceReceiver(receiver: AstNode, namespaces: ReadonlySet<string>, bindings: ReadonlyMap<string, AstNode | undefined>, depth = 0): Receiver {
  let node = withoutTypeWrappers(receiver);
  const nodes = [node];
  for (;;) {
    const call = memberCall(node);
    if (call !== undefined) {
      if (namespaceOf(call.object, namespaces) !== undefined) return { kind: factoryKind(call.name), nodes };
      if (UNTRACEABLE_METHODS.has(call.name)) return { kind: "unknown", nodes };
      node = withoutTypeWrappers(call.object);
      continue;
    }
    if (node.type !== "Identifier" || typeof node.name !== "string" || namespaces.has(node.name)) return { kind: "unknown", nodes };
    const init = bindings.get(node.name);
    if (init === undefined || depth >= MAX_BINDING_DEPTH) return { kind: "unknown", nodes };
    const traced = traceReceiver(init, namespaces, bindings, depth + 1);
    return { kind: traced.kind, nodes: [...nodes, ...traced.nodes] };
  }
}

function isReference(node: AstNode, parent: AstNode | undefined): boolean {
  if (node.type !== "Identifier" || typeof node.name !== "string" || parent === undefined) return false;
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === node && parent.computed !== true) return false;
  if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod") && parent.key === node && parent.computed !== true && parent.shorthand !== true) return false;
  if (FUNCTION_TYPES.has(parent.type) || parent.type === "FunctionDeclaration") return false;
  return !parent.type.startsWith("TS") || parent.type === "TSAsExpression" || parent.type === "TSSatisfiesExpression" || parent.type === "TSNonNullExpression";
}

function localParameters(node: AstNode): Set<string> {
  const names = new Set<string>();
  walk(node, (inner) => {
    if (!FUNCTION_TYPES.has(inner.type) || !Array.isArray(inner.params)) return;
    for (const param of inner.params) {
      if (!isAstNode(param)) continue;
      for (const id of [param, ...findAll(param, "Identifier")]) if (id.type === "Identifier" && typeof id.name === "string") names.add(id.name);
    }
  });
  return names;
}

function references(node: AstNode): string[] {
  const params = localParameters(node);
  const out: string[] = [];
  const visit = (inner: AstNode, parent: AstNode | undefined): void => {
    if (isReference(inner, parent) && typeof inner.name === "string" && !params.has(inner.name)) out.push(inner.name);
  };
  visit(node, { type: "ExpressionStatement", start: null, end: null });
  walk(node, (inner, parent) => {
    if (inner !== node) visit(inner, parent);
  });
  return out;
}

interface SchemaFacts {
  nestedDefault: boolean;
  traced: boolean;
}

function schemaFacts(nodes: readonly AstNode[], namespaces: ReadonlySet<string>, bindings: ReadonlyMap<string, AstNode | undefined>): SchemaFacts {
  const facts: SchemaFacts = { nestedDefault: false, traced: true };
  const seen = new Set<string>();
  const visit = (node: AstNode, depth: number): void => {
    if (findAll(node, "CallExpression").some((call) => DEFAULT_METHODS.has(memberCall(call)?.name ?? ""))) facts.nestedDefault = true;
    for (const name of references(node)) {
      if (namespaces.has(name) || KNOWN_GLOBALS.has(name) || seen.has(name)) continue;
      seen.add(name);
      const init = bindings.get(name);
      if (init === undefined || depth >= MAX_BINDING_DEPTH) facts.traced = false;
      else visit(init, depth + 1);
    }
  };
  for (const node of nodes) visit(node, 0);
  return facts;
}

type ValueShape = "plain" | "objects" | "opaque";

function returnedValue(fn: AstNode): AstNode | undefined {
  const body = fn.body;
  if (!isAstNode(body)) return undefined;
  if (body.type !== "BlockStatement") return body;
  const statements = Array.isArray(body.body) ? body.body : [];
  const last: unknown = statements[statements.length - 1];
  return statements.length === 1 && isAstNode(last) && last.type === "ReturnStatement" && isAstNode(last.argument) ? last.argument : undefined;
}

function combine(shapes: readonly ValueShape[]): ValueShape {
  if (shapes.includes("opaque")) return "opaque";
  return shapes.includes("objects") ? "objects" : "plain";
}

function literalShape(value: AstNode, top: boolean): ValueShape {
  const node = withoutTypeWrappers(value);
  if (PLAIN_LITERALS.has(node.type)) return "plain";
  if (node.type === "Identifier" && node.name === "undefined") return "plain";
  if (node.type === "UnaryExpression" && isAstNode(node.argument)) return literalShape(node.argument, false);
  if (node.type === "TemplateLiteral") return Array.isArray(node.expressions) && node.expressions.length === 0 ? "plain" : "opaque";
  if (top && FUNCTION_TYPES.has(node.type)) {
    const returned = returnedValue(node);
    return returned === undefined ? "opaque" : literalShape(returned, true);
  }
  if (node.type === "ArrayExpression") {
    const elements = Array.isArray(node.elements) ? node.elements : [];
    return combine(elements.map((element) => (isAstNode(element) ? literalShape(element, false) : "opaque")));
  }
  if (node.type !== "ObjectExpression") return "opaque";
  const properties = Array.isArray(node.properties) ? node.properties : [];
  const shapes = properties.map((property): ValueShape => (isAstNode(property) && property.type === "ObjectProperty" && property.computed !== true && isAstNode(property.value) ? literalShape(property.value, false) : "opaque"));
  return combine(top ? shapes : [...shapes, "objects"]);
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function recordKeyEdits(file: string, _source: string, root: AstNode, namespaces: ReadonlySet<string>): Edit[] {
  const edits: Edit[] = [];
  for (const node of findAll(root, "CallExpression")) {
    const call = memberCall(node);
    if (call === undefined || call.name !== "record" || call.args.length !== 1 || call.args[0]!.type === "SpreadElement") continue;
    const namespace = namespaceOf(call.object, namespaces);
    if (namespace === undefined) continue;
    const at = span(call.args[0]!).start;
    edits.push({ file, start: at, end: at, text: `${namespace}.string(), ` });
  }
  return edits;
}

function describeOrderEdits(file: string, source: string, root: AstNode): Edit[] {
  const calls = findAll(root, "CallExpression")
    .map(memberCall)
    .filter((call): call is MemberCall => call !== undefined);
  const byReceiver = new Map<AstNode, MemberCall>();
  for (const call of calls) byReceiver.set(call.object, call);
  const edits: Edit[] = [];
  for (const call of calls) {
    if (call.name !== "describe" || call.args.length !== 1) continue;
    let last = call;
    for (let next = byReceiver.get(last.call); next !== undefined && DESCRIPTION_DROPPING.has(next.name); next = byReceiver.get(last.call)) last = next;
    if (last === call) continue;
    const describeEnd = span(call.call).end;
    edits.push({ file, start: span(call.object).end, end: describeEnd, text: "" });
    edits.push({ file, start: span(last.call).end, end: span(last.call).end, text: `.${source.slice(span(call.property).start, describeEnd)}` });
  }
  return edits;
}

interface ObjectDefaults {
  edits: Edit[];
  untraced: number[];
  unparsedValue: number[];
  collection: number[];
  collectionValue: number[];
  collectionUntraced: number[];
}

function collectionDefault(out: ObjectDefaults, line: number, arg: AstNode, facts: SchemaFacts): void {
  const shape = literalShape(arg, true);
  if (shape === "plain") return;
  if (!facts.traced) out.collectionUntraced.push(line);
  else if (!facts.nestedDefault) return;
  else if (shape === "objects") out.collection.push(line);
  else out.collectionValue.push(line);
}

function objectDefaults(file: string, source: string, root: AstNode, namespaces: ReadonlySet<string>): ObjectDefaults {
  const out: ObjectDefaults = { edits: [], untraced: [], unparsedValue: [], collection: [], collectionValue: [], collectionUntraced: [] };
  const bindings = localBindings(root);
  for (const node of findAll(root, "CallExpression")) {
    const call = memberCall(node);
    if (call === undefined || call.name !== "default" || call.args.length !== 1 || call.args[0]!.type === "SpreadElement") continue;
    const arg = call.args[0]!;
    const { kind, nodes } = traceReceiver(call.object, namespaces, bindings);
    const { start, end } = span(call.property);
    const line = lineOf(source, start);
    if (arg.type === "ObjectExpression" && kind === "parsed") out.edits.push({ file, start, end, text: "prefault" });
    else if (arg.type === "ObjectExpression" && kind === "unknown") out.untraced.push(line);
    else if (kind === "parsed" && schemaFacts(nodes, namespaces, bindings).nestedDefault) out.unparsedValue.push(line);
    else if (kind === "collection") collectionDefault(out, line, arg, schemaFacts(nodes, namespaces, bindings));
  }
  return out;
}

interface ZodFile {
  file: string;
  source: string;
  root: AstNode;
  namespaces: ReadonlySet<string>;
}

function zodFiles(ctx: SourceRuleContext): ZodFile[] {
  const out: ZodFile[] = [];
  for (const file of projectSourceFiles(ctx.scratch)) {
    if (file.endsWith(".vue")) continue;
    const source = ctx.readFile(file);
    if (source === undefined || !ZOD_IMPORT.test(source)) continue;
    let root: AstNode;
    try {
      root = parseTs(source);
    } catch {
      continue;
    }
    const namespaces = zodNamespaces(root);
    if (namespaces.size > 0) out.push({ file, source, root, namespaces });
  }
  return out;
}

function scanZodFiles(ctx: SourceRuleContext, scan: (file: string, source: string, root: AstNode, namespaces: ReadonlySet<string>) => Edit[]): Array<{ file: string; edits: Edit[] }> {
  return zodFiles(ctx)
    .map(({ file, source, root, namespaces }) => ({ file, edits: scan(file, source, root, namespaces) }))
    .filter(({ edits }) => edits.length > 0);
}

/** `zod/record-key`: a one-argument `z.record(value)`, which zod 4's signature no longer accepts; the fix inserts `z.string()` as the key schema zod 3 assumed. */
export const zodRecordKeyRule: SourceRule = {
  id: "zod/record-key",
  needs: "source",
  check(ctx) {
    return scanZodFiles(ctx, recordKeyEdits).map(({ file, edits }) =>
      finding(`zod/record-key:${file}`, "zod/record-key", `calls z.record with only a value schema (${edits.length}x); zod 4's record takes the key schema first`, "insert z.string() as the key schema, which is what zod 3 used", { file }, edits, upgradingDocs("zod-record-key")),
    );
  },
};

/** `zod/object-default`: an object-literal `.default({...})` on an object, union or intersection schema, also one held in a variable of the same file; zod 4 returns that object as written, so the fix renames it to `.prefault()`, which parses it and fills nested defaults as zod 3's `.default()` did. One on a schema the rule cannot trace (including `z.preprocess`, `z.lazy`, `z.pipe`, `z.custom` and a `.pipe()` or `.transform()` in the chain), a default given as a variable or a function on such a schema with nested defaults, an array or record default holding objects, returned by a function or not a literal whose element schema has nested defaults, and one that holds objects or is not a literal on an array or record whose element schema it cannot trace are manual warnings. Nested defaults are found through the local variables the schema refers to, at any depth. */
export const zodObjectDefaultRule: SourceRule = {
  id: "zod/object-default",
  needs: "source",
  check(ctx) {
    const findings: Finding[] = [];
    for (const { file, source, root, namespaces } of zodFiles(ctx)) {
      const { edits, untraced, unparsedValue, collection, collectionValue, collectionUntraced } = objectDefaults(file, source, root, namespaces);
      if (edits.length > 0) {
        findings.push(
          finding(
            `zod/object-default:${file}`,
            "zod/object-default",
            `gives an object schema an object-literal .default() (${edits.length}x); zod 4 returns that default as written and no longer fills the nested defaults inside it`,
            "rename .default() to .prefault(), which parses the default the way zod 3's .default() did",
            { file },
            edits,
            upgradingDocs("zod-object-default"),
            "warning",
          ),
        );
      }
      for (const line of untraced) {
        findings.push(
          finding(
            `zod/object-default:${file}:${line}`,
            "zod/object-default",
            "gives an object-literal .default() to a schema this rule cannot trace to a zod factory in the same file; if that schema is an object or a union of objects, zod 4 returns the default as written and no longer fills the nested defaults inside it",
            "if the schema is an object or a union of objects, rename .default() to .prefault()",
            { file, line },
            undefined,
            upgradingDocs("zod-object-default"),
            "warning",
          ),
        );
      }
      const manual: Array<[number, string, string]> = [
        ...unparsedValue.map((line): [number, string, string] => [
          line,
          "gives an object schema that declares nested defaults a .default() whose value is not an object literal; zod 4 returns that value as written, so a nested key it leaves out stays undefined instead of taking its own default",
          "rename .default() to .prefault() if the value can leave out a key that has its own default",
        ]),
        ...collection.map((line): [number, string, string] => [
          line,
          "gives an array or record schema whose objects declare nested defaults a .default() holding object literals; zod 4 returns those objects as written, so a nested key they leave out stays undefined instead of taking its own default",
          "rename .default() to .prefault(), which parses the default and fills the nested defaults the way zod 3's .default() did",
        ]),
        ...collectionValue.map((line): [number, string, string] => [
          line,
          "gives an array or record schema whose objects declare nested defaults a .default() whose value is not a literal; zod 4 returns that value as written, so a nested key its objects leave out stays undefined instead of taking its own default",
          "rename .default() to .prefault() if the objects in the value can leave out a key that has its own default",
        ]),
        ...collectionUntraced.map((line): [number, string, string] => [
          line,
          "gives an array or record schema whose element schema this rule cannot trace to a zod factory in the same file a .default() that holds objects or is not a literal; if those objects declare nested defaults, zod 4 returns the value as written and a nested key it leaves out stays undefined",
          "if the element schema declares nested defaults, rename .default() to .prefault()",
        ]),
      ].sort((a, b) => a[0] - b[0]);
      for (const [line, message, suggestion] of manual) findings.push(finding(`zod/object-default:${file}:${line}`, "zod/object-default", message, suggestion, { file, line }, undefined, upgradingDocs("zod-object-default"), "warning"));
    }
    return findings;
  },
};

/** `zod/describe-order`: a `.describe()` followed by an object method such as `.strict()` or `.partial()`, or by `.or()`, `.and()`, an enum's `.extract()`/`.exclude()` or a tuple's `.rest()`, each of which in zod 4 returns a schema without the description, so a `"secret"` mark is lost; the fix moves the `.describe()` after the last such method. */
export const zodDescribeOrderRule: SourceRule = {
  id: "zod/describe-order",
  needs: "source",
  check(ctx) {
    return scanZodFiles(ctx, describeOrderEdits).map(({ file, edits }) =>
      finding(
        `zod/describe-order:${file}`,
        "zod/describe-order",
        `calls .describe() before a method such as .strict(), .partial() or .or() (${edits.length / 2}x); zod 4 returns a schema without the description, so a "secret" mark no longer applies`,
        "move .describe() after the last such method of the chain",
        { file },
        edits,
        upgradingDocs("zod-describe-order"),
      ),
    );
  },
};

export const ZOD_RULES: readonly SourceRule[] = [zodRangeRule, zodRecordKeyRule, zodObjectDefaultRule, zodDescribeOrderRule];
