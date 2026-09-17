import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

const PACKAGES = resolve(import.meta.dirname, "../..");

interface StepFacts {
  readsPayload: boolean;
  declared: boolean;
  literalInputWithoutAdditionalProperties: boolean;
}

interface Scan {
  scanned: boolean;
  hasSteps: boolean;
  facts: Map<string, StepFacts>;
}

let current: ts.SourceFile | undefined;

function topLevel(name: string): ts.Node | undefined {
  for (const statement of current?.statements ?? []) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
      }
    }
  }
  return undefined;
}

function objectProperties(node: ts.Node | undefined): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const literal = objectLiteralOf(node);
  if (!literal) return out;
  for (const member of literal.properties) {
    if (ts.isPropertyAssignment(member) || ts.isMethodDeclaration(member) || ts.isShorthandPropertyAssignment(member)) {
      const name = member.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) out.set(name.text, ts.isPropertyAssignment(member) ? member.initializer : member);
    }
  }
  return out;
}

function objectLiteralOf(node: ts.Node | undefined): ts.ObjectLiteralExpression | undefined {
  if (!node) return undefined;
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isParenthesizedExpression(node)) return objectLiteralOf(node.expression);
  if (ts.isIdentifier(node)) return objectLiteralOf(topLevel(node.text));
  if (ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
    const body = node.body;
    if (!body) return undefined;
    if (ts.isBlock(body)) {
      const ret = body.statements.find(ts.isReturnStatement);
      return objectLiteralOf(ret?.expression);
    }
    return objectLiteralOf(body);
  }
  if (ts.isCallExpression(node)) return objectLiteralOf(node.arguments[0]);
  return undefined;
}

function hasKey(node: ts.Node | undefined, key: string): boolean {
  return objectProperties(node).has(key);
}

function literalInputLacksAdditionalProperties(entry: ts.Node | undefined): boolean {
  const input = objectProperties(entry).get("input");
  if (!input || !ts.isObjectLiteralExpression(input)) return false;
  const props = objectProperties(input);
  const type = props.get("type");
  const isObject = type !== undefined && ts.isStringLiteral(type) && type.text === "object";
  return isObject && !props.has("additionalProperties");
}

function topLevelBodies(source: ts.SourceFile): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) bodies.set(statement.name.text, statement.getText(source));
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) bodies.set(declaration.name.text, declaration.getText(source));
      }
    }
  }
  return bodies;
}

function calls(text: string, names: Iterable<string>): boolean {
  return [...names].some((name) => new RegExp(`\\b${name}\\(`).test(text));
}

function payloadHelpers(source: ts.SourceFile): Set<string> {
  const bodies = topLevelBodies(source);
  const names = new Set<string>();
  for (let added = true; added; ) {
    added = false;
    for (const [name, text] of bodies) {
      if (names.has(name)) continue;
      if (!text.includes("ctx.payload") && !calls(text, names)) continue;
      names.add(name);
      added = true;
    }
  }
  return names;
}

function readsPayload(handler: ts.Node, source: ts.SourceFile, helpers: Set<string>): boolean {
  const text = handler.getText(source);
  return text.includes("ctx.payload") || calls(text, helpers);
}

function scanSource(file: string, text: string): Scan {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  current = source;
  let definition: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineModule") definition = objectLiteralOf(node.arguments[0]);
    if (!definition) ts.forEachChild(node, visit);
  };
  visit(source);
  const facts = new Map<string, StepFacts>();
  if (!definition) return { scanned: false, hasSteps: false, facts };
  const props = objectProperties(definition);
  const steps = objectProperties(props.get("steps"));
  const descriptions = objectProperties(props.get("describe"));
  const helpers = payloadHelpers(source);
  for (const [name, handler] of steps) {
    const entry = descriptions.get(name);
    facts.set(name, {
      readsPayload: readsPayload(handler, source, helpers),
      declared: hasKey(entry, "input") || hasKey(entry, "query"),
      literalInputWithoutAdditionalProperties: literalInputLacksAdditionalProperties(entry),
    });
  }
  return { scanned: true, hasSteps: props.has("steps"), facts };
}

function scan(file: string): Scan {
  return scanSource(file, readFileSync(file, "utf8"));
}

const modules = readdirSync(PACKAGES).filter((dir) => existsSync(join(PACKAGES, dir, "module.ts")));
const scans = modules.map((dir) => ({ dir, scan: scan(join(PACKAGES, dir, "module.ts")) }));

describe("every step that reads the payload declares its schema", () => {
  for (const { dir, scan: result } of scans) {
    if (result.scanned && !result.hasSteps) continue;
    it(`${dir}`, () => {
      if (!result.scanned || result.facts.size === 0) expect.fail(`${dir}/module.ts could not be scanned`);
      const undeclared = [...result.facts].filter(([, f]) => f.readsPayload && !f.declared).map(([name]) => name);
      const open = [...result.facts].filter(([, f]) => f.literalInputWithoutAdditionalProperties).map(([name]) => name);
      expect(undeclared, `${dir}/module.ts: steps reading ctx.payload without describe().input or .query`).toEqual([]);
      expect(open, `${dir}/module.ts: literal input schemas must state additionalProperties explicitly`).toEqual([]);
    });
  }

  it("skips exactly the modules whose definition declares no steps", () => {
    expect(scans.filter(({ scan: result }) => result.scanned && !result.hasSteps).map(({ dir }) => dir)).toEqual(["blobstore-filesystem", "blobstore-s3", "renderer-plain"]);
  });
});

describe("scan", () => {
  const module = (body: string) => `${body}
export default defineModule({
  name: "a/b",
  steps: () => ({ create: async (ctx: Context) => ok({ ...ctx, result: title(ctx) }) }),
  describe: () => ({ create: { summary: "create", reads: [], writes: ["result"] } }),
});
`;

  it("follows a helper chain to ctx.payload", () => {
    const direct = scanSource("direct.ts", module('function title(ctx: Context) {\n  return ctx.payload.title;\n}'));
    expect(direct.facts.get("create")?.readsPayload).toBe(true);
    const twoHops = scanSource("two-hops.ts", module('function field(ctx: Context) {\n  return ctx.payload.title;\n}\nfunction title(ctx: Context) {\n  return field(ctx);\n}'));
    expect(twoHops.facts.get("create")?.readsPayload).toBe(true);
    const none = scanSource("none.ts", module('function title(ctx: Context) {\n  return ctx.params.title;\n}'));
    expect(none.facts.get("create")?.readsPayload).toBe(false);
  });

  it("reports a module.ts it cannot resolve as unscanned", () => {
    expect(scanSource("empty.ts", "export const nothing = 1;\n")).toMatchObject({ scanned: false, hasSteps: false });
  });
});
