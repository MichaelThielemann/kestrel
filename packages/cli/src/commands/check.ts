import type { BootProblem, BootWarning, NotChecked } from "@michaelthielemann/kestrel";
import type { HostProblem, LoadIssue } from "@michaelthielemann/kestrel-upgrade/plugin";
import { parseStrict } from "../args.ts";
import { inspectProject, type PluginInfo } from "../inspectProject.ts";
import { COMMAND_USAGE, cliVersion } from "../usage.ts";

/** `kestrel check --json`, `schema: 1`. */
export interface CheckReport {
  schema: 1;
  tool: { name: "kestrel"; version: string };
  project: { root: string; kind: string; installed: Record<string, string> };
  plugins: PluginInfo[];
  issues: LoadIssue[];
  errors: BootProblem[];
  warnings: BootWarning[];
  notChecked: NotChecked[];
  host: HostProblem[];
  sandbox: { rewritten: readonly string[]; consented: readonly string[]; outside: readonly string[] };
}

function fail(message: string): number {
  process.stderr.write(`kestrel check: ${message}\n\n${COMMAND_USAGE.check ?? ""}\n`);
  return 2;
}

function where(parts: Record<string, string | undefined>): string {
  return Object.entries(parts)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key} ${value ?? ""}`)
    .join(" · ");
}

function renderHuman(report: CheckReport): string {
  const lines: string[] = [];
  const plugins = report.plugins.length === 0 ? "none" : report.plugins.map((p) => `${p.package} ${p.version}`).join(", ");
  lines.push(`kestrel check · ${report.project.root} · kind ${report.project.kind} · kestrel ${report.project.installed["@michaelthielemann/kestrel"] ?? "unknown"} · plugins: ${plugins}`);
  for (const issue of report.issues) {
    lines.push(`error    load-failed       ${where({ file: issue.file, module: issue.use })}`);
    lines.push(`         ${issue.message}`);
  }
  for (const problem of report.errors) {
    lines.push(`error    ${problem.code.padEnd(17)} ${where({ pipeline: problem.pipeline, step: problem.step, module: problem.module ?? problem.owner })}`);
    lines.push(`         ${problem.reason}`);
  }
  for (const problem of report.host) {
    lines.push(`${problem.severity.padEnd(8)} ${problem.code.padEnd(17)} ${where({ pipeline: problem.pipeline, module: problem.module ?? problem.owner, file: problem.file })}`);
    lines.push(`         ${problem.reason}`);
  }
  for (const warning of report.warnings) {
    const record: Record<string, unknown> = { ...warning };
    const detail = where({ pipeline: typeof record.pipeline === "string" ? record.pipeline : undefined, event: typeof record.event === "string" ? record.event : undefined, module: typeof record.module === "string" ? record.module : undefined });
    lines.push(`warning  ${warning.code.padEnd(17)} ${detail}`);
    if (typeof record.message === "string") lines.push(`         ${record.message}`);
  }
  for (const item of report.notChecked) {
    const hint = report.sandbox.outside.includes(item.name) ? `; run with --run-setup ${item.name}` : "";
    lines.push(`skipped  ${item.kind} ${item.name} — ${item.because}${hint}`);
  }
  const errors = report.issues.length + report.errors.length + report.host.filter((h) => h.severity === "error").length;
  const warnings = report.warnings.length + report.host.filter((h) => h.severity === "warning").length;
  const notChecked = report.notChecked.length === 0 ? "" : ` · ${report.notChecked.length} not checked`;
  lines.push(`${errors + warnings} problems: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}${notChecked}`);
  return lines.join("\n");
}

function exitCode(report: CheckReport, failOn: "error" | "warning"): number {
  const errors = report.issues.length + report.errors.length + report.host.filter((h) => h.severity === "error").length;
  if (errors > 0) return 1;
  if (failOn === "warning" && (report.warnings.length > 0 || report.notChecked.length > 0 || report.host.length > 0)) return 1;
  return 0;
}

function print(report: CheckReport, json: boolean): void {
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : renderHuman(report)}\n`);
}

/** `kestrel check`: the project's boot check, without starting it. */
export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseStrict(argv, { root: "string", json: "boolean", "fail-on": "string", "run-setup": "repeat", "no-plugins": "boolean" }, 0);
  if (!parsed.ok) return fail(parsed.error);
  const { args } = parsed;
  const failOn = args.strings.get("fail-on") ?? "error";
  if (failOn !== "error" && failOn !== "warning") return fail(`--fail-on takes error or warning, not "${failOn}"`);
  const json = args.booleans.has("json");
  const result = await inspectProject({ root: args.strings.get("root") ?? ".", runSetup: args.repeated.get("run-setup") ?? [], noPlugins: args.booleans.has("no-plugins") });
  const tool = { name: "kestrel" as const, version: cliVersion() };
  if (!result.ok) {
    if (result.kind === "refused") {
      process.stderr.write(`kestrel check: ${result.message}\n`);
      return 2;
    }
    const host = result.outdated.map((o): HostProblem => ({ code: "deps/host-outdated", severity: "error", owner: o.package, module: o.package, reason: o.message }));
    const report: CheckReport = { schema: 1, tool, project: { root: result.root, kind: "unknown", installed: result.installed }, plugins: [], issues: [], errors: [], warnings: [], notChecked: [], host, sandbox: { rewritten: [], consented: [], outside: [] } };
    print(report, json);
    return 1;
  }
  const { prepared, bootCheck, host } = result.value;
  const box = prepared.box;
  const report: CheckReport = {
    schema: 1,
    tool,
    project: { root: prepared.root, kind: prepared.kind, installed: prepared.installed },
    plugins: prepared.plugins,
    issues: prepared.issues,
    errors: bootCheck?.errors ?? [],
    warnings: bootCheck?.warnings ?? [],
    notChecked: bootCheck?.notChecked ?? [],
    host,
    sandbox: { rewritten: box?.rewritten ?? [], consented: box?.consented ?? [], outside: box?.outside ?? [] },
  };
  print(report, json);
  return exitCode(report, failOn);
}
