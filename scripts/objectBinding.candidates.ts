import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { stripOptional } from "../packages/core/src/writes.ts";

export interface ObjectBindingCandidate {
  module: string;
  step: string;
  reads: readonly string[];
  hasInput: boolean;
  hasQuery: boolean;
}

export interface ObjectBindingScan {
  moduleFileCount: number;
  stepCount: number;
  candidates: ObjectBindingCandidate[];
}

function topLevel(source: ts.SourceFile, name: string): ts.Node | undefined {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
      }
    }
  }
  return undefined;
}

function unwrapToExpression(node: ts.Node | undefined, source: ts.SourceFile): ts.Node | undefined {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node)) return unwrapToExpression(node.expression, source);
  if (ts.isIdentifier(node)) return unwrapToExpression(topLevel(source, node.text), source);
  if (ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
    const body = node.body;
    if (!body) return undefined;
    if (ts.isBlock(body)) {
      const ret = body.statements.find(ts.isReturnStatement);
      return unwrapToExpression(ret?.expression, source);
    }
    return unwrapToExpression(body, source);
  }
  return node;
}

function objectLiteralOf(node: ts.Node | undefined, source: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  const expr = unwrapToExpression(node, source);
  return expr && ts.isObjectLiteralExpression(expr) ? expr : undefined;
}

function objectProperties(literal: ts.ObjectLiteralExpression, context: string): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const member of literal.properties) {
    if (ts.isSpreadAssignment(member)) throw new Error(`${context}: uses a spread; the scan needs literal properties`);
    if (ts.isPropertyAssignment(member) || ts.isMethodDeclaration(member) || ts.isShorthandPropertyAssignment(member)) {
      const name = member.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) out.set(name.text, ts.isPropertyAssignment(member) ? member.initializer : member);
    }
  }
  return out;
}

function requiredObjectLiteral(node: ts.Node | undefined, source: ts.SourceFile, context: string): ts.ObjectLiteralExpression {
  const literal = objectLiteralOf(node, source);
  if (!literal) throw new Error(`${context}: could not be read as an inline object literal (defined elsewhere, or built by a delegating factory)`);
  return literal;
}

function entryLiterals(node: ts.Node, source: ts.SourceFile, context: string): ts.ObjectLiteralExpression[] {
  const direct = objectLiteralOf(node, source);
  if (direct) return [direct];
  const expr = unwrapToExpression(node, source);
  if (expr && ts.isConditionalExpression(expr)) {
    const whenTrue = objectLiteralOf(expr.whenTrue, source);
    const whenFalse = objectLiteralOf(expr.whenFalse, source);
    if (whenTrue && whenFalse) return [whenTrue, whenFalse];
  }
  throw new Error(`${context}: describe() entry could not be read as an object literal or a ternary of two object literals`);
}

function templateHead(node: ts.Node): string | undefined {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return undefined;
}

function literalArrayOf(node: ts.ArrayLiteralExpression, context: string): string[] {
  return node.elements.map((element) => {
    if (ts.isStringLiteral(element)) return element.text;
    const head = templateHead(element);
    if (head !== undefined) return head;
    throw new Error(`${context}: "reads" contains a non-literal element`);
  });
}

function stringArray(node: ts.Node | undefined, context: string): string[] {
  if (!node) return [];
  if (ts.isArrayLiteralExpression(node)) return literalArrayOf(node, context);
  if (ts.isConditionalExpression(node) && ts.isArrayLiteralExpression(node.whenTrue) && ts.isArrayLiteralExpression(node.whenFalse)) {
    return [...literalArrayOf(node.whenTrue, context), ...literalArrayOf(node.whenFalse, context)];
  }
  throw new Error(`${context}: "reads" is not a literal array`);
}

