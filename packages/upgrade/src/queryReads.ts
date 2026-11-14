import { isAstNode, parseTs, propertyKeyName, stringValue, walk, type AstNode } from "./ast.ts";

const TRANSPARENT = new Set(["TSNonNullExpression", "TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion", "ParenthesizedExpression"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod"]);

function unwrap(value: unknown): AstNode | undefined {
  let node = isAstNode(value) ? value : undefined;
  while (node !== undefined && TRANSPARENT.has(node.type)) node = isAstNode(node.expression) ? node.expression : undefined;
  return node;
}

function isMember(node: AstNode): boolean {
  return node.type === "MemberExpression" || node.type === "OptionalMemberExpression";
}

function memberName(node: AstNode): string | undefined {
  const property = node.property;
  if (!isAstNode(property)) return undefined;
  if (node.computed === true) return stringValue(property);
  return property.type === "Identifier" && typeof property.name === "string" ? property.name : undefined;
}

function bindingName(value: unknown): string | undefined {
  const node = isAstNode(value) && value.type === "AssignmentPattern" ? value.left : value;
  return isAstNode(node) && node.type === "Identifier" && typeof node.name === "string" ? node.name : undefined;
}

function patternProperties(pattern: AstNode): AstNode[] {
  const properties: unknown[] = Array.isArray(pattern.properties) ? pattern.properties : [];
  return properties.filter((p): p is AstNode => isAstNode(p) && p.type === "ObjectProperty" && p.computed !== true);
}

function nameOf(node: unknown): string | undefined {
  return isAstNode(node) && node.type === "Identifier" && typeof node.name === "string" ? node.name : undefined;
}

function declarationName(node: AstNode): string | undefined {
  if (node.type === "FunctionDeclaration") return nameOf(node.id);
  return node.type === "VariableDeclarator" ? nameOf(node.id) : undefined;
}

function topLevelDeclarations(root: AstNode): Map<string, AstNode> {
  const declarations = new Map<string, AstNode>();
  const program = isAstNode(root.program) ? root.program : undefined;
  const body: unknown[] = program !== undefined && Array.isArray(program.body) ? program.body : [];
  for (const statement of body) {
    const node = isAstNode(statement) && (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") ? statement.declaration : statement;
    if (!isAstNode(node)) continue;
    if (node.type === "VariableDeclaration" && Array.isArray(node.declarations)) {
      for (const declarator of node.declarations) {
        const name = isAstNode(declarator) ? declarationName(declarator) : undefined;
        if (name !== undefined && isAstNode(declarator)) declarations.set(name, declarator);
      }
    } else {
      const name = declarationName(node);
      if (name !== undefined) declarations.set(name, node);
    }
  }
  return declarations;
}

function memberKey(node: AstNode): string | undefined {
  return (node.type === "ObjectProperty" || node.type === "ObjectMethod") && node.computed !== true ? propertyKeyName(node) : undefined;
}

/** A parsed module file, ready to answer which step functions read what from the request query. `undefined` when the file does not parse. */
export function parseModule(source: string): AstNode | undefined {
  try {
    return parseTs(source);
  } catch {
    return undefined;
  }
}

/**
 * The code of the step registered under `stepKey` in the object a module's `steps()` returns: the property, plus every
 * top-level function or constant it refers to, followed transitively. `undefined` when the file declares no such step,
 * in which case the caller reads the whole file.
 */
export function stepScopes(root: AstNode, stepKey: string): AstNode[] | undefined {
  const holders: AstNode[] = [];
  walk(root, (node) => {
    if (memberKey(node) === "steps") holders.push(node);
  });
  const found = new Set<AstNode>();
  for (const holder of holders) {
    walk(holder, (node) => {
      if (node !== holder && memberKey(node) === stepKey) found.add(node);
    });
  }
  if (found.size === 0) return undefined;
  const declarations = topLevelDeclarations(root);
  const scopes = new Set<AstNode>();
  const queue = [...found];
  while (queue.length > 0) {
    const scope = queue.pop()!;
    if (scopes.has(scope)) continue;
    scopes.add(scope);
    walk(scope, (node, parent) => {
      const name = nameOf(node);
      if (name === undefined || parent === undefined) return;
      if (memberKey(parent) !== undefined && parent.key === node) return;
      if (isMember(parent) && parent.property === node && parent.computed !== true) return;
      const declaration = declarations.get(name);
      if (declaration !== undefined && !scopes.has(declaration)) queue.push(declaration);
    });
  }
  return [...scopes];
}

/**
 * Every request query key the code under `scopes` reads: `ctx.query.<key>`, `ctx.query["<key>"]`, a destructuring from
 * `ctx.query`, and the same through a `query` taken from the context or an alias of it. A name that only happens to be
 * `query` and does not come from the context is not a read.
 */
export function queryKeysRead(scopes: readonly AstNode[]): Set<string> {
  const context = new Set<string>(["ctx"]);
  const query = new Set<string>();
  const declarators: AstNode[] = [];
  const assignments: AstNode[] = [];
  const members: AstNode[] = [];
  const patterns = (pattern: AstNode): void => {
    for (const property of patternProperties(pattern)) {
      const name = bindingName(property.value);
      if (propertyKeyName(property) === "query" && name !== undefined) query.add(name);
    }
  };
  for (const scope of scopes) {
    walk(scope, (node) => {
      if (FUNCTIONS.has(node.type)) {
        const first: unknown = Array.isArray(node.params) ? node.params[0] : undefined;
        const name = bindingName(first);
        if (name !== undefined) context.add(name);
        else if (isAstNode(first) && first.type === "ObjectPattern") patterns(first);
      } else if (node.type === "VariableDeclarator") declarators.push(node);
      else if (node.type === "AssignmentExpression" && node.operator === "=") assignments.push(node);
      else if (isMember(node)) members.push(node);
    });
  }

  const isContext = (value: unknown): boolean => {
    const name = nameOf(unwrap(value));
    return name !== undefined && context.has(name);
  };
  const isQuery = (value: unknown): boolean => {
    const node = unwrap(value);
    if (node === undefined) return false;
    if (node.type === "Identifier") return typeof node.name === "string" && query.has(node.name);
    if (node.type === "LogicalExpression") return isQuery(node.left);
    return isMember(node) && memberName(node) === "query" && isContext(node.object);
  };

  let size = -1;
  while (size !== query.size + context.size) {
    size = query.size + context.size;
    for (const declarator of declarators) {
      const id = declarator.id;
      if (!isAstNode(id)) continue;
      if (id.type === "Identifier" && isQuery(declarator.init) && typeof id.name === "string") query.add(id.name);
      else if (id.type === "ObjectPattern" && isContext(declarator.init)) patterns(id);
    }
  }

  const keys = new Set<string>();
  const fromPattern = (pattern: unknown): void => {
    if (!isAstNode(pattern) || pattern.type !== "ObjectPattern") return;
    for (const property of patternProperties(pattern)) {
      const key = propertyKeyName(property);
      if (key !== undefined) keys.add(key);
    }
  };
  for (const member of members) {
    const key = memberName(member);
    if (key !== undefined && isQuery(member.object)) keys.add(key);
  }
  for (const declarator of declarators) if (isQuery(declarator.init)) fromPattern(declarator.id);
  for (const assignment of assignments) if (isQuery(assignment.right)) fromPattern(assignment.left);
  return keys;
}
