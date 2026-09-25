import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { BootProblem } from "@michaelthielemann/kestrel";
import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { importSpans, literalStringSpans } from "./ast.ts";
import type { InternalRuleContext } from "./cli-run.ts";
import { emitStepIsLocatable, insertStepAfterEmitOutsideGroup, replaceModuleListEntry, replaceModulesTsEntry } from "./edits.ts";
import { isRecord } from "./guards.ts";
import { replaceDependency } from "./packageJson.ts";
import type { LoadIssue, Rule, RuleContext, SwitchEditsResult } from "./plugin.ts";
import type { AskFix, Edit, Finding } from "./report.ts";
import { emitsRule, eventPayloadRule } from "./ruleEmitsEvents.ts";
import { KESTREL_RANGE, combineEditParts, fileForPipeline, infoFinding, moduleEntry, packageJsonPath, upgradingDocs, verifyEditsWith, type UncheckedPipeline } from "./ruleHelpers.ts";

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
  for (const { file } of ctx.project.pipelineFiles) {
    const source = ctx.readFile(file);
    if (source !== undefined) candidates.set(file, source);
  }
  return [...candidates].filter(([, source]) => importSpans(source, packageName).length > 0).map(([file]) => file);
}

function relativeToProject(ctx: RuleContext, file: string): string {
  const rel = relative(ctx.scratch, file);
  return rel.startsWith("..") || isAbsolute(rel) ? file : rel;
}

function uncoveredRanges(ranges: readonly { start: number; end: number }[], fileEdits: readonly Edit[]): boolean {
  return ranges.some((r) => !fileEdits.some((e) => e.start <= r.start && e.end >= r.end));
}

function literalSite(ctx: RuleContext, packageName: string): string | undefined {
  for (const file of [ctx.project.configFile, modulesTsFile(ctx)]) {
    const source = ctx.readFile(file);
    if (source !== undefined && literalStringSpans(source, packageName).length > 0) return relativeToProject(ctx, file);
  }
  return undefined;
}

function modulesTsBlocker(ctx: RuleContext, packageName: string, edits: readonly Edit[]): string | undefined {
  const modulesTsPath = modulesTsFile(ctx);
  const source = ctx.readFile(modulesTsPath);
  if (source === undefined) return undefined;
  const spans = importSpans(source, packageName);
  if (spans.length === 0) return undefined;
  const fileEdits = edits.filter((e) => e.file === modulesTsPath);
  return uncoveredRanges(spans, fileEdits) ? relativeToProject(ctx, modulesTsPath) : undefined;
}

type SwitchVerification = { verified: true; newErrors: readonly BootProblem[] } | { verified: false; noBootTier: boolean; unchecked: readonly UncheckedPipeline[]; issues: readonly LoadIssue[] };

async function builtInBlockers(ctx: InternalRuleContext, edits: readonly Edit[]): Promise<string[]> {
  const unmet: string[] = [];
  const marker = SERVERLESS_MARKERS.find((m) => existsSync(join(ctx.root, m)));
  if (marker !== undefined) unmet.push(`"${marker}" suggests the process does not stay alive between requests`);

  const directEntry = moduleEntry(ctx, "events-direct");
  if (directEntry === undefined) return unmet;

  const uncoveredSites: string[] = [];
  const modulesTsSite = modulesTsBlocker(ctx, directEntry.use, edits);
  if (modulesTsSite !== undefined) uncoveredSites.push(modulesTsSite);
  uncoveredSites.push(...otherFilesImporting(ctx, directEntry.use).map((f) => relativeToProject(ctx, f)));
  if (uncoveredSites.length > 0) unmet.push(`events-direct is imported where the switch cannot rewrite it: ${uncoveredSites.join(", ")}`);

  if (ctx.previewDetails === undefined) return unmet;
  const details = await ctx.previewDetails(edits);
  if (details?.failed !== undefined) {
    unmet.push(`the switch's own edits could not be verified: ${details.failed.message}`);
    return unmet;
  }
  if (details?.moduleUses === undefined) return unmet;
  const stillDirect = details.moduleUses.includes(directEntry.use);
  const missingQueue = !details.moduleUses.includes(EVENTS_QUEUE_PACKAGE);
  if (stillDirect || missingQueue) {
    const site = literalSite(ctx, directEntry.use);
    const named = site !== undefined ? ` (still named at ${site})` : "";
    const who = ctx.switchEdits === undefined ? "the switch" : ctx.pluginKind === undefined ? "the plugin's switchEdits" : `the "${ctx.pluginKind}" plugin's switchEdits`;
    unmet.push(`after applying its edits, events-direct is still in the booted module list${named}; ${who} did not remove it`);
  }
  return unmet;
}

