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
      findings.push(infoFinding(`responses/delivery-members:${t.http}`, "responses/delivery-members", `${t.http} runs a delivery step whose response shape changed: delivery.publish now merges { document, delivery } instead of _delivery, delivery.exportLlms writes llms instead of _llms, and a missing id is 400 instead of 500`, "update any client reading the old field names", { file: ctx.project.configFile, pipeline: t.pipeline }, "docs/upgrading.md#responses-delivery-members"));
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

/** `types/breaking-signatures`: `Deps`, `Introspection`, `PipelineDefinition["steps"]`, `ModuleManifest` and `FakePersistence` all gained required members; only the consumer's own typecheck sees a violation. */
export const typeSignaturesRule: Rule = {
  id: "types/breaking-signatures",
  check() {
    return [
      infoFinding("types/breaking-signatures", "types/breaking-signatures", "Deps.eventTriggers, Introspection.health(), PipelineDefinition[\"steps\"] (readonly PipelineEntry[]), ModuleManifest.atomicScope and FakePersistence's atomic members are all required now", "run your own typecheck after installing the 6.0.0 packages; a hand-built implementation of any of these needs the new members", {}, "docs/upgrading.md#types-breaking-signatures"),
    ];
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

export const INFO_RULES: readonly Rule[] = [deliveryMembersRule, busHandlerThrowsRule, busSubscriberQueueRule, typeSignaturesRule, runPipelineValidatesRule, restoreFreshnessRule];
