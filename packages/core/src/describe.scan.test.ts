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

function payloadHelpers(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.getText(source).includes("ctx.payload")) names.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && declaration.getText(source).includes("ctx.payload")) names.add(declaration.name.text);
      }
    }
  }
  return names;
}

function readsPayload(handler: ts.Node, source: ts.SourceFile, helpers: Set<string>): boolean {
  const text = handler.getText(source);
  if (text.includes("ctx.payload")) return true;
  return [...helpers].some((name) => new RegExp(`\\b${name}\\(`).test(text));
}

function scan(file: string): Map<string, StepFacts> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  current = source;
  let definition: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineModule") definition = objectLiteralOf(node.arguments[0]);
    if (!definition) ts.forEachChild(node, visit);
  };
  visit(source);
  const facts = new Map<string, StepFacts>();
  if (!definition) return facts;
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
  return facts;
}

const modules = readdirSync(PACKAGES).filter((dir) => existsSync(join(PACKAGES, dir, "module.ts")));

describe("every step that reads the payload declares its schema", () => {
  for (const dir of modules) {
    const facts = scan(join(PACKAGES, dir, "module.ts"));
    if (facts.size === 0) continue;
    it(`${dir}`, () => {
      const undeclared = [...facts].filter(([, f]) => f.readsPayload && !f.declared).map(([name]) => name);
      const open = [...facts].filter(([, f]) => f.literalInputWithoutAdditionalProperties).map(([name]) => name);
      expect(undeclared, `${dir}/module.ts: steps reading ctx.payload without describe().input or .query`).toEqual([]);
      expect(open, `${dir}/module.ts: literal input schemas must state additionalProperties explicitly`).toEqual([]);
    });
  }
});
