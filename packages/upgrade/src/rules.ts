import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { BACKEND_PACKAGE_NAMES } from "./backendPackages.ts";
import { insertModuleListEntry, insertModulesTsEntry, renameStringLiterals } from "./edits.ts";
import { isRecord } from "./guards.ts";
import { setDependencyRange } from "./packageJson.ts";
import type { Rule, RuleContext, SourceRule } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { combineEditParts, finding, KESTREL_RANGE, moduleEntry, packageJsonPath } from "./ruleHelpers.ts";
import { bootWrapRules } from "./ruleBootWraps.ts";
import { emitsRule, eventPayloadRule } from "./ruleEmitsEvents.ts";
import { fieldGrantRules } from "./ruleFieldGrants.ts";
import { INFO_RULES } from "./ruleInfo.ts";
import { mediaRules } from "./ruleMedia.ts";
import { queueOfferRule } from "./ruleQueueOffer.ts";
import { underscoreFieldRules } from "./ruleUnderscoreField.ts";
import { verifiedUserRule } from "./ruleVerifiedUser.ts";
import { useToken } from "./useToken.ts";

function modulesTsEdits(ctx: RuleContext, packageName: string): Edit[] | undefined {
  const file = join(dirname(ctx.project.configFile), "modules.ts");
  const source = ctx.readFile(file);
  if (source === undefined) return [];
  return insertModulesTsEntry(file, source, packageName);
}

function addDeliveryModuleFinding(ctx: RuleContext, ruleId: string, anchor: { use: string }, position: "before" | "after", newUse: string, message: string, suggestion: string, docs: string): Finding {
  const source = ctx.readFile(ctx.project.configFile);
  const configEdit = source === undefined ? undefined : insertModuleListEntry(ctx.project.configFile, source, { anchorUse: anchor.use, position, use: newUse, config: "{}" });
  const pkgFile = packageJsonPath(ctx);
  const pkgSource = ctx.readFile(pkgFile);
  const pkgEdit = pkgSource === undefined ? undefined : [setDependencyRange(pkgFile, pkgSource, "dependencies", newUse, KESTREL_RANGE)];
  const { edits, missing } = combineEditParts({
    "kestrel.config.ts's modules list": configEdit === undefined ? undefined : [configEdit],
    "package.json's dependencies": pkgEdit,
    "modules.ts's array": modulesTsEdits(ctx, newUse),
  });
  return finding(ruleId, ruleId, message, missing.length > 0 ? `${suggestion} by hand; could not locate: ${missing.join(", ")}` : suggestion, { file: ctx.project.configFile, module: anchor.use }, edits, docs);
}

export const eventDeliveryRule: Rule = {
  id: "modules/event-delivery",
  check(ctx) {
    const modules = ctx.project.input.config.modules;
    const bus = moduleEntry(ctx, "events-inmemory");
    const hasDelivery = modules.some((m) => ["events-direct", "events-queue"].includes(useToken(m.use)));
    if (!bus || hasDelivery) return [];
    return [
      addDeliveryModuleFinding(
        ctx,
        "modules/event-delivery",
        bus,
        "after",
        "@michaelthielemann/kestrel-events-direct",
        "an event trigger or events.emit needs exactly one delivery module (events-direct or events-queue) next to events-inmemory",
        "add @michaelthielemann/kestrel-events-direct after kestrel-events-inmemory",
        "docs/upgrading.md#modules-event-delivery",
      ),
    ];
  },
};

export const eventBusRule: Rule = {
  id: "modules/event-bus",
  check(ctx) {
    const modules = ctx.project.input.config.modules;
    const queue = moduleEntry(ctx, "events-queue");
    const hasBus = modules.some((m) => useToken(m.use) === "events-inmemory");
    if (!queue || hasBus) return [];
    return [
      addDeliveryModuleFinding(
        ctx,
        "modules/event-bus",
        queue,
        "before",
        "@michaelthielemann/kestrel-events-inmemory",
        "events-queue requires events@1 instead of providing it; the bus module must be configured next to it",
        "add @michaelthielemann/kestrel-events-inmemory before kestrel-events-queue",
        "docs/upgrading.md#modules-event-bus",
      ),
    ];
  },
};

const REMOVED_STEPS: Record<string, string> = { "media.folderItems": "media.listFolderItems" };

export const removedStepsRule: Rule = {
  id: "steps/removed",
  check(ctx) {
    const findings: Finding[] = [];
    for (const { file, pipelines } of ctx.project.pipelineFiles) {
      const source = ctx.readFile(file);
      if (source === undefined) continue;
      for (const [from, to] of Object.entries(REMOVED_STEPS)) {
        const edits = renameStringLiterals(file, source, from, to);
        if (edits.length === 0) continue;
        const where = pipelines.length === 1 ? { file, pipeline: pipelines[0]! } : { file };
        findings.push(finding(`steps/removed:${file}:${from}`, "steps/removed", `"${from}" was removed; "${to}" is the same handler`, `rename "${from}" to "${to}"`, where, edits, "docs/upgrading.md#steps-removed"));
      }
    }
    return findings;
  },
};

function kestrelDependencyRanges(source: string): Array<{ map: "dependencies" | "devDependencies" | "peerDependencies"; name: string; range: string }> {
  const pkg = boundaryCast<unknown>(JSON.parse(source), "json");
  const out: Array<{ map: "dependencies" | "devDependencies" | "peerDependencies"; name: string; range: string }> = [];
  if (!isRecord(pkg)) return out;
  for (const map of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const value = pkg[map];
    if (!isRecord(value)) continue;
    for (const [name, range] of Object.entries(value)) {
      if (typeof range === "string" && BACKEND_PACKAGE_NAMES.includes(name)) out.push({ map, name, range });
    }
  }
  return out;
}

function majorOf(range: string): number | undefined {
  const match = /(\d+)\.\d+\.\d+/.exec(range);
  return match ? Number(match[1]) : undefined;
}

export const kestrelRangeRule: SourceRule = {
  id: "deps/kestrel-range",
  needs: "source",
  check(ctx) {
    const pkgFile = packageJsonPath(ctx);
    const source = ctx.readFile(pkgFile);
    if (source === undefined) return [];
    const findings: Finding[] = [];
    for (const dep of kestrelDependencyRanges(source)) {
      const major = majorOf(dep.range);
      if (major === 6) continue;
      const edit = setDependencyRange(pkgFile, source, dep.map, dep.name, KESTREL_RANGE);
      findings.push(finding(`deps/kestrel-range:${dep.name}`, "deps/kestrel-range", `${dep.name} is at ${dep.range}, not a 6.x range`, `set ${dep.name} to "${KESTREL_RANGE}"`, { file: pkgFile, module: dep.name }, [edit], "docs/upgrading.md#deps-kestrel-range"));
    }
    return findings;
  },
};

export const DEFAULT_RULES: readonly Rule[] = [
  eventDeliveryRule,
  eventBusRule,
  removedStepsRule,
  kestrelRangeRule,
  verifiedUserRule,
  ...bootWrapRules,
  ...underscoreFieldRules,
  emitsRule,
  eventPayloadRule,
  queueOfferRule,
  ...mediaRules,
  ...fieldGrantRules,
  ...INFO_RULES,
];

export function readFileOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
