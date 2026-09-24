import { existsSync } from "node:fs";
import { join } from "node:path";
import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { insertPipelineStep, replaceModuleListEntry } from "./edits.ts";
import { isRecord } from "./guards.ts";
import { removeDependency, setDependencyRange } from "./packageJson.ts";
import type { Rule, RuleContext } from "./plugin.ts";
import type { AskFix, Edit, Finding } from "./report.ts";
import { emitsRule, eventPayloadRule } from "./ruleEmitsEvents.ts";
import { KESTREL_RANGE, infoFinding, moduleEntry, packageJsonPath } from "./ruleHelpers.ts";

const RULE_ID = "offer/event-queue";
const SERVERLESS_MARKERS = ["vercel.json", "netlify.toml", "wrangler.toml", "serverless.yml", "template.yaml"];

async function unmetConditions(ctx: RuleContext): Promise<string[]> {
  const unmet: string[] = [];
  if (!ctx.project.input.config.triggers.some((t) => "event" in t)) unmet.push("no event trigger to move to the queue");
  if (!ctx.project.input.modules.some((m) => m.provides.some((c) => c.name === "persistence@1"))) unmet.push("no loaded module provides persistence@1");
  const sqlite = moduleEntry(ctx, "persistence-sqlite");
  if (sqlite !== undefined && isRecord(sqlite.config) && sqlite.config.file === ":memory:") unmet.push("persistence-sqlite's file is :memory:; a queue that vanishes on restart gains nothing");
  const marker = SERVERLESS_MARKERS.find((m) => existsSync(join(ctx.root, m)));
  if (marker !== undefined) unmet.push(`"${marker}" suggests the process does not stay alive between requests`);
  if ((await eventPayloadRule.check(ctx)).length > 0) unmet.push("an open steps/closed-event-input finding exists");
  if ((await emitsRule.check(ctx)).some((f) => f.fix.kind === "ask")) unmet.push("an open modules/emits finding exists");
  return unmet;
}

function consumerEventPipelines(ctx: RuleContext): string[] {
  return [...new Set(ctx.project.input.config.triggers.flatMap((t) => ("event" in t ? [t.pipeline] : [])))];
}

function defaultRelayPipelines(ctx: RuleContext): string[] {
  return ctx.project.input.pipelines
    .filter((def) => pipelineSteps(def.steps).some((s) => s.startsWith("delivery.publish:") || s.startsWith("delivery.unpublish:")))
    .map((def) => def.name);
}

function switchEdits(ctx: RuleContext, relayPipelines: readonly string[]): Edit[] {
  const edits: Edit[] = [];
  const directEntry = moduleEntry(ctx, "events-direct");
  const configSource = ctx.readFile(ctx.project.configFile);
  if (directEntry !== undefined && configSource !== undefined) {
    const relayLiteral = `{ relayPipelines: [${relayPipelines.map((p) => `"${p}"`).join(", ")}] }`;
    const edit = replaceModuleListEntry(ctx.project.configFile, configSource, { use: directEntry.use, newUse: "@michaelthielemann/kestrel-events-queue", config: relayLiteral });
    if (edit) edits.push(edit);
  }
  const pkgFile = packageJsonPath(ctx);
  const pkgSource = ctx.readFile(pkgFile);
  if (pkgSource !== undefined) {
    edits.push(setDependencyRange(pkgFile, pkgSource, "dependencies", "@michaelthielemann/kestrel-events-queue", KESTREL_RANGE));
    const removed = removeDependency(pkgFile, pkgSource, "dependencies", "@michaelthielemann/kestrel-events-direct");
    if (removed) edits.push(removed);
  }
  const relayEvents = new Set(ctx.project.input.config.triggers.flatMap((t) => ("event" in t && relayPipelines.includes(t.pipeline) ? [t.event] : [])));
  for (const def of ctx.project.input.pipelines) {
    const file = ctx.project.pipelineFiles.get(def.name);
    if (file === undefined) continue;
    const source = ctx.readFile(file);
    if (source === undefined) continue;
    const steps = pipelineSteps(def.steps);
    const emitsOfInterest = steps.filter((s) => s.startsWith("events.emit:") && relayEvents.has(s.slice("events.emit:".length).split("?")[0]!));
    const lastEmit = emitsOfInterest.at(-1);
    if (lastEmit === undefined) continue;
    const edit = insertPipelineStep(file, source, { pipelineName: def.name, anchorStep: lastEmit, position: "after", newStep: "events.relay" });
    if (edit) edits.push(edit);
  }
  return edits;
}

