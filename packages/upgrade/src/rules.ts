import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { BACKEND_PACKAGE_NAMES } from "./backendPackages.ts";
import { insertModuleListEntry, insertModulesTsEntry, renameStringLiterals } from "./edits.ts";
import { isRecord } from "./guards.ts";
import { removeDependency, setDependencyRange } from "./packageJson.ts";
import type { Rule, RuleContext, SourceRule } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { combineEditParts, finding, KESTREL_RANGE, moduleEntry, packageJsonPath, upgradingDocs } from "./ruleHelpers.ts";
import { bootWrapRules } from "./ruleBootWraps.ts";
import { contractHelperImportsRule } from "./ruleContractHelpers.ts";
import { DELIVERY_INDEX_RULES } from "./ruleDeliveryIndexes.ts";
import { emitsRule, eventPayloadRule } from "./ruleEmitsEvents.ts";
import { fieldGrantRules } from "./ruleFieldGrants.ts";
import { INFO_RULES } from "./ruleInfo.ts";
import { mediaRules } from "./ruleMedia.ts";
import { kestrelBinariesRule } from "./ruleBinaries.ts";
import { queueOfferRule } from "./ruleQueueOffer.ts";
import { SITE_PATH_RULES } from "./ruleSitePaths.ts";
import { underscoreFieldRules } from "./ruleUnderscoreField.ts";
import { verifiedUserRule } from "./ruleVerifiedUser.ts";
import { mediaListRule } from "./ruleMediaList.ts";
import { requireRoleRule } from "./ruleRequireRole.ts";
import { useToken } from "./useToken.ts";
import { ZOD_RULES } from "./ruleZod.ts";

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
        upgradingDocs("modules-event-delivery"),
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
        upgradingDocs("modules-event-bus"),
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
        findings.push(finding(`steps/removed:${file}:${from}`, "steps/removed", `"${from}" was removed; "${to}" is the same handler`, `rename "${from}" to "${to}"`, where, edits, upgradingDocs("steps-removed")));
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

const CLI_PACKAGE = "@michaelthielemann/kestrel-cli";

type DependencyBlock = "dependencies" | "devDependencies";

function blockEntry(pkg: unknown, block: DependencyBlock, name: string): string | undefined {
  if (!isRecord(pkg)) return undefined;
  const value = pkg[block];
  if (!isRecord(value)) return undefined;
  const range = value[name];
  return typeof range === "string" ? range : undefined;
}

function pluginKindOf(ctx: object): string | undefined {
  return "pluginKind" in ctx && typeof ctx.pluginKind === "string" ? ctx.pluginKind : undefined;
}

function cliPackageFinding(pkgFile: string, source: string, hasKestrel: boolean, pluginKind: string | undefined): Finding | undefined {
  const pkg = boundaryCast<unknown>(JSON.parse(source), "json");
  const target: DependencyBlock = pluginKind === undefined ? "dependencies" : "devDependencies";
  const other: DependencyBlock = target === "dependencies" ? "devDependencies" : "dependencies";
  const inTarget = blockEntry(pkg, target, CLI_PACKAGE);
  const inOther = blockEntry(pkg, other, CLI_PACKAGE);
  if (inTarget === undefined && inOther === undefined && !hasKestrel && pluginKind === undefined) return undefined;
  const edits: Edit[] = [];
  if (inTarget === undefined || majorOf(inTarget) !== 6) edits.push(setDependencyRange(pkgFile, source, target, CLI_PACKAGE, KESTREL_RANGE));
  if (inOther !== undefined) {
    const removed = removeDependency(pkgFile, source, other, CLI_PACKAGE);
    if (removed !== undefined) edits.push(removed);
  }
  if (edits.length === 0) return undefined;
  const why = pluginKind === undefined ? "its `kestrel` command starts the server, so production installs need it" : `the host plugin "${pluginKind}" starts the server, so the command is a development tool here`;
  const message = inTarget === undefined && inOther === undefined ? `${CLI_PACKAGE} is missing; the kestrel command lives in that package from 6.0.0` : inTarget === undefined ? `${CLI_PACKAGE} is in ${other}, not ${target}` : `${CLI_PACKAGE} is at ${inTarget}, not a 6.x range`;
  return finding(`deps/kestrel-range:${CLI_PACKAGE}`, "deps/kestrel-range", message, `set ${CLI_PACKAGE} to "${KESTREL_RANGE}" in ${target} (${why})`, { file: pkgFile, module: CLI_PACKAGE }, edits, upgradingDocs("deps-kestrel-range"));
}

export const kestrelRangeRule: SourceRule = {
  id: "deps/kestrel-range",
  needs: "source",
  check(ctx) {
    const pkgFile = packageJsonPath(ctx);
    const source = ctx.readFile(pkgFile);
    if (source === undefined) return [];
    const findings: Finding[] = [];
    const ranges = kestrelDependencyRanges(source);
    for (const dep of ranges) {
      if (dep.name === CLI_PACKAGE && dep.map !== "peerDependencies") continue;
      const major = majorOf(dep.range);
      if (major === 6) continue;
      const edit = setDependencyRange(pkgFile, source, dep.map, dep.name, KESTREL_RANGE);
      findings.push(finding(`deps/kestrel-range:${dep.name}`, "deps/kestrel-range", `${dep.name} is at ${dep.range}, not a 6.x range`, `set ${dep.name} to "${KESTREL_RANGE}"`, { file: pkgFile, module: dep.name }, [edit], upgradingDocs("deps-kestrel-range")));
    }
    const hasKestrel = ranges.some((dep) => dep.map !== "peerDependencies");
    const cli = cliPackageFinding(pkgFile, source, hasKestrel, pluginKindOf(ctx));
    if (cli !== undefined) findings.push(cli);
    return findings;
  },
};

export const DEFAULT_RULES: readonly Rule[] = [
  eventDeliveryRule,
  eventBusRule,
  removedStepsRule,
  kestrelRangeRule,
  ...ZOD_RULES,
  kestrelBinariesRule,
  verifiedUserRule,
  requireRoleRule,
  mediaListRule,
  contractHelperImportsRule,
  ...bootWrapRules,
  ...underscoreFieldRules,
  emitsRule,
  eventPayloadRule,
  queueOfferRule,
  ...mediaRules,
  ...fieldGrantRules,
  ...SITE_PATH_RULES,
  ...DELIVERY_INDEX_RULES,
  ...INFO_RULES,
];

export function readFileOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
