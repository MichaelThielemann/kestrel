import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export interface ExamplePipeline {
  file: string;
  name: string;
  steps: string[];
}

function bareStepName(spec: string): string {
  return spec.split(":")[0]!.split("?")[0]!;
}

function atomicGroupSteps(node: ts.Node): string[] | undefined {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== "atomic") continue;
    if (!ts.isArrayLiteralExpression(prop.initializer)) return undefined;
    const inner: string[] = [];
    for (const element of prop.initializer.elements) {
      if (!ts.isStringLiteral(element)) return undefined;
      inner.push(element.text);
    }
    return inner;
  }
  return undefined;
}

function stringArrayLiteral(node: ts.Node | undefined): string[] | undefined {
  if (!node || !ts.isArrayLiteralExpression(node)) return undefined;
  const out: string[] = [];
  for (const element of node.elements) {
    if (ts.isStringLiteral(element)) {
      out.push(element.text);
      continue;
    }
    const group = atomicGroupSteps(element);
    if (group === undefined) return undefined;
    out.push(...group);
  }
  return out;
}

function pipelineOf(file: string): ExamplePipeline | undefined {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let name: string | undefined;
  let steps: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "definePipeline") {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "name" && ts.isStringLiteral(prop.initializer)) name = prop.initializer.text;
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "steps") steps = stringArrayLiteral(prop.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (name === undefined || steps === undefined) return undefined;
  return { file, name, steps: steps.map(bareStepName) };
}

export function scanExamplePipelines(examplesRoot: string): ExamplePipeline[] {
  const out: ExamplePipeline[] = [];
  for (const example of readdirSync(examplesRoot, { withFileTypes: true })) {
    if (!example.isDirectory()) continue;
    const pipelinesDir = join(examplesRoot, example.name, "pipelines");
    if (!existsSync(pipelinesDir)) continue;
    for (const file of readdirSync(pipelinesDir)) {
      if (!file.endsWith(".ts")) continue;
      const pipeline = pipelineOf(join(pipelinesDir, file));
      if (pipeline) out.push(pipeline);
    }
  }
  return out;
}