const CONSEQUENCES = "uploads and other requests answer at once; a subscriber not named in relayPipelines runs in the worker moments later, retried with backoff, so it can be missing for a few seconds; a failing subscriber no longer fails the request that emitted the event; every event may reach a pipeline more than once; programmatic events.on subscribers stop seeing pipeline-emitted events; the queue lives in the database and switching back later needs it drained first";

/**
 * Offers switching a backend project's event delivery from events-direct to events-queue, never forcing it.
 * Detection gates whether the offer appears at all; at-least-once safety is the
 * `idempotent:<pipeline>` question per consumer event pipeline, asked only after `switch-to-queue: yes`.
 * A boot-tier re-check (verifying the switch on a sandboxed preview) is not
 * reproduced here — see the package README for why.
 */
export const queueOfferRule: Rule = {
  id: RULE_ID,
  async check(ctx) {
    if (!ctx.project.input.config.modules.some((m) => m.use.includes("events-direct"))) return [];

    const unmet = await unmetConditions(ctx);
    if (unmet.length > 0) {
      return [infoFinding(RULE_ID, RULE_ID, `cannot switch to the queue: ${unmet.join("; ")}`, "resolve the conditions above and run check again", {}, "docs/upgrading.md#offer-event-queue")];
    }

    const switchAnswer = ctx.answers.get("switch-to-queue");
    if (switchAnswer === undefined) {
      const fix: AskFix = { kind: "ask", question: "switch-to-queue", prompt: `switch event delivery to the queue? ${CONSEQUENCES}`, choices: ["no", "yes"], defaultValue: "no" };
      return [{ id: RULE_ID, rule: RULE_ID, severity: "info", tier: "source", where: {}, message: "can switch to the queue", suggestion: "run fix to be asked; check never decides this on its own", fix, docs: "docs/upgrading.md#offer-event-queue" }];
    }
    if (switchAnswer !== "yes") return [];

    const eventPipelines = consumerEventPipelines(ctx);
    const unresolvedIdempotent = eventPipelines.filter((p) => ctx.answers.get(`idempotent:${p}`) === undefined);
    if (unresolvedIdempotent.length > 0) {
      return unresolvedIdempotent.map((p): Finding => {
        const fix: AskFix = { kind: "ask", question: `idempotent:${p}`, prompt: `is pipeline "${p}" safe to run twice for one event, or does it deduplicate by eventId?`, choices: ["no", "yes"], defaultValue: "no" };
        return { id: `${RULE_ID}:idempotent:${p}`, rule: RULE_ID, severity: "info", tier: "source", where: { pipeline: p }, message: `at-least-once delivery may run "${p}" more than once for one event`, suggestion: "a \"no\" withdraws the switch", fix, docs: "docs/upgrading.md#offer-event-queue" };
      });
    }
    if (eventPipelines.some((p) => ctx.answers.get(`idempotent:${p}`) === "no")) return [];

    const relayAnswer = ctx.answers.get("relay-pipelines");
    if (relayAnswer === undefined) {
      const relayDefault = defaultRelayPipelines(ctx);
      const fix: AskFix = { kind: "ask", question: "relay-pipelines", prompt: "which pipelines should still deliver inside the write request (relayPipelines)?", choices: [relayDefault.join(", ")], defaultValue: relayDefault.join(", ") };
      return [{ id: `${RULE_ID}:relay-pipelines`, rule: RULE_ID, severity: "info", tier: "source", where: {}, message: "which pipelines keep their delivery inside the request", suggestion: "without a pipeline here, relayPipelines has nothing to deliver inside the request", fix, docs: "docs/upgrading.md#offer-event-queue" }];
    }

    const relayPipelines = relayAnswer
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const edits = switchEdits(ctx, relayPipelines);
    return [
      {
        id: RULE_ID,
        rule: RULE_ID,
        severity: "info",
        tier: "source",
        where: {},
        message: "switching event delivery to the queue",
        suggestion: `events-queue replaces events-direct with relayPipelines: [${relayPipelines.join(", ")}]; run pnpm install afterwards`,
        fix: edits.length > 0 ? { kind: "auto", edits } : { kind: "manual" },
        docs: "docs/upgrading.md#offer-event-queue",
      },
    ];
  },
};
