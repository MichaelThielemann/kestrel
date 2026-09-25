import { addModuleEmits, allDescribedSteps } from "./edits.ts";
import { objectProperty, objectPropertyNodes, propertyKeyName, type AstNode } from "./ast.ts";
import type { Rule } from "./plugin.ts";
import type { AskFix, Edit, Finding } from "./report.ts";
import { finding, localModuleFiles, pipelinesTriggeredBy } from "./ruleHelpers.ts";

const EMIT_CALL = /\.emit\(\s*(['"])([^'"]+)\1/g;

function emittedEventsIn(source: string): string[] {
  const events = new Set<string>();
  for (const match of source.matchAll(EMIT_CALL)) events.add(match[2]!);
  return [...events];
}

function questionId(moduleName: string): string {
  return `emits:${moduleName}`;
}

/** A module raising an event from inside its own `setup()` (not a pipeline step) must declare it in `emits`, or `sortModules` may set it up after the event delivery hook is already gone — heuristic: any `.emit("...")` call anywhere in the file. */
export const emitsRule: Rule = {
  id: "modules/emits",
  check(ctx) {
    const findings: Finding[] = [];
    for (const [moduleName, file] of ctx.project.moduleFiles) {
      const source = ctx.readFile(file);
      if (source === undefined) continue;
      const emitted = emittedEventsIn(source);
      if (emitted.length === 0) continue;
      const mod = ctx.project.input.modules.find((m) => m.name === moduleName);
      const declared = new Set(mod?.emits ?? []);
      const missing = emitted.filter((e) => !declared.has(e));
      if (missing.length === 0) continue;

      const id = `modules/emits:${moduleName}`;
      const where = { module: moduleName, file };
      const answer = ctx.answers.get(questionId(moduleName));
      if (answer !== undefined && answer !== "none") {
        const events = answer
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        const edits: Edit[] = [];
        if (events.length > 0) {
          const edit = addModuleEmits(file, source, events);
          if (edit) edits.push(edit);
        }
        findings.push(finding(id, "modules/emits", `module "${moduleName}" raises ${missing.join(", ")} without declaring it in emits`, `emits: [${events.map((e) => `"${e}"`).join(", ")}] added`, where, edits, "docs/upgrading.md#modules-emits"));
        continue;
      }
      const fix: AskFix = { kind: "ask", question: questionId(moduleName), prompt: `which events does "${moduleName}" raise from its own setup()? (comma-separated, or "none" if ${missing.join(", ")} only ever comes from a pipeline step)`, choices: [missing.join(", "), "none"], defaultValue: missing.join(", ") };
      findings.push({
        id,
        rule: "modules/emits",
        severity: "warning",
        tier: "source",
        where,
        message: `module "${moduleName}" appears to raise ${missing.join(", ")} without declaring it in emits`,
        suggestion: "with events-queue, an undeclared event raised during setup() before the queue exists is lost",
        fix,
        docs: "docs/upgrading.md#modules-emits",
      });
    }
    return findings;
  },
};

const ENVELOPE_KEYS = ["eventId", "event", "at"];

function propertyKeysOf(obj: AstNode): string[] {
  return objectPropertyNodes(obj).flatMap((p) => {
    const key = propertyKeyName(p);
    return key === undefined ? [] : [key];
  });
}

/** `steps/closed-event-input`: a step's `input` schema closes `additionalProperties` while it may run on an event trigger, so the event envelope (`eventId`, `event`, `at`) is rejected. Always manual: which fields belong depends on the step. */
export const eventPayloadRule: Rule = {
  id: "steps/closed-event-input",
  check(ctx) {
    const eventPipelines = pipelinesTriggeredBy(ctx, "event");
    if (eventPipelines.size === 0) return [];
    const stepsOnEventPipelines = new Set<string>();
    for (const def of ctx.project.input.pipelines) {
      if (!eventPipelines.has(def.name)) continue;
      for (const step of def.steps) {
        if (typeof step === "string") stepsOnEventPipelines.add(step.split(":")[0]!);
      }
    }
    const findings: Finding[] = [];
    for (const [, file] of localModuleFiles(ctx)) {
      const source = ctx.readFile(file);
      if (source === undefined) continue;
      for (const { key, node } of allDescribedSteps(source)) {
        const input = objectProperty(node, "input");
        if (input === undefined || input.type !== "ObjectExpression") continue;
        const closed = objectProperty(input, "additionalProperties");
        if (closed?.type !== "BooleanLiteral" || closed.value !== false) continue;
        const properties = objectProperty(input, "properties");
        const declaredKeys = new Set(properties?.type === "ObjectExpression" ? propertyKeysOf(properties) : []);
        const missing = ENVELOPE_KEYS.filter((k) => !declaredKeys.has(k));
        if (missing.length === 0) continue;
        const stepUsedOnEvent = [...stepsOnEventPipelines].some((s) => s.endsWith(`.${key}`));
        if (!stepUsedOnEvent) continue;
        findings.push(finding(`steps/closed-event-input:${key}`, "steps/closed-event-input", `step "${key}"'s input schema rejects additional properties, so an event trigger's envelope (${missing.join(", ")}) is rejected`, `add ${missing.join(", ")} to input.properties, or drop additionalProperties: false`, { file, step: key }, undefined, "docs/upgrading.md#steps-closed-event-input"));
      }
    }
    return findings;
  },
};
