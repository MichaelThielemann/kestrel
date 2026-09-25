import { isAbsolute, join, relative, sep } from "node:path";
import type { BootCheck, BootProblem } from "@michaelthielemann/kestrel";
import type { RuleContext } from "./plugin.ts";
import type { Edit, Finding, FindingLocation, Severity } from "./report.ts";
import { useToken } from "./useToken.ts";

export { whereOf } from "./report.ts";

export const KESTREL_RANGE = "^6.0.0";

const UPGRADING_DOCS_URL = "https://github.com/MichaelThielemann/kestrel/blob/main/docs/upgrading.md";

/** An absolute link into `docs/upgrading.md`: the installed package ships no `docs/` for a repo-relative link to resolve against. */
export function upgradingDocs(anchor?: string): string {
  return anchor === undefined ? UPGRADING_DOCS_URL : `${UPGRADING_DOCS_URL}#${anchor}`;
}

export function packageJsonPath(ctx: { root: string }): string {
  return join(ctx.root, "package.json");
}

export function finding(id: string, rule: string, message: string, suggestion: string, where: FindingLocation, edits: Edit[] | undefined, docs: string, severity: Severity = "error"): Finding {
  return { id, rule, severity, tier: "source", where, message, suggestion, fix: edits && edits.length > 0 ? { kind: "auto", edits } : { kind: "manual" }, docs };
}

/**
 * Combines the parts of a multi-part edit into one all-or-nothing set: `undefined` for a part means it could not be
 * located, and the whole result becomes manual (`edits: []`), naming every such part; a part that legitimately has
 * nothing to do returns `[]`, not `undefined`, and never blocks the others.
 */
export function combineEditParts(parts: Record<string, Edit[] | undefined>): { edits: Edit[]; missing: string[] } {
  const missing = Object.entries(parts)
    .filter(([, edits]) => edits === undefined)
    .map(([label]) => label);
  if (missing.length > 0) return { edits: [], missing };
  return { edits: Object.values(parts).flatMap((edits) => edits ?? []), missing };
}

export function infoFinding(id: string, rule: string, message: string, suggestion: string, where: FindingLocation, docs: string): Finding {
  return { id, rule, severity: "info", tier: "source", where, message, suggestion, fix: { kind: "none" }, docs };
}

/** An error finding naming the plugin and the hook that threw. Named `plugin/hook-failed:<plugin kind>:<hook>` so more than one failing hook in the same run reports separately. */
export function hookFailedFinding(pluginKind: string, hook: string, err: unknown): Finding {
  const message = `plugin "${pluginKind}"'s ${hook}() threw: ${err instanceof Error ? err.message : String(err)}`;
  return {
    id: `plugin/hook-failed:${pluginKind}:${hook}`,
    rule: "plugin/hook-failed",
    severity: "error",
    tier: "source",
    where: {},
    message,
    suggestion: `fix ${hook}() in the "${pluginKind}" plugin so it does not throw`,
    fix: { kind: "manual" },
    docs: upgradingDocs("plugin-hook-failed"),
  };
}

/** A rule's own `check()` threw (a bug in it, or a JS plugin's rule reaching into `ctx.project` after mislabelling itself `needs: "source"`) — named the same way a failed plugin hook is, so one throwing rule never aborts the whole run. */
export function ruleCheckFailedFinding(ruleId: string, err: unknown): Finding {
  const message = `rule "${ruleId}"'s check() threw: ${err instanceof Error ? err.message : String(err)}`;
  return {
    id: `plugin/hook-failed:${ruleId}:check`,
    rule: "plugin/hook-failed",
    severity: "error",
    tier: "source",
    where: {},
    message,
    suggestion: `fix "${ruleId}"'s check() so it does not throw`,
    fix: { kind: "manual" },
    docs: upgradingDocs("plugin-hook-failed"),
  };
}

export function moduleEntry(ctx: RuleContext, token: string) {
  return ctx.project.input.config.modules.find((m) => useToken(m.use) === token);
}

export function hasModule(ctx: RuleContext, token: string): boolean {
  return ctx.project.input.config.modules.some((m) => useToken(m.use) === token);
}

