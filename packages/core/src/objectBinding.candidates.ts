import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export interface ObjectBindingCandidate {
  /** `<module prefix>.<step>`, e.g. "revisions.read". */
  step: string;
  reads: readonly string[];
  hasInput: boolean;
  hasQuery: boolean;
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

function objectLiteralOf(node: ts.Node | undefined, source: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  if (!node) return undefined;
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isParenthesizedExpression(node)) return objectLiteralOf(node.expression, source);
  if (ts.isIdentifier(node)) return objectLiteralOf(topLevel(source, node.text), source);
  if (ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
    const body = node.body;
    if (!body) return undefined;
    if (ts.isBlock(body)) {
      const ret = body.statements.find(ts.isReturnStatement);
      return objectLiteralOf(ret?.expression, source);
    }
    return objectLiteralOf(body, source);
  }
  if (ts.isCallExpression(node)) return objectLiteralOf(node.arguments[0], source);
  return undefined;
}

function objectProperties(node: ts.Node | undefined, source: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const literal = objectLiteralOf(node, source);
  if (!literal) return out;
  for (const member of literal.properties) {
    if (ts.isPropertyAssignment(member) || ts.isMethodDeclaration(member) || ts.isShorthandPropertyAssignment(member)) {
      const name = member.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) out.set(name.text, ts.isPropertyAssignment(member) ? member.initializer : member);
    }
  }
  return out;
}

function stringArray(node: ts.Node | undefined): string[] {
  if (!node || !ts.isArrayLiteralExpression(node)) return [];
  return node.elements.filter(ts.isStringLiteral).map((e) => e.text);
}

function hasAnotherRequestControlledRead(reads: readonly string[], hasQuery: boolean): boolean {
  const paramsReads = reads.filter((r) => r === "params" || r.startsWith("params."));
  const payloadReads = reads.filter((r) => r === "payload" || r.startsWith("payload."));
  return paramsReads.length >= 2 || payloadReads.length >= 1 || hasQuery;
}

function scanModule(file: string): ObjectBindingCandidate[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let definition: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineModule") definition = objectLiteralOf(node.arguments[0], source);
    if (!definition) ts.forEachChild(node, visit);
  };
  visit(source);
  if (!definition) return [];
  const props = objectProperties(definition, source);
  const nameNode = props.get("name");
  const prefix = nameNode && ts.isStringLiteral(nameNode) ? (nameNode.text.split("/")[0] ?? nameNode.text) : "?";
  const stepsObj = objectProperties(props.get("steps"), source);
  const describeObj = objectProperties(props.get("describe"), source);
  const candidates: ObjectBindingCandidate[] = [];
  for (const key of stepsObj.keys()) {
    const entryProps = objectProperties(describeObj.get(key), source);
    const reads = stringArray(entryProps.get("reads"));
    const hasInput = entryProps.has("input");
    const queryNode = entryProps.get("query");
    const hasQuery = queryNode !== undefined && (!ts.isObjectLiteralExpression(queryNode) || queryNode.properties.length > 0);
    const hasParams = reads.some((r) => r === "params" || r.startsWith("params."));
    if (hasParams && (hasAnotherRequestControlledRead(reads, hasQuery) || hasInput)) candidates.push({ step: `${prefix}.${key}`, reads, hasInput, hasQuery });
  }
  return candidates;
}

/** Every step, across every module, that reads `params.*` plus another request-controlled value or declares an input schema — a candidate for a foreign-id (object binding) check. */
export function objectBindingCandidates(packagesRoot: string): ObjectBindingCandidate[] {
  const dirs = readdirSync(packagesRoot).filter((dir) => existsSync(join(packagesRoot, dir, "module.ts")));
  return dirs.flatMap((dir) => scanModule(join(packagesRoot, dir, "module.ts")));
}
