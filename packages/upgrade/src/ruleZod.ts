import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { findAll, isAstNode, parseTs, span, type AstNode } from "./ast.ts";
import { isRecord } from "./guards.ts";
import { setDependencyRange } from "./packageJson.ts";
import type { SourceRule, SourceRuleContext } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { projectSourceFiles } from "./ruleContractHelpers.ts";
import { finding, packageJsonPath, upgradingDocs } from "./ruleHelpers.ts";

const ZOD_RANGE = "^4.6.6";
const FIXED: readonly [number, number, number] = [4, 6, 6];
const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "peerDependencies"] as const;
const OBJECT_FACTORIES = new Set(["object", "strictObject", "looseObject"]);
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

/** `deps/zod-range`: a `zod` dependency range that admits a release below 4.6.6 or another major; kestrel 6 reads module config schemas built with zod 4. */
export const zodRangeRule: SourceRule = {
  id: "deps/zod-range",
  needs: "source",
  check(ctx) {
    const pkgFile = packageJsonPath(ctx);
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
      findings.push(
        finding(
          `deps/zod-range:${map}`,
          "deps/zod-range",
          `zod is at ${range} in ${map}; kestrel 6 reads module config schemas built with zod 4.6.6 or later`,
          `set zod to "${ZOD_RANGE}" in ${map}`,
          { file: pkgFile, module: "zod" },
          [setDependencyRange(pkgFile, source, map, "zod", ZOD_RANGE)],
          upgradingDocs("deps-zod-range"),
        ),
      );
    }
    return findings;
  },
};

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

function rootsInObjectFactory(receiver: AstNode, namespaces: ReadonlySet<string>): boolean {
  let node: AstNode | undefined = receiver;
  while (node !== undefined) {
    const call = memberCall(node);
    if (call === undefined) return false;
    if (namespaceOf(call.object, namespaces) !== undefined) return OBJECT_FACTORIES.has(call.name);
    node = call.object;
  }
  return false;
}

function recordKeyEdits(file: string, root: AstNode, namespaces: ReadonlySet<string>): Edit[] {
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

function objectDefaultEdits(file: string, root: AstNode, namespaces: ReadonlySet<string>): Edit[] {
  const edits: Edit[] = [];
  for (const node of findAll(root, "CallExpression")) {
    const call = memberCall(node);
    if (call === undefined || call.name !== "default" || call.args.length !== 1 || call.args[0]!.type !== "ObjectExpression") continue;
    if (!rootsInObjectFactory(call.object, namespaces)) continue;
    const { start, end } = span(call.property);
    edits.push({ file, start, end, text: "prefault" });
  }
  return edits;
}

type ZodScan = (file: string, root: AstNode, namespaces: ReadonlySet<string>) => Edit[];

function scanZodFiles(ctx: SourceRuleContext, scan: ZodScan): Array<{ file: string; edits: Edit[] }> {
  const out: Array<{ file: string; edits: Edit[] }> = [];
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
    if (namespaces.size === 0) continue;
    const edits = scan(file, root, namespaces);
    if (edits.length > 0) out.push({ file, edits });
  }
  return out;
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

/** `zod/object-default`: an object schema's `.default({...})`; zod 4 returns that object as written, so the fix renames it to `.prefault()`, which parses it and fills nested defaults as zod 3's `.default()` did. */
export const zodObjectDefaultRule: SourceRule = {
  id: "zod/object-default",
  needs: "source",
  check(ctx) {
    return scanZodFiles(ctx, objectDefaultEdits).map(({ file, edits }) =>
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
  },
};

export const ZOD_RULES: readonly SourceRule[] = [zodRangeRule, zodRecordKeyRule, zodObjectDefaultRule];