/** Whether `file` is the project's own — inside `ctx.root` and never through a `node_modules` segment — never an installed package's, whose own published files a rule must not read as if they were the project's. */
export function isProjectFile(ctx: { root: string }, file: string): boolean {
  const rel = relative(ctx.root, file);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return !rel.split(sep).includes("node_modules");
}

export function localModuleFiles(ctx: RuleContext): Array<[string, string]> {
  return [...ctx.project.moduleFiles].filter(([, file]) => (file.endsWith(".ts") || file.endsWith(".js")) && isProjectFile(ctx, file));
}

/** The file a named pipeline lives in, whichever `PipelineFile` entry lists it. */
export function fileForPipeline(ctx: RuleContext, pipelineName: string): string | undefined {
  return ctx.project.pipelineFiles.find((f) => f.pipelines.includes(pipelineName))?.file;
}

function errKey(e: BootProblem): string {
  return [e.code, e.owner, e.reason, e.module, e.pipeline, e.step, e.path].join(":");
}

export interface UncheckedPipeline {
  name: string;
  because: string;
}

export interface VerifyEditsResult {
  verified: boolean;
  newErrors: readonly BootProblem[];
  unchecked: readonly UncheckedPipeline[];
}

/**
 * The shared implementation behind `RuleContext.verifyEdits`: runs `previewBoot(edits)`, diffs its
 * errors against `baseline`'s, and folds in whether every name in `pipelines` was actually checked.
 * `unchecked` names each one the preview's own `notChecked` lists, with its own reason, only once the
 * preview actually reloaded — a preview that did not run at all (no boot tier, or the reload itself
 * failing) carries no such reason and reports `unchecked: []`, still leaving `verified: false`. A rule
 * falls back to calling this directly with `ctx.previewBoot`/`ctx.bootCheck` when `ctx.verifyEdits`
 * itself is absent (a hand-built context older than that field).
 */
export async function verifyEditsWith(previewBoot: ((edits: readonly Edit[]) => Promise<BootCheck | undefined>) | undefined, baseline: BootCheck, edits: readonly Edit[], pipelines: readonly string[]): Promise<VerifyEditsResult> {
  if (previewBoot === undefined) return { verified: false, newErrors: [], unchecked: [] };
  try {
    const raw = await previewBoot(edits);
    if (raw === undefined) return { verified: false, newErrors: [], unchecked: [] };
    const unchecked = raw.notChecked.filter((item) => item.kind === "pipeline" && pipelines.includes(item.name)).map((item) => ({ name: item.name, because: item.because }));
    const baselineKeys = new Set(baseline.errors.map(errKey));
    const newErrors = raw.errors.filter((e) => !baselineKeys.has(errKey(e)));
    return { verified: unchecked.length === 0, newErrors, unchecked };
  } catch {
    return { verified: false, newErrors: [], unchecked: [] };
  }
}

export function pipelinesTriggeredBy(ctx: RuleContext, kind: "http" | "event" | "cron"): Set<string> {
  const names = new Set<string>();
  for (const t of ctx.project.input.config.triggers) {
    if (kind === "http" && "http" in t) names.add(t.pipeline);
    else if (kind === "event" && "event" in t) names.add(t.pipeline);
    else if (kind === "cron" && !("http" in t) && !("event" in t)) names.add(t.pipeline);
  }
  return names;
}

export function eventOfTrigger(ctx: RuleContext, pipeline: string): string[] {
  return ctx.project.input.config.triggers.flatMap((t) => ("event" in t && t.pipeline === pipeline ? [t.event] : []));
}

/** The loaded module owning a registered step name (`<prefix>.<key>`, prefix before the module's own `/`), if any. */
export function moduleOwningStep(ctx: RuleContext, stepName: string): { name: string; file?: string } | undefined {
  const prefix = stepName.split(".")[0];
  const mod = ctx.project.input.modules.find((m) => m.name.split("/")[0] === prefix);
  if (mod === undefined) return undefined;
  const file = ctx.project.moduleFiles.get(mod.name);
  return file === undefined ? { name: mod.name } : { name: mod.name, file };
}

export function shortStepKey(stepName: string): string {
  const dot = stepName.indexOf(".");
  return dot === -1 ? stepName : stepName.slice(dot + 1);
}