async function switchAvailability(ctx: InternalRuleContext, relayPipelines: readonly string[]): Promise<{ edits: Edit[]; blockers: string[] }> {
  if (ctx.switchEdits !== undefined) {
    const result: SwitchEditsResult = await ctx.switchEdits(ctx, relayPipelines);
    const edits = Object.values(result.parts).flatMap((edits) => edits ?? []);
    return { edits, blockers: [...(await builtInBlockers(ctx, edits)), ...result.blockers] };
  }
  const edits = switchEdits(ctx, relayPipelines);
  return { edits, blockers: await builtInBlockers(ctx, edits) };
}

async function verifySwitch(ctx: InternalRuleContext, relayPipelines: readonly string[]): Promise<SwitchVerification> {
  const previewBoot = ctx.previewBoot;
  if (!previewBoot) return { verified: false, noBootTier: true, unchecked: [], issues: [] };
  const { edits } = await switchAvailability(ctx, relayPipelines);
  const result = ctx.verifyEdits ? await ctx.verifyEdits(edits, { pipelines: relayPipelines }) : await verifyEditsWith(previewBoot, ctx.bootCheck, edits, relayPipelines);
  if (result.verified) return { verified: true, newErrors: result.newErrors };
  const details = ctx.previewDetails ? await ctx.previewDetails(edits) : undefined;
  return { verified: false, noBootTier: false, unchecked: result.unchecked, issues: details?.issues ?? [] };
}

function unverifiedGuidance(noBootTier: boolean, unchecked: readonly UncheckedPipeline[], issues: readonly LoadIssue[]): { subject: string; instruction: string } {
  if (noBootTier) return { subject: "no boot check ran", instruction: `upgrade @michaelthielemann/kestrel to 6 first, then run \`fix\` again to verify` };
  if (unchecked.length > 0) {
    const plural = unchecked.length > 1;
    const named = unchecked.map((u) => `"${u.name}" (${u.because})`).join("; ");
    return { subject: `relay pipeline${plural ? "s were" : " was"} not checked: ${named}`, instruction: "resolve why, then run `fix` again to verify" };
  }
  const missingPackages = [...new Set(issues.map((i) => i.use).filter((use): use is string => use !== undefined))];
  if (missingPackages.length > 0) {
    const plural = missingPackages.length > 1;
    return { subject: `${missingPackages.join(", ")} ${plural ? "are" : "is"} added by the switch but not installed yet`, instruction: `install ${missingPackages.join(", ")}, then run \`fix\` again to verify` };
  }
  const other = issues.find((i) => i.use === undefined);
  if (other !== undefined) return { subject: `the preview could not verify the switch: ${other.message}`, instruction: "resolve the error above, then run `fix` again to verify" };
  return { subject: "the switch's own preview did not run", instruction: `see the preview/edit-refused finding above for why, or install ${EVENTS_QUEUE_PACKAGE}, then run \`fix\` again to verify` };
}