function hasAnotherRequestControlledRead(reads: readonly string[], hasQuery: boolean): boolean {
  const bare = reads.map(stripOptional);
  const paramsReads = bare.filter((r) => r === "params" || r.startsWith("params."));
  const payloadReads = bare.filter((r) => r === "payload" || r.startsWith("payload."));
  return paramsReads.length >= 2 || payloadReads.length >= 1 || hasQuery;
}

interface EntryFacts {
  reads: string[];
  hasInput: boolean;
  hasQuery: boolean;
}

function factsOf(literal: ts.ObjectLiteralExpression, context: string): EntryFacts {
  const props = objectProperties(literal, context);
  if (!props.has("reads")) throw new Error(`${context}: has no "reads"`);
  const reads = stringArray(props.get("reads"), context);
  const hasInput = props.has("input");
  const queryNode = props.get("query");
  const hasQuery = queryNode !== undefined && (!ts.isObjectLiteralExpression(queryNode) || queryNode.properties.length > 0);
  return { reads, hasInput, hasQuery };
}

function scanModule(file: string): { moduleName: string; stepCount: number; candidates: ObjectBindingCandidate[] } {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let definition: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineModule") definition = objectLiteralOf(node.arguments[0], source);
    if (!definition) ts.forEachChild(node, visit);
  };
  visit(source);
  if (!definition) throw new Error(`${file}: no defineModule({...}) call found`);
  const props = objectProperties(definition, file);
  const nameNode = props.get("name");
  if (!nameNode || !ts.isStringLiteral(nameNode)) throw new Error(`${file}: defineModule() "name" is not a string literal`);
  const moduleName = nameNode.text;
  if (!props.has("steps")) return { moduleName, stepCount: 0, candidates: [] };
  const stepsObj = objectProperties(requiredObjectLiteral(props.get("steps"), source, `${file}: "steps"`), `${file}: "steps"`);
  if (stepsObj.size === 0) return { moduleName, stepCount: 0, candidates: [] };
  const describeLiteral = requiredObjectLiteral(props.get("describe"), source, `${file}: "describe"`);
  const describeObj = objectProperties(describeLiteral, `${file}: "describe"`);
  const candidates: ObjectBindingCandidate[] = [];
  for (const key of stepsObj.keys()) {
    const context = `${file}: step "${key}"`;
    const entryNode = describeObj.get(key);
    if (!entryNode) throw new Error(`${context} has no describe() entry`);
    const literals = entryLiterals(entryNode, source, context);
    const facts = literals.map((literal) => factsOf(literal, context));
    const reads = [...new Set(facts.flatMap((f) => f.reads))];
    const hasInput = facts.some((f) => f.hasInput);
    const hasQuery = facts.some((f) => f.hasQuery);
    const hasParams = reads.some((r) => stripOptional(r) === "params" || stripOptional(r).startsWith("params."));
    if (hasParams && (hasAnotherRequestControlledRead(reads, hasQuery) || hasInput)) candidates.push({ module: moduleName, step: key, reads, hasInput, hasQuery });
  }
  return { moduleName, stepCount: stepsObj.size, candidates };
}

/**
 * Scans every `module.ts` under `packagesRoot` for a step that reads `params.*` plus another
 * request-controlled value (another `params.*`, a `payload` read, a `query` schema) or declares
 * an input schema — a candidate for a foreign-id (object binding) check. Covers this
 * repository's own modules only, not a consumer's modules. Throws, naming the file and step,
 * for any shape it cannot read with certainty rather than silently treating it as no candidate.
 */
export function scanObjectBindingCandidates(packagesRoot: string): ObjectBindingScan {
  const dirs = readdirSync(packagesRoot).filter((dir) => existsSync(join(packagesRoot, dir, "module.ts")));
  const scans = dirs.map((dir) => scanModule(join(packagesRoot, dir, "module.ts")));
  const stepCount = scans.reduce((n, s) => n + s.stepCount, 0);
  return { moduleFileCount: dirs.length, stepCount, candidates: scans.flatMap((s) => s.candidates) };
}
