import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { isRecord } from "./guards.ts";
import type { Rule } from "./plugin.ts";
import type { Finding } from "./report.ts";
import { hasModule, infoFinding, localModuleFiles, moduleEntry } from "./ruleHelpers.ts";

const DELIVERY_STEPS = ["delivery.publish", "delivery.unpublish", "delivery.exportLlms"];

/** `responses/delivery-members`: an HTTP-triggered pipeline running a delivery step answers with the 6.0.0 response shape, not the 5.8 one. */
export const deliveryMembersRule: Rule = {
  id: "responses/delivery-members",
  check(ctx) {
    const findings: Finding[] = [];
    for (const t of ctx.project.input.config.triggers) {
      if (!("http" in t)) continue;
      const def = ctx.project.input.pipelines.find((p) => p.name === t.pipeline);
      if (def === undefined) continue;
      const usesDelivery = def.steps.some((s) => typeof s === "string" && DELIVERY_STEPS.includes(s.split(":")[0]!));
      if (!usesDelivery) continue;
      findings.push(infoFinding(`responses/delivery-members:${t.http}`, "responses/delivery-members", `${t.http} runs a delivery step whose response shape changed: delivery.publish now merges { document, delivery } into _delivery instead of replacing the result with it, delivery.exportLlms writes _llms instead of llms, and a missing id is 400 instead of 500`, "update any client reading the old field names", { file: ctx.project.configFile, pipeline: t.pipeline }, "docs/upgrading.md#responses-delivery-members"));
    }
    return findings;
  },
};

