import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BootProblem } from "@michaelthielemann/kestrel";
import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { insertStepAfterEmitOutsideGroup, replaceModuleListEntry, replaceModulesTsEntry } from "./edits.ts";
import { isRecord } from "./guards.ts";
import { replaceDependency } from "./packageJson.ts";
import type { Rule, RuleContext } from "./plugin.ts";
import type { AskFix, Edit, Finding } from "./report.ts";
import { emitsRule, eventPayloadRule } from "./ruleEmitsEvents.ts";
import { KESTREL_RANGE, infoFinding, moduleEntry, packageJsonPath } from "./ruleHelpers.ts";

const RULE_ID = "offer/event-queue";
const SERVERLESS_MARKERS = ["vercel.json", "netlify.toml", "wrangler.toml", "serverless.yml", "template.yaml"];
const EVENTS_QUEUE_PACKAGE = "@michaelthielemann/kestrel-events-queue";

function modulesTsFile(ctx: RuleContext): string {
  return join(dirname(ctx.project.configFile), "modules.ts");
}

function importsPackage(source: string, packageName: string): boolean {
  return source.includes(`"${packageName}"`) || source.includes(`'${packageName}'`);
}

function otherFilesImporting(ctx: RuleContext, packageName: string): string[] {
  const candidates = new Map<string, string>();
  for (const file of ctx.project.moduleFiles.values()) {
    const source = ctx.readFile(file);
    if (source !== undefined) candidates.set(file, source);
  }
  for (const file of ctx.project.pipelineFiles.values()) {
    const source = ctx.readFile(file);
    if (source !== undefined) candidates.set(file, source);
  }
  return [...candidates].filter(([, source]) => importsPackage(source, packageName)).map(([file]) => file);
}

function switchBlockers(ctx: RuleContext): string[] {
  const directEntry = moduleEntry(ctx, "events-direct");
  if (directEntry === undefined) return [];
  const blockers: string[] = [];
  const modulesTsPath = modulesTsFile(ctx);
  const modulesTsSource = ctx.readFile(modulesTsPath);
  if (modulesTsSource !== undefined && importsPackage(modulesTsSource, directEntry.use)) {
    const replaced = replaceModulesTsEntry(modulesTsPath, modulesTsSource, directEntry.use, EVENTS_QUEUE_PACKAGE);
    if (replaced === undefined) blockers.push(modulesTsPath);
  }
  blockers.push(...otherFilesImporting(ctx, directEntry.use));
  return blockers;
}

function errKey(e: BootProblem): string {
  return [e.code, e.owner, e.reason, e.module, e.pipeline, e.step, e.path].join(":");
}

type SwitchVerification = { verified: true; newErrors: readonly BootProblem[] } | { verified: false };

async function verifySwitch(ctx: RuleContext, relayPipelines: readonly string[]): Promise<SwitchVerification> {
  if (!ctx.previewBoot) return { verified: true, newErrors: [] };
  const preview = await ctx.previewBoot(switchEdits(ctx, relayPipelines));
  if (!preview) return { verified: false };
  const baseline = new Set(ctx.bootCheck.errors.map(errKey));
  return { verified: true, newErrors: preview.errors.filter((e) => !baseline.has(errKey(e))) };
}

async function offerGate(ctx: RuleContext): Promise<{ unmet: string[]; unverified: boolean }> {
  const unmet: string[] = [];
  if (!ctx.project.input.config.triggers.some((t) => "event" in t)) unmet.push("no event trigger to move to the queue");
  if (!ctx.project.input.modules.some((m) => m.provides.some((c) => c.name === "persistence@1"))) unmet.push("no loaded module provides persistence@1");
  const sqlite = moduleEntry(ctx, "persistence-sqlite");
  if (sqlite !== undefined && isRecord(sqlite.config) && sqlite.config.file === ":memory:") unmet.push("persistence-sqlite's file is :memory:; a queue that vanishes on restart gains nothing");
  const marker = SERVERLESS_MARKERS.find((m) => existsSync(join(ctx.root, m)));
  if (marker !== undefined) unmet.push(`"${marker}" suggests the process does not stay alive between requests`);
  if ((await eventPayloadRule.check(ctx)).length > 0) unmet.push("an open steps/closed-event-input finding exists");
  if ((await emitsRule.check(ctx)).some((f) => f.fix.kind === "ask")) unmet.push("an open modules/emits finding exists");
  const blockers = switchBlockers(ctx);
  if (blockers.length > 0) unmet.push(`events-direct is imported where the switch cannot rewrite it: ${blockers.join(", ")}`);
  const verification = await verifySwitch(ctx, defaultRelayPipelines(ctx));
  if (!verification.verified) return { unmet, unverified: true };
  if (verification.newErrors.length > 0) unmet.push(`the switched project fails to boot: ${verification.newErrors.map((e) => e.reason).join("; ")}`);
  return { unmet, unverified: false };
}

function consumerEventPipelines(ctx: RuleContext): string[] {
  return [...new Set(ctx.project.input.config.triggers.flatMap((t) => ("event" in t ? [t.pipeline] : [])))];
}

function defaultRelayPipelines(ctx: RuleContext): string[] {
  const eventTriggered = new Set(consumerEventPipelines(ctx));
  return ctx.project.input.pipelines
    .filter((def) => eventTriggered.has(def.name) && pipelineSteps(def.steps).some((s) => s.startsWith("delivery.publish:") || s.startsWith("delivery.unpublish:")))
    .map((def) => def.name);
}