async function offerGate(ctx: InternalRuleContext): Promise<{ unmet: string[]; unverified: boolean; noBootTier: boolean; unchecked: readonly UncheckedPipeline[]; issues: readonly LoadIssue[] }> {
  const unmet: string[] = [];
  if (!ctx.project.input.config.triggers.some((t) => "event" in t)) unmet.push("no event trigger to move to the queue");
  if (!ctx.project.input.modules.some((m) => m.provides.some((c) => c.name === "persistence@1"))) unmet.push("no loaded module provides persistence@1");
  const sqlite = moduleEntry(ctx, "persistence-sqlite");
  if (sqlite !== undefined && isRecord(sqlite.config) && sqlite.config.file === ":memory:") unmet.push("persistence-sqlite's file is :memory:; a queue that vanishes on restart gains nothing");
  if ((await eventPayloadRule.check(ctx)).length > 0) unmet.push("an open steps/closed-event-input finding exists");
  if ((await emitsRule.check(ctx)).some((f) => f.fix.kind === "ask")) unmet.push("an open modules/emits finding exists");
  const { blockers } = await switchAvailability(ctx, defaultRelayPipelines(ctx));
  unmet.push(...blockers);
  const verification = await verifySwitch(ctx, defaultRelayPipelines(ctx));
  if (!verification.verified) return { unmet, unverified: true, noBootTier: verification.noBootTier, unchecked: verification.unchecked, issues: verification.issues };
  if (verification.newErrors.length > 0) unmet.push(`the switched project fails to boot: ${verification.newErrors.map((e) => e.reason).join("; ")}`);
  return { unmet, unverified: false, noBootTier: false, unchecked: [], issues: [] };
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
    const file = fileForPipeline(ctx, def.name);
    if (file === undefined) continue;
    const source = ctx.readFile(file);
    if (source === undefined) continue;
    const steps = pipelineSteps(def.steps);
    const emitsOfInterest = steps.filter((s) => s.startsWith("events.emit:") && relayEvents.has(s.slice("events.emit:".length).split("?")[0]!));
    const lastEmit = emitsOfInterest.at(-1);
    if (lastEmit === undefined) continue;
    const edit = insertStepAfterEmitOutsideGroup(file, source, { pipelineName: def.name, emitStep: lastEmit, newStep: "events.relay", ...(ctx.locateSteps === undefined ? {} : { locateSteps: ctx.locateSteps }) });
    if (edit) edits.push(edit);
  }
  return edits;
}

function verifiedSwitchEdits(ctx: RuleContext, relayPipelines: readonly string[]): { edits: Edit[]; missing: string[] } {
  const directEntry = moduleEntry(ctx, "events-direct");
  const configSource = directEntry === undefined ? undefined : ctx.readFile(ctx.project.configFile);
  const relayLiteral = `{ relayPipelines: [${relayPipelines.map((p) => `"${p}"`).join(", ")}] }`;
  const configEdit = configSource === undefined || directEntry === undefined ? undefined : replaceModuleListEntry(ctx.project.configFile, configSource, { use: directEntry.use, newUse: EVENTS_QUEUE_PACKAGE, config: relayLiteral });

  const pkgFile = packageJsonPath(ctx);
  const pkgSource = ctx.readFile(pkgFile);
  const pkgEdit = pkgSource === undefined || directEntry === undefined ? undefined : replaceDependency(pkgFile, pkgSource, "dependencies", directEntry.use, EVENTS_QUEUE_PACKAGE, KESTREL_RANGE);

  const modulesTsPath = modulesTsFile(ctx);
  const modulesTsSource = ctx.readFile(modulesTsPath);
  const modulesTsResult: Edit[] | undefined =
    directEntry !== undefined && modulesTsSource !== undefined && importsPackage(modulesTsSource, directEntry.use)
      ? replaceModulesTsEntry(modulesTsPath, modulesTsSource, directEntry.use, EVENTS_QUEUE_PACKAGE)
      : [];

  const parts: Record<string, Edit[] | undefined> = {
    "kestrel.config.ts's modules list": configEdit === undefined ? undefined : [configEdit],
    "package.json's dependencies": pkgEdit,
    "modules.ts's array": modulesTsResult,
  };

  const relayEvents = new Set(ctx.project.input.config.triggers.flatMap((t) => ("event" in t && relayPipelines.includes(t.pipeline) ? [t.event] : [])));
  for (const def of ctx.project.input.pipelines) {
    const file = fileForPipeline(ctx, def.name);
    const source = file === undefined ? undefined : ctx.readFile(file);
    if (file === undefined || source === undefined) continue;
    const steps = pipelineSteps(def.steps);
    const emitsOfInterest = steps.filter((s) => s.startsWith("events.emit:") && relayEvents.has(s.slice("events.emit:".length).split("?")[0]!));
    const lastEmit = emitsOfInterest.at(-1);
    if (lastEmit === undefined) continue;
    const options = { pipelineName: def.name, emitStep: lastEmit, newStep: "events.relay", ...(ctx.locateSteps === undefined ? {} : { locateSteps: ctx.locateSteps }) };
    const label = `pipelines/${def.name}'s events.relay step`;
    if (!emitStepIsLocatable(source, options)) {
      parts[label] = undefined;
      continue;
    }
    const edit = insertStepAfterEmitOutsideGroup(file, source, options);
    parts[label] = edit ? [edit] : [];
  }

  return combineEditParts(parts);
}