const ON_CALL = /\.on\(\s*(['"])([^'"]+)\1/g;

function subscribedEventsIn(source: string): string[] {
  const events = new Set<string>();
  for (const match of source.matchAll(ON_CALL)) events.add(match[2]!);
  return [...events];
}

/** `runtime/bus-handler-throws`: a programmatic `events.on` subscriber whose handler throws now fails the emitting run with 500 under events-direct. */
export const busHandlerThrowsRule: Rule = {
  id: "runtime/bus-handler-throws",
  check(ctx) {
    if (!hasModule(ctx, "events-direct")) return [];
    const findings: Finding[] = [];
    for (const [, file] of localModuleFiles(ctx)) {
      const source = ctx.readFile(file);
      if (source === undefined || subscribedEventsIn(source).length === 0) continue;
      findings.push(infoFinding(`runtime/bus-handler-throws:${file}`, "runtime/bus-handler-throws", "a local module subscribes to events@1 with .on(...); with events-direct, a handler that throws now fails the emitting run with 500 instead of being logged and ignored", "make sure the handler cannot throw for an input it does not control, or catch and log inside it", { file }, "docs/upgrading.md#runtime-bus-handler-throws"));
    }
    return findings;
  },
};

/** `runtime/bus-subscriber-queue`: with events-queue, a programmatic `events.on` subscriber no longer sees events a pipeline step emits — the queue never touches the bus. */
export const busSubscriberQueueRule: Rule = {
  id: "runtime/bus-subscriber-queue",
  check(ctx) {
    if (!hasModule(ctx, "events-queue")) return [];
    const triggerEvents = new Set(ctx.project.input.config.triggers.flatMap((t) => ("event" in t ? [t.event] : [])));
    const findings: Finding[] = [];
    for (const [moduleName, file] of localModuleFiles(ctx)) {
      const source = ctx.readFile(file);
      if (source === undefined) continue;
      const subscribed = subscribedEventsIn(source).filter((e) => triggerEvents.has(e));
      if (subscribed.length === 0) continue;
      findings.push(infoFinding(`runtime/bus-subscriber-queue:${moduleName}`, "runtime/bus-subscriber-queue", `module "${moduleName}" subscribes to ${subscribed.join(", ")} with .on(...); with events-queue, a pipeline step's events.emit never touches the bus, so this subscriber stops seeing it`, "move the logic into a pipeline the event triggers, or keep events-direct", { file, module: moduleName }, "docs/upgrading.md#runtime-bus-subscriber-queue"));
    }
    return findings;
  },
};

/** `types/breaking-signatures`: `Deps`, `Introspection`, `PipelineDefinition["steps"]`, `ModuleManifest`, `FakePersistence`, `Manifest` and `Kestrel["contracts"]` all gained required members; only the consumer's own typecheck sees a violation. */
export const typeSignaturesRule: Rule = {
  id: "types/breaking-signatures",
  check() {
    return [
      infoFinding("types/breaking-signatures", "types/breaking-signatures", "Deps.eventTriggers, Introspection.health(), PipelineDefinition[\"steps\"] (readonly PipelineEntry[]), ModuleManifest.atomicScope, FakePersistence's atomic members, Manifest.warnings and Kestrel[\"contracts\"].names() are all required now", "run your own typecheck after installing the 6.0.0 packages; a hand-built implementation of any of these needs the new members", {}, "docs/upgrading.md#types-breaking-signatures"),
    ];
  },
};

const STEP_SHAPE_CHANGES: Record<string, string> = {
  "redirects.lookup": "its hit is now terminalOutput: { redirect: { to, status } }, combined with the 200 as anyOf; status is narrowed to 301 | 302 | 307 | 308 and the schema is closed",
  "media.upload": "its 200 is now anyOf, not oneOf: the continuing branch (after events.relay) carries _events alongside the item or list result, a ctx.done() branch does not -- narrow with '_events' in res, not res._events",
  "insights.readManifest": "its output schema follows Manifest's two new fields, atomicScope and warnings",
  "events.listDead": "its items now carry pipeline and runId, and rows are no longer ordered across pipelines",
};

/** `responses/breaking-step-shapes`: flags a pipeline running one of a handful of steps whose 6.0.0 response or manifest shape differs from 5.8's. */
export const breakingStepShapesRule: Rule = {
  id: "responses/breaking-step-shapes",
  check(ctx) {
    const findings: Finding[] = [];
    for (const def of ctx.project.input.pipelines) {
      for (const step of pipelineSteps(def.steps)) {
        const bareName = step.split(":")[0]!;
        const change = STEP_SHAPE_CHANGES[bareName];
        if (change === undefined) continue;
        findings.push(infoFinding(`responses/breaking-step-shapes:${def.name}:${bareName}`, "responses/breaking-step-shapes", `pipeline "${def.name}" runs "${bareName}", whose shape changed in 6.0.0: ${change}`, "update any client or test reading the old shape", { pipeline: def.name, step: bareName }, "docs/upgrading.md#responses-breaking-step-shapes"));
      }
    }
    return findings;
  },
};

/** `steps/ctx-done-terminal-output`: a local module calling `ctx.done()` needs `terminalOutput` on that step's `describe()` entry now; boot cannot detect a missing one. */
export const ctxDoneTerminalOutputRule: Rule = {
  id: "steps/ctx-done-terminal-output",
  check(ctx) {
    const findings: Finding[] = [];
    for (const [moduleName, file] of localModuleFiles(ctx)) {
      const source = ctx.readFile(file);
      if (source === undefined || !source.includes("ctx.done(")) continue;
      findings.push(infoFinding(`steps/ctx-done-terminal-output:${moduleName}`, "steps/ctx-done-terminal-output", `module "${moduleName}" calls ctx.done(); a step whose early result does not match its terminalOutput schema now fails the run, and boot cannot detect a mismatch by itself`, "add terminalOutput (the same schema as output when the early result has that shape) to every step that calls ctx.done()", { file, module: moduleName }, "docs/upgrading.md#steps-ctx-done-terminal-output"));
    }
    return findings;
  },
};

/** `tests/run-pipeline-validates`: `testing/runPipeline` now always validates `ctx.result` against the folded output schema. */
export const runPipelineValidatesRule: Rule = {
  id: "tests/run-pipeline-validates",
  check(ctx) {
    const findings: Finding[] = [];
    for (const [, file] of ctx.project.moduleFiles) {
      const source = ctx.readFile(file);
      if (source !== undefined && /testing\/runPipeline/.test(source)) {
        findings.push(infoFinding(`tests/run-pipeline-validates:${file}`, "tests/run-pipeline-validates", "testing/runPipeline always validates ctx.result against the folded output schema now", "run your tests; one that produced an undeclared shape now fails", { file }, "docs/upgrading.md#tests-run-pipeline-validates"));
      }
    }
    return findings;
  },
};

/** `runtime/restore-freshness`: `replication-sqlite`/`backup-blobstore` now fail boot when the database file was created during this boot while a restore point exists, if `restoreOnStart` is on (the default). */
export const restoreFreshnessRule: Rule = {
  id: "runtime/restore-freshness",
  check(ctx) {
    const findings: Finding[] = [];
    for (const token of ["replication-sqlite", "backup-blobstore"]) {
      const entry = moduleEntry(ctx, token);
      if (entry === undefined) continue;
      const restoreOnStart = isRecord(entry.config) && entry.config.restoreOnStart === false ? false : true;
      if (!restoreOnStart) continue;
      findings.push(infoFinding(`runtime/restore-freshness:${token}`, "runtime/restore-freshness", `${entry.use} fails boot now when the database file was created during this boot while a restore point exists (restoreOnStart is on)`, "deploy so the database file already exists before the first 6.0.0 boot, or set restoreOnStart: false where that is not wanted", { module: entry.use }, "docs/upgrading.md#runtime-restore-freshness"));
    }
    return findings;
  },
};

export const INFO_RULES: readonly Rule[] = [deliveryMembersRule, busHandlerThrowsRule, busSubscriberQueueRule, typeSignaturesRule, breakingStepShapesRule, ctxDoneTerminalOutputRule, runPipelineValidatesRule, restoreFreshnessRule];