function switchEdits(ctx: RuleContext, relayPipelines: readonly string[]): Edit[] {
  const edits: Edit[] = [];
  const directEntry = moduleEntry(ctx, "events-direct");
  const configSource = ctx.readFile(ctx.project.configFile);
  if (directEntry !== undefined && configSource !== undefined) {
    const relayLiteral = `{ relayPipelines: [${relayPipelines.map((p) => `"${p}"`).join(", ")}] }`;
    const edit = replaceModuleListEntry(ctx.project.configFile, configSource, { use: directEntry.use, newUse: EVENTS_QUEUE_PACKAGE, config: relayLiteral });
    if (edit) edits.push(edit);
  }
  const pkgFile = packageJsonPath(ctx);
  const pkgSource = ctx.readFile(pkgFile);
  if (pkgSource !== undefined && directEntry !== undefined) {
    edits.push(...replaceDependency(pkgFile, pkgSource, "dependencies", directEntry.use, EVENTS_QUEUE_PACKAGE, KESTREL_RANGE));
  }
  const modulesTsPath = modulesTsFile(ctx);
  const modulesTsSource = ctx.readFile(modulesTsPath);
  if (directEntry !== undefined && modulesTsSource !== undefined && importsPackage(modulesTsSource, directEntry.use)) {
    const replaced = replaceModulesTsEntry(modulesTsPath, modulesTsSource, directEntry.use, EVENTS_QUEUE_PACKAGE);
    if (replaced) edits.push(...replaced);
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
    const edit = insertStepAfterEmitOutsideGroup(file, source, { pipelineName: def.name, emitStep: lastEmit, newStep: "events.relay" });
    if (edit) edits.push(edit);
  }
  return edits;
}

const CONSEQUENCES = "uploads and other requests answer at once; a subscriber not named in relayPipelines runs in the worker moments later, retried with backoff, so it can be missing for a few seconds; a failing subscriber no longer fails the request that emitted the event; every event may reach a pipeline more than once; programmatic events.on subscribers stop seeing pipeline-emitted events; the queue lives in the database and switching back later needs it drained first";

/**
 * Offers switching a backend project's event delivery from events-direct to events-queue, never forcing it.
 * The offer only appears once an event is actually delivered through it, a durable persistence module
 * backs the queue, nothing suggests a short-lived process, no open finding leaves an event payload or
 * emit unresolved, and a sandboxed preview of the switch does not introduce a new boot error. When
 * events-queue is not installed yet, the preview cannot run at all: the offer still appears, but its
 * question has no default (so `--yes` never answers it) and names the package to install first. At-least-once
 * safety is then the `idempotent:<pipeline>` question per consumer event pipeline, asked only after
 * `switch-to-queue: yes`.
 */
export const queueOfferRule: Rule = {
  id: RULE_ID,
  async check(ctx) {
    if (!ctx.project.input.config.modules.some((m) => m.use.includes("events-direct"))) return [];

    const { unmet, unverified } = await offerGate(ctx);
    if (unmet.length > 0) {
      return [infoFinding(RULE_ID, RULE_ID, `cannot switch to the queue: ${unmet.join("; ")}`, "resolve the conditions above and run check again", {}, "docs/upgrading.md#offer-event-queue")];
    }

    const switchAnswer = ctx.answers.get("switch-to-queue");
    if (switchAnswer === undefined) {
      const fix: AskFix = unverified
        ? { kind: "ask", question: "switch-to-queue", prompt: `switch event delivery to the queue? could not verify: ${EVENTS_QUEUE_PACKAGE} is not installed; install it, then run \`fix\` again to verify. ${CONSEQUENCES}`, choices: ["no", "yes"] }
        : { kind: "ask", question: "switch-to-queue", prompt: `switch event delivery to the queue? ${CONSEQUENCES}`, choices: ["no", "yes"], defaultValue: "no" };
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

    const knownPipelines = new Set(ctx.project.input.pipelines.map((p) => p.name));
    const unknownNames = relayPipelines.filter((name) => !knownPipelines.has(name));
    if (unknownNames.length > 0) {
      return [
        {
          id: `${RULE_ID}:relay-pipelines`,
          rule: RULE_ID,
          severity: "error",
          tier: "source",
          where: {},
          message: `relay-pipelines names a pipeline this project does not have: ${unknownNames.join(", ")}`,
          suggestion: `the project's pipelines are: ${[...knownPipelines].join(", ") || "(none)"}`,
          fix: { kind: "manual" },
          docs: "docs/upgrading.md#offer-event-queue",
        },
      ];
    }

    const finalVerification = await verifySwitch(ctx, relayPipelines);
    if (!finalVerification.verified) {
      return [
        {
          id: `${RULE_ID}:relay-pipelines`,
          rule: RULE_ID,
          severity: "info",
          tier: "source",
          where: {},
          message: `could not verify the switch: ${EVENTS_QUEUE_PACKAGE} is not installed`,
          suggestion: `install ${EVENTS_QUEUE_PACKAGE}, then run \`fix\` again to verify`,
          fix: { kind: "manual" },
          docs: "docs/upgrading.md#offer-event-queue",
        },
      ];
    }
    if (finalVerification.newErrors.length > 0) {
      return [
        {
          id: `${RULE_ID}:relay-pipelines`,
          rule: RULE_ID,
          severity: "error",
          tier: "source",
          where: {},
          message: `the switch with relayPipelines: [${relayPipelines.join(", ")}] fails to boot: ${finalVerification.newErrors.map((e) => e.reason).join("; ")}`,
          suggestion: "answer relay-pipelines differently, or resolve the boot error above",
          fix: { kind: "manual" },
          docs: "docs/upgrading.md#offer-event-queue",
        },
      ];
    }

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
