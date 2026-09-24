import { join } from "node:path";
import type { RuleContext } from "./plugin.ts";
import type { Edit, Finding, FindingLocation, Severity } from "./report.ts";
import { useToken } from "./useToken.ts";

export { whereOf } from "./report.ts";

export const KESTREL_RANGE = "^6.0.0";

export function packageJsonPath(ctx: RuleContext): string {
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

export function moduleEntry(ctx: RuleContext, token: string) {
  return ctx.project.input.config.modules.find((m) => useToken(m.use) === token);
}

export function hasModule(ctx: RuleContext, token: string): boolean {
  return ctx.project.input.config.modules.some((m) => useToken(m.use) === token);
}

export function localModuleFiles(ctx: RuleContext): Array<[string, string]> {
  return [...ctx.project.moduleFiles].filter(([, file]) => file.endsWith(".ts") || file.endsWith(".js"));
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
