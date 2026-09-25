export type Severity = "error" | "warning" | "info";
export type Tier = "source" | "load" | "boot" | "data";

export interface Edit {
  file: string;
  start: number;
  end: number;
  text: string;
  /** This edit creates `file`, which must not already exist; `start`/`end` are `0`/`0` and `text` is the whole new file. Refused (the owning finding falls back to manual) when the path exists, or a second edit also tries to create it. */
  create?: true;
}

export interface AskFix {
  kind: "ask";
  question: string;
  prompt: string;
  choices: readonly string[];
  /** `choices` is the complete, exhaustive set of valid answers, so an answer outside it is rejected rather than passed through. Absent when `choices` is only a default or example and the rule parses the raw answer itself — a comma list, a free-form name, a literal path. */
  closedChoices?: true;
  defaultValue?: string;
}

export type FindingFix = { kind: "auto"; edits: Edit[] } | AskFix | { kind: "manual" } | { kind: "none" };

export interface FindingLocation {
  file?: string;
  line?: number;
  column?: number;
  pipeline?: string;
  step?: string;
  module?: string;
  path?: string;
}

export interface Finding {
  id: string;
  rule: string;
  severity: Severity;
  tier: Tier;
  where: FindingLocation;
  message: string;
  suggestion: string;
  fix: FindingFix;
  docs: string;
}

export interface UpgradeReport {
  schema: 1;
  tool: { name: string; version: string };
  target: "6.0.0";
  project: { root: string; kind: string; installed: Record<string, string> };
  tiers: Record<Tier, "done" | "skipped" | "failed" | "not-run">;
  /** Which of the project's own module-list entries the boot-tier sandbox rewrote to reach only the scratch directory, let through as known-safe or explicitly consented, or left outside the sandbox entirely; absent when the boot tier did not run. */
  sandbox?: { rewritten: readonly string[]; consented: readonly string[]; outside: readonly string[] };
  /** `data`'s stored-value count per `<type>.<field>` starting with `_`, keyed by locale (`"unlocalized"` for a field with none); `null` where the table, the column or the count itself could not be read. */
  underscoreFields?: Record<string, Record<string, number | null>>;
  summary: { error: number; warning: number; info: number; auto: number; ask: number; manual: number };
  findings: Finding[];
}

type MaybeLocation = { [K in keyof FindingLocation]?: FindingLocation[K] | undefined };

/** Builds a `FindingLocation`, dropping every field given as `undefined` instead of assigning it (required under `exactOptionalPropertyTypes`). */
export function whereOf(fields: MaybeLocation): FindingLocation {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

export function summarize(findings: readonly Finding[]): UpgradeReport["summary"] {
  const summary = { error: 0, warning: 0, info: 0, auto: 0, ask: 0, manual: 0 };
  for (const f of findings) {
    summary[f.severity]++;
    if (f.fix.kind === "auto" || f.fix.kind === "ask" || f.fix.kind === "manual") summary[f.fix.kind]++;
  }
  return summary;
}

function formatWhere(where: FindingLocation): string {
  if (where.file !== undefined) return where.line === undefined ? where.file : `${where.file}:${where.line}${where.column === undefined ? "" : `:${where.column}`}`;
  if (where.pipeline !== undefined) return where.step === undefined ? `pipelines/${where.pipeline}` : `pipelines/${where.pipeline}#${where.step}`;
  if (where.module !== undefined) return where.module;
  return "";
}

function fixLabel(fix: FindingFix): string {
  return fix.kind;
}

export function renderHuman(report: UpgradeReport): string {
  const lines: string[] = [];
  lines.push(`kestrel-upgrade ${report.tool.version} — project ${report.project.root} (${report.project.kind})`);
  const tierLine = (["source", "load", "boot", "data"] as const).map((t) => `${t} ${report.tiers[t]}`).join(" · ");
  lines.push(`tiers: ${tierLine}`);
  lines.push("");
  const bySeverity = (severity: Severity): Finding[] => report.findings.filter((f) => f.severity === severity);
  const groups: Array<{ title: string; findings: Finding[] }> = [
    { title: `Would not boot on 6.0.0 (${bySeverity("error").length})`, findings: bySeverity("error") },
    { title: `Behaviour to review (${bySeverity("warning").length + bySeverity("info").length})`, findings: [...bySeverity("warning"), ...bySeverity("info")] },
  ];
  for (const group of groups) {
    if (group.findings.length === 0) continue;
    lines.push(group.title);
    for (const f of group.findings) {
      lines.push(`  ${f.severity.padEnd(6)} ${f.rule.padEnd(26)} ${formatWhere(f.where).padEnd(24)} ${f.message} [${fixLabel(f.fix)}]`);
      lines.push(`         ${f.suggestion}`);
    }
    lines.push("");
  }
  const summary = report.summary;
  lines.push(`${summary.error} errors (${summary.auto} auto, ${summary.ask} ask, ${summary.manual} manual) · ${summary.warning} warnings · ${summary.info} info`);
  return lines.join("\n");
}