const CONSEQUENCES = "uploads and other requests answer at once; a subscriber not named in relayPipelines runs in the worker moments later, retried with backoff, so it can be missing for a few seconds; a failing subscriber no longer fails the request that emitted the event; every event may reach a pipeline more than once; programmatic events.on subscribers stop seeing pipeline-emitted events; the queue lives in the database and switching back later needs it drained first";

/**
 * Offers switching a backend project's event delivery from events-direct to events-queue, never forcing it.
 * The offer only appears once an event is actually delivered through it, a durable persistence module
 * backs the queue, nothing suggests a short-lived process, no open finding leaves an event payload or
 * emit unresolved, and a sandboxed preview of the switch actually booted with no new error. A preview that
 * never ran at all — no boot tier because kestrel is not yet on 6, events-queue not installed, the reload
 * failing, or the preview throwing — is unverified, never treated as clean: the offer still appears, but
 * its question has no default (so `--yes` never answers it) and names what to fix first (upgrade kestrel,
 * or install events-queue) before running `fix` again. At-least-once safety is then the
 * `idempotent:<pipeline>` question per consumer event pipeline, asked only after `switch-to-queue: yes`
 * and skipped for a pipeline the active plugin's own `idempotentPipelines(project)` already names.
 */
export const queueOfferRule: Rule = {
  id: RULE_ID,
  async check(untypedCtx) {
    const ctx = untypedCtx as InternalRuleContext;
    if (!ctx.project.input.config.modules.some((m) => m.use.includes("events-direct"))) return [];

    const { unmet, unverified, noBootTier, unchecked, issues } = await offerGate(ctx);
    if (unmet.length > 0) {
      return [infoFinding(RULE_ID, RULE_ID, `cannot switch to the queue: ${unmet.join("; ")}`, "resolve the conditions above and run check again", {}, upgradingDocs("offer-event-queue"))];
    }

    const switchAnswer = ctx.answers.get("switch-to-queue");
    if (switchAnswer === undefined) {
      let fix: AskFix = { kind: "ask", question: "switch-to-queue", prompt: `switch event delivery to the queue? ${CONSEQUENCES}`, choices: ["no", "yes"], closedChoices: true, defaultValue: "no" };
      if (unverified) {
        const { subject, instruction } = unverifiedGuidance(noBootTier, unchecked, issues);
        fix = { kind: "ask", question: "switch-to-queue", prompt: `switch event delivery to the queue? could not verify: ${subject}; ${instruction}. ${CONSEQUENCES}`, choices: ["no", "yes"], closedChoices: true };
      }
      return [{ id: RULE_ID, rule: RULE_ID, severity: "info", tier: "source", where: {}, message: "can switch to the queue", suggestion: "run fix to be asked; check never decides this on its own", fix, docs: upgradingDocs("offer-event-queue") }];
    }
    if (switchAnswer !== "yes") return [];

    const eventPipelines = consumerEventPipelines(ctx);
    const vouched = new Set(ctx.vouchedIdempotentPipelines ?? []);
    const unresolvedIdempotent = eventPipelines.filter((p) => !vouched.has(p) && ctx.answers.get(`idempotent:${p}`) === undefined);
    if (unresolvedIdempotent.length > 0) {
      return unresolvedIdempotent.map((p): Finding => {
        const fix: AskFix = { kind: "ask", question: `idempotent:${p}`, prompt: `is pipeline "${p}" safe to run twice for one event, or does it deduplicate by eventId?`, choices: ["no", "yes"], closedChoices: true, defaultValue: "no" };
        return { id: `${RULE_ID}:idempotent:${p}`, rule: RULE_ID, severity: "info", tier: "source", where: { pipeline: p }, message: `at-least-once delivery may run "${p}" more than once for one event`, suggestion: "a \"no\" withdraws the switch", fix, docs: upgradingDocs("offer-event-queue") };
      });
    }
    if (eventPipelines.some((p) => ctx.answers.get(`idempotent:${p}`) === "no")) return [];

    const relayAnswer = ctx.answers.get("relay-pipelines");
    if (relayAnswer === undefined) {
      const relayDefault = defaultRelayPipelines(ctx);
      const fix: AskFix = { kind: "ask", question: "relay-pipelines", prompt: "which pipelines should still deliver inside the write request (relayPipelines)?", choices: [relayDefault.join(", ")], defaultValue: relayDefault.join(", ") };
      return [{ id: `${RULE_ID}:relay-pipelines`, rule: RULE_ID, severity: "info", tier: "source", where: {}, message: "which pipelines keep their delivery inside the request", suggestion: "without a pipeline here, relayPipelines has nothing to deliver inside the request", fix, docs: upgradingDocs("offer-event-queue") }];
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
          docs: upgradingDocs("offer-event-queue"),
        },
      ];
    }

    const finalVerification = await verifySwitch(ctx, relayPipelines);
    if (!finalVerification.verified) {
      const { subject, instruction } = unverifiedGuidance(finalVerification.noBootTier, finalVerification.unchecked, finalVerification.issues);
      return [
        {
          id: `${RULE_ID}:relay-pipelines`,
          rule: RULE_ID,
          severity: "info",
          tier: "source",
          where: {},
          message: `could not verify the switch: ${subject}`,
          suggestion: instruction,
          fix: { kind: "manual" },
          docs: upgradingDocs("offer-event-queue"),
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
          docs: upgradingDocs("offer-event-queue"),
        },
      ];
    }

    const { edits, missing } = ctx.switchEdits === undefined ? verifiedSwitchEdits(ctx, relayPipelines) : combineEditParts((await ctx.switchEdits(ctx, relayPipelines)).parts);
    return [
      {
        id: RULE_ID,
        rule: RULE_ID,
        severity: "info",
        tier: "source",
        where: {},
        message: "switching event delivery to the queue",
        suggestion:
          missing.length > 0
            ? `events-queue replaces events-direct with relayPipelines: [${relayPipelines.join(", ")}] by hand; could not locate: ${missing.join(", ")}`
            : `events-queue replaces events-direct with relayPipelines: [${relayPipelines.join(", ")}]; run pnpm install afterwards`,
        fix: edits.length > 0 ? { kind: "auto", edits } : { kind: "manual" },
        docs: upgradingDocs("offer-event-queue"),
      },
    ];
  },
};
