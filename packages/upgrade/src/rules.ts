import { readFileSync } from "node:fs";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { insertModuleListEntry, renameStringLiterals, setModuleConfigProperties } from "./edits.ts";
import { isRecord } from "./guards.ts";
import { setDependencyRange } from "./packageJson.ts";
import type { Rule } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { finding, KESTREL_RANGE, moduleEntry, packageJsonPath } from "./ruleHelpers.ts";
import { bootWrapRules } from "./ruleBootWraps.ts";
import { emitsRule, eventPayloadRule } from "./ruleEmitsEvents.ts";
import { INFO_RULES } from "./ruleInfo.ts";
import { queueOfferRule } from "./ruleQueueOffer.ts";
import { underscoreFieldRules } from "./ruleUnderscoreField.ts";
import { verifiedUserRule } from "./ruleVerifiedUser.ts";
import { useToken } from "./useToken.ts";

export const eventDeliveryRule: Rule = {
  id: "modules/event-delivery",
  check(ctx) {
    const modules = ctx.project.input.config.modules;
    const bus = moduleEntry(ctx, "events-inmemory");
    const hasDelivery = modules.some((m) => ["events-direct", "events-queue"].includes(useToken(m.use)));
    if (!bus || hasDelivery) return [];
    const source = ctx.readFile(ctx.project.configFile);
    const edits: Edit[] = [];
    if (source !== undefined) {
      const edit = insertModuleListEntry(ctx.project.configFile, source, { anchorUse: bus.use, position: "after", use: "@michaelthielemann/kestrel-events-direct", config: "{}" });
      if (edit) edits.push(edit);
    }
    const pkgFile = packageJsonPath(ctx);
    const pkgSource = ctx.readFile(pkgFile);
    if (pkgSource !== undefined) edits.push(setDependencyRange(pkgFile, pkgSource, "dependencies", "@michaelthielemann/kestrel-events-direct", KESTREL_RANGE));
    return [
      finding(
        "modules/event-delivery",
        "modules/event-delivery",
        "an event trigger or events.emit needs exactly one delivery module (events-direct or events-queue) next to events-inmemory",
        "add @michaelthielemann/kestrel-events-direct after kestrel-events-inmemory",
        { file: ctx.project.configFile, module: bus.use },
        edits,
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
    const source = ctx.readFile(ctx.project.configFile);
    const edits: Edit[] = [];
    if (source !== undefined) {
      const edit = insertModuleListEntry(ctx.project.configFile, source, { anchorUse: queue.use, position: "before", use: "@michaelthielemann/kestrel-events-inmemory", config: "{}" });
      if (edit) edits.push(edit);
    }
    const pkgFile = packageJsonPath(ctx);
    const pkgSource = ctx.readFile(pkgFile);
    if (pkgSource !== undefined) edits.push(setDependencyRange(pkgFile, pkgSource, "dependencies", "@michaelthielemann/kestrel-events-inmemory", KESTREL_RANGE));
    return [
      finding(
        "modules/event-bus",
        "modules/event-bus",
        "events-queue requires events@1 instead of providing it; the bus module must be configured next to it",
        "add @michaelthielemann/kestrel-events-inmemory before kestrel-events-queue",
        { file: ctx.project.configFile, module: queue.use },
        edits,
        "docs/upgrading.md#modules-event-bus",
      ),
    ];
  },
};

function effectiveTimeout(config: unknown, key: string): number {
  const value = isRecord(config) ? config[key] : undefined;
  return typeof value === "number" ? value : 5000;
}

export const sqliteAcquireTimeoutRule: Rule = {
  id: "config/sqlite-acquire-timeout",
  check(ctx) {
    const entry = moduleEntry(ctx, "persistence-sqlite");
    if (!entry) return [];
    const acquire = effectiveTimeout(entry.config, "acquireTimeoutMs");
    const busy = effectiveTimeout(entry.config, "busyTimeoutMs");
    if (acquire > busy) return [];
    const busySet = typeof entry.config === "object" && entry.config !== null && "busyTimeoutMs" in entry.config;
    const value = busySet ? `${busy + 10000}` : "15000";
    const source = ctx.readFile(ctx.project.configFile);
    const edits: Edit[] = [];
    if (source !== undefined) {
      const configEdits = setModuleConfigProperties(ctx.project.configFile, source, { use: entry.use, assignments: { acquireTimeoutMs: value } });
      if (configEdits) edits.push(...configEdits);
    }
    return [
      finding(
        "config/sqlite-acquire-timeout",
        "config/sqlite-acquire-timeout",
        "persistence-sqlite requires acquireTimeoutMs to exceed busyTimeoutMs; both default to 5000",
        `add acquireTimeoutMs: ${value}`,
        { file: ctx.project.configFile, module: entry.use },
        edits,
        "docs/upgrading.md#config-sqlite-acquire-timeout",
      ),
    ];
  },
};

const REMOVED_STEPS: Record<string, string> = { "media.folderItems": "media.listFolderItems" };

export const removedStepsRule: Rule = {
  id: "steps/removed",
  check(ctx) {
    const findings: Finding[] = [];
    for (const [pipelineName, file] of ctx.project.pipelineFiles) {
      const source = ctx.readFile(file);
      if (source === undefined) continue;
      for (const [from, to] of Object.entries(REMOVED_STEPS)) {
        const edits = renameStringLiterals(file, source, from, to);
        if (edits.length === 0) continue;
        findings.push(finding(`steps/removed:${pipelineName}:${from}`, "steps/removed", `"${from}" was removed; "${to}" is the same handler`, `rename "${from}" to "${to}"`, { file, pipeline: pipelineName }, edits, "docs/upgrading.md#steps-removed"));
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
      if (typeof range === "string" && name.startsWith("@michaelthielemann/kestrel")) out.push({ map, name, range });
    }
  }
  return out;
}

function majorOf(range: string): number | undefined {
  const match = /(\d+)\.\d+\.\d+/.exec(range);
  return match ? Number(match[1]) : undefined;
}

export const kestrelRangeRule: Rule = {
  id: "deps/kestrel-range",
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
  sqliteAcquireTimeoutRule,
  removedStepsRule,
  kestrelRangeRule,
  verifiedUserRule,
  ...bootWrapRules,
  ...underscoreFieldRules,
  emitsRule,
  eventPayloadRule,
  queueOfferRule,
  ...INFO_RULES,
];

export function readFileOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
