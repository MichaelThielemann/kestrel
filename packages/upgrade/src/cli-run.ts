import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { checkBoot, type BootCheck, type BootProblem } from "@michaelthielemann/kestrel";
import { applyEdits } from "./apply.ts";
import { hasArrayHole, parseTs } from "./ast.ts";
import { askFindings, parseAnswersFile, resolveAnswer, ttyPrompt, unknownAnswerIds, type PromptFn } from "./answers.ts";
import { boolFlag, parseArgs, stringFlag, type ParsedArgs } from "./args.ts";
import { unifiedDiff } from "./diff.ts";
import { runDataStep } from "./data.ts";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { isRecord } from "./guards.ts";
import { loadBackendProject, loadIssuesAsFindings, type LoadIssue, type LoadResult } from "./project.ts";
import type { LoadedProject, Rule, RunUpgradeCliOptions, UpgradePlugin } from "./plugin.ts";
import { renderHuman, summarize, whereOf, type Edit, type Finding, type Severity, type UpgradeReport } from "./report.ts";
import { DEFAULT_RULES, readFileOrUndefined } from "./rules.ts";
import { sandboxBootInput, type SandboxTable } from "./sandbox.ts";
import { createScratchCopy, removeScratchCopy } from "./scratch.ts";
import { installedVersions, majorOf } from "./versions.ts";

interface ResolvedProject {
  project?: LoadedProject;
  issues: LoadIssue[];
  rules: readonly Rule[];
  sandboxEntries?: SandboxTable;
  reload: (scratchDir: string) => Promise<LoadResult>;
}

async function detectPlugin(plugins: readonly UpgradePlugin[], root: string): Promise<{ plugin?: UpgradePlugin; issues: LoadIssue[] }> {
  const issues: LoadIssue[] = [];
  for (const plugin of plugins) {
    try {
      if (await plugin.detect(root)) return { plugin, issues };
    } catch (err) {
      issues.push({ message: `plugin "${plugin.kind}" detect() threw: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { issues };
}

async function resolveProject(root: string, entry: string | undefined, scratchDir: string, plugins: readonly UpgradePlugin[]): Promise<ResolvedProject> {
  const { plugin, issues: detectIssues } = await detectPlugin(plugins, root);
  if (plugin === undefined) {
    const { project, issues } = await loadBackendProject(scratchDir, entry === undefined ? undefined : resolve(root, entry));
    const reload = (dir: string): Promise<LoadResult> => loadBackendProject(dir, entry === undefined ? undefined : resolve(root, entry));
    return { ...(project === undefined ? {} : { project }), issues: [...detectIssues, ...issues], rules: DEFAULT_RULES, reload };
  }
  const rules = [...DEFAULT_RULES, ...(plugin.rules ?? [])];
  const sandboxEntries = plugin.sandbox === undefined ? {} : { sandboxEntries: plugin.sandbox };
  const reload = async (dir: string): Promise<LoadResult> => {
    try {
      return { project: await plugin.load(root, dir), issues: [] };
    } catch (err) {
      return { issues: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  try {
    const project = await plugin.load(root, scratchDir);
    return { project, issues: detectIssues, rules, ...sandboxEntries, reload };
  } catch (err) {
    return { issues: [...detectIssues, { message: err instanceof Error ? err.message : String(err) }], rules, ...sandboxEntries, reload };
  }
}

const execFileAsync = promisify(execFile);
const TOOL_VERSION = "5.8.0";

function remap(file: string, scratch: string, root: string): string {
  return resolve(root, relative(scratch, file));
}

function remapFinding(finding: Finding, scratch: string, root: string): Finding {
  const where = finding.where.file === undefined ? finding.where : { ...finding.where, file: remap(finding.where.file, scratch, root) };
  const fix = finding.fix.kind === "auto" ? { kind: "auto" as const, edits: finding.fix.edits.map((e) => ({ ...e, file: remap(e.file, scratch, root) })) } : finding.fix;
  return { ...finding, where, fix };
}

function isSeverity(value: string): value is Severity {
  return value === "error" || value === "warning" || value === "info";
}

function failOnOf(args: ParsedArgs): Severity {
  const value = stringFlag(args, "fail-on") ?? "error";
  return isSeverity(value) ? value : "error";
}

function severityRank(s: Severity): number {
  return s === "error" ? 3 : s === "warning" ? 2 : 1;
}

function exitCodeFor(findings: readonly Finding[], failOn: Severity): number {
  return findings.some((f) => severityRank(f.severity) >= severityRank(failOn)) ? 1 : 0;
}

function readDataReport(file: string | undefined): Record<string, unknown> | undefined {
  if (file === undefined || !existsSync(file)) return undefined;
  const parsed = boundaryCast<unknown>(JSON.parse(readFileSync(file, "utf8")), "json");
  return isRecord(parsed) ? parsed : undefined;
}

interface BuildOptions {
  runSetupUses: readonly string[];
  answers: ReadonlyMap<string, string>;
  dataReport?: Record<string, unknown> | undefined;
  forceMajor?: number | undefined;
  plugins?: readonly UpgradePlugin[] | undefined;
}

function bootErrorFinding(problem: BootProblem): Finding {
  return {
    id: `boot/${problem.code}:${problem.owner}`,
    rule: `boot/${problem.code}`,
    severity: "error",
    tier: "boot",
    where: whereOf({ module: problem.module, pipeline: problem.pipeline, step: problem.step }),
    message: problem.reason,
    suggestion: "see docs/upgrading.md for this boot error code",
    fix: { kind: "manual" },
    docs: "docs/upgrading.md#boot-code",
  };
}

function groupByFile(edits: readonly Edit[]): Map<string, Edit[]> {
  const grouped = new Map<string, Edit[]>();
  for (const edit of edits) {
    const list = grouped.get(edit.file) ?? [];
    list.push(edit);
    grouped.set(edit.file, list);
  }
  return grouped;
}

interface BootPreview {
  bootCheck: BootCheck;
  issues: LoadIssue[];
}

interface BuildResult {
  report: UpgradeReport;
  previewBoot?: (edits: readonly Edit[]) => Promise<BootPreview | undefined>;
}

async function buildReport(root: string, entry: string | undefined, options: BuildOptions): Promise<BuildResult> {
  const versions = installedVersions(root);
  const kestrelVersion = versions.installed["@michaelthielemann/kestrel"];
  const kestrelMajor = options.forceMajor ?? (kestrelVersion === undefined ? undefined : majorOf(kestrelVersion));
  const findings: Finding[] = [];
  const scratch = await createScratchCopy(root);
  try {
    if (versions.mixedMajors) {
      findings.push({
        id: "deps/mixed-majors",
        rule: "deps/mixed-majors",
        severity: "error",
        tier: "source",
        where: {},
        message: "the project's @michaelthielemann/kestrel* dependencies mix majors",
        suggestion: "run fix to bump every out-of-range dependency to ^6.0.0, then pnpm install",
        fix: { kind: "manual" },
        docs: "docs/upgrading.md#deps-kestrel-range",
      });
    }

    const { project, issues, rules, sandboxEntries, reload } = await resolveProject(root, entry, scratch.dir, options.plugins ?? []);
    findings.push(...loadIssuesAsFindings(issues));

    let tiers: UpgradeReport["tiers"] = { source: "not-run", load: "not-run", boot: "not-run", data: "not-run" };
    let bootCheck: Awaited<ReturnType<typeof checkBoot>> = { errors: [], warnings: [], notChecked: [] };
    let outside: readonly string[] = [];

    let previewBootRaw: ((edits: readonly Edit[]) => Promise<BootPreview | undefined>) | undefined;
    let previewBoot: ((edits: readonly Edit[]) => Promise<BootCheck | undefined>) | undefined;

    if (project) {
      tiers = { ...tiers, source: "done" };

      if (kestrelMajor === 6 && !versions.mixedMajors) {
        tiers = { ...tiers, load: "done" };
        const box = sandboxBootInput(project.input, { dir: scratch.dir, consent: options.runSetupUses, ...(sandboxEntries === undefined ? {} : { entries: sandboxEntries }) });
        outside = box.outside;
        bootCheck = await checkBoot(box.input, { setup: box.setup });
        tiers = { ...tiers, boot: "done" };
        for (const use of box.replaced) {
          findings.push({
            id: `sandbox/blobstore-standin:${use}`,
            rule: "sandbox/blobstore-standin",
            severity: "info",
            tier: "boot",
            where: { module: use },
            message: "blobstore replaced by a local stand-in for the check",
            suggestion: "the real module's own setup() never ran here; this only proves the modules requiring blobstore@1 boot",
            fix: { kind: "none" },
            docs: "docs/upgrading.md#sandbox-blobstore-standin",
          });
        }

        previewBootRaw = async (edits) => {
          const preview = await createScratchCopy(root);
          try {
            const grouped = groupByFile(edits);
            for (const [file, fileEdits] of grouped) {
              const target = resolve(preview.dir, relative(scratch.dir, file));
              if (!existsSync(target)) continue;
              writeFileSync(target, applyEdits(readFileSync(target, "utf8"), fileEdits).text);
            }
            const { project: reloadedProject, issues: reloadIssues } = await reload(preview.dir);
            if (!reloadedProject) return undefined;
            const previewSandbox = sandboxBootInput(reloadedProject.input, { dir: preview.dir, consent: options.runSetupUses, ...(sandboxEntries === undefined ? {} : { entries: sandboxEntries }) });
            const bootCheck = await checkBoot(previewSandbox.input, { setup: previewSandbox.setup });
            return { bootCheck, issues: reloadIssues };
          } finally {
            await removeScratchCopy(preview);
          }
        };
        previewBoot = async (edits) => {
          const raw = await previewBootRaw!(edits);
          return raw === undefined || raw.issues.length > 0 ? undefined : raw.bootCheck;
        };
      } else if (kestrelMajor !== undefined && kestrelMajor < 6) {
        findings.push({
          id: "deps/pre-install",
          rule: "deps/pre-install",
          severity: "info",
          tier: "source",
          where: {},
          message: "the 5.x packages are installed; this run sees the source tier only",
          suggestion: "install the 6.0.0 packages and run check again for the load and boot checks",
          fix: { kind: "none" },
          docs: "docs/upgrading.md",
        });
      }

      const projectWithData = options.dataReport === undefined ? project : { ...project, data: options.dataReport };
      const ctx = { root: scratch.dir, scratch: scratch.dir, project: projectWithData, bootCheck, readFile: readFileOrUndefined, answers: options.answers, ...(previewBoot === undefined ? {} : { previewBoot }) };
      for (const rule of rules) findings.push(...(await rule.check(ctx)));

      const claimed = new Set(findings.map((f) => `${f.where.module ?? ""}|${f.where.pipeline ?? ""}|${f.where.step ?? ""}`));
      for (const problem of bootCheck.errors) {
        const key = `${problem.module ?? ""}|${problem.pipeline ?? ""}|${problem.step ?? ""}`;
        if (claimed.has(key) && key !== "||") continue;
        findings.push(bootErrorFinding(problem));
      }
      for (const item of bootCheck.notChecked) {
        findings.push({
          id: `boot/not-checked:${item.kind}:${item.name}`,
          rule: "boot/not-checked",
          severity: "warning",
          tier: "boot",
          where: item.kind === "module" ? { module: item.name } : { pipeline: item.name },
          message: `${item.kind} "${item.name}" was not checked: ${item.because}`,
          suggestion: outside.includes(item.name) ? `run with --run-setup ${item.name} to include it` : "see docs/upgrading.md",
          fix: { kind: "none" },
          docs: "docs/upgrading.md#not-checked",
        });
      }
    }

    const remapped = findings.map((f) => remapFinding(f, scratch.dir, root));
    const report: UpgradeReport = {
      schema: 1,
      tool: { name: "kestrel-upgrade", version: TOOL_VERSION },
      target: "6.0.0",
      project: { root, kind: project?.kind ?? "unknown", installed: versions.installed },
      tiers,
      summary: summarize(remapped),
      findings: remapped,
    };
    const boundPreviewBoot = previewBootRaw === undefined ? undefined : (edits: readonly Edit[]): Promise<BootPreview | undefined> => previewBootRaw(edits.map((e) => ({ ...e, file: resolve(scratch.dir, relative(root, e.file)) })));
    return { report, ...(boundPreviewBoot === undefined ? {} : { previewBoot: boundPreviewBoot }) };
  } finally {
    await removeScratchCopy(scratch);
  }
}

function printReport(report: UpgradeReport, args: ParsedArgs, stdout: (line: string) => void): void {
  if (boolFlag(args, "json")) stdout(JSON.stringify(report, null, 2));
  else stdout(renderHuman(report));
}

async function runCheck(args: ParsedArgs, stdout: (line: string) => void, options: RunUpgradeCliOptions): Promise<number> {
  const root = resolve(stringFlag(args, "root") ?? ".");
  const entry = stringFlag(args, "entry");
  const failOn = failOnOf(args);
  const runSetupUses = args.repeated.get("run-setup") ?? [];
  const dataReport = readDataReport(stringFlag(args, "data-report"));
  const { report } = await buildReport(root, entry, { runSetupUses, answers: new Map(), dataReport, forceMajor: options.forceInstalledMajor, plugins: options.plugins });
  const { rejectedIds } = verifyAndApply(report.findings);
  const findings = downgradeRejected(report.findings, rejectedIds);
  const verifiedReport: UpgradeReport = { ...report, findings, summary: summarize(findings) };
  printReport(verifiedReport, args, stdout);
  return exitCodeFor(verifiedReport.findings, failOn);
}

function isInsideGitTree(dir: string): boolean {
  for (let current = resolve(dir); ; ) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function isDirty(file: string, root: string): Promise<boolean | undefined> {
  try {
    const relFile = relative(root, file);
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--", relFile], { cwd: root });
    return stdout.trim() !== "";
  } catch {
    return isInsideGitTree(root) ? undefined : false;
  }
}

function verifiesAfterEdit(file: string, text: string): boolean {
  if (file.endsWith(".json")) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  try {
    return !hasArrayHole(parseTs(text));
  } catch {
    return false;
  }
}

interface FileState {
  source: string;
  current: string;
}

function verifyAndApply(findings: readonly Finding[]): { states: Map<string, FileState>; rejectedIds: Set<string> } {
  const sources = new Map<string, string>();
  const accepted = new Map<string, Edit[]>();
  const rejectedIds = new Set<string>();
  const sourceFor = (file: string): string | undefined => {
    const existing = sources.get(file);
    if (existing !== undefined) return existing;
    if (!existsSync(file)) return undefined;
    const source = readFileSync(file, "utf8");
    sources.set(file, source);
    return source;
  };
  for (const finding of findings) {
    if (finding.fix.kind !== "auto" || finding.fix.edits.length === 0) continue;
    const perFile = groupByFile(finding.fix.edits);
    let ok = true;
    for (const [file, edits] of perFile) {
      const source = sourceFor(file);
      if (source === undefined) {
        ok = false;
        break;
      }
      const { text } = applyEdits(source, [...(accepted.get(file) ?? []), ...edits]);
      if (!verifiesAfterEdit(file, text)) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      rejectedIds.add(finding.id);
      continue;
    }
    for (const [file, edits] of perFile) accepted.set(file, [...(accepted.get(file) ?? []), ...edits]);
  }
  const states = new Map<string, FileState>();
  for (const [file, source] of sources) {
    const { text } = applyEdits(source, accepted.get(file) ?? []);
    states.set(file, { source, current: text });
  }
  return { states, rejectedIds };
}

function downgradeRejected(findings: readonly Finding[], rejectedIds: ReadonlySet<string>): Finding[] {
  return findings.map((f) => (rejectedIds.has(f.id) ? { ...f, fix: { kind: "manual" as const }, suggestion: `${f.suggestion} (the edit did not verify after applying; do this by hand)` } : f));
}

interface AskLoopResult {
  report: UpgradeReport;
  answers: Map<string, string>;
  previewBoot?: (edits: readonly Edit[]) => Promise<BootPreview | undefined>;
}

async function resolveQuestions(root: string, entry: string | undefined, runSetupUses: readonly string[], dataReport: Record<string, unknown> | undefined, fromFile: ReadonlyMap<string, string> | undefined, yes: boolean, interactive: boolean, prompt: PromptFn, forceMajor: number | undefined, plugins: readonly UpgradePlugin[] | undefined): Promise<AskLoopResult & { unknownIds: string[] }> {
  const answers = new Map<string, string>();
  const everAsked = new Set<string>();
  let built: BuildResult | undefined;
  for (let round = 0; round < 8; round++) {
    built = await buildReport(root, entry, { runSetupUses, answers, dataReport, forceMajor, plugins });
    const asks = askFindings(built.report.findings);
    for (const { fix } of asks) everAsked.add(fix.question);
    const unresolved = asks.filter(({ fix }) => !answers.has(fix.question));
    if (unresolved.length === 0) break;
    let resolvedAny = false;
    for (const { finding, fix } of unresolved) {
      const value = await resolveAnswer(fix, finding.message, { fromFile, yes, interactive, prompt });
      if (value !== undefined) {
        answers.set(fix.question, value);
        resolvedAny = true;
      }
    }
    if (!resolvedAny) break;
  }
  const unknownIds = fromFile === undefined ? [] : unknownAnswerIds(fromFile, everAsked);
  return { report: built!.report, answers, ...(built!.previewBoot === undefined ? {} : { previewBoot: built!.previewBoot }), unknownIds };
}

async function confirmFile(file: string, root: string, before: string, after: string, prompt: PromptFn): Promise<boolean> {
  for (;;) {
    const answer = await prompt(`write "${relative(root, file)}"?`, ["y", "n", "d"], "y");
    if (answer === "d") {
      const diff = unifiedDiff(relative(root, file), before, after);
      await prompt(diff === "" ? "(no textual change)" : diff, [], "");
      continue;
    }
    return answer !== "n";
  }
}

async function runFix(args: ParsedArgs, stdout: (line: string) => void, stderr: (line: string) => void, options: RunUpgradeCliOptions): Promise<number> {
  const root = resolve(stringFlag(args, "root") ?? ".");
  const entry = stringFlag(args, "entry");
  const failOn = failOnOf(args);
  const write = boolFlag(args, "write");
  const allowDirty = boolFlag(args, "allow-dirty");
  const yes = boolFlag(args, "yes");
  const runSetupUses = args.repeated.get("run-setup") ?? [];
  const dataReport = readDataReport(stringFlag(args, "data-report"));
  const answersFile = stringFlag(args, "answers");
  const fromFile = answersFile === undefined ? undefined : parseAnswersFile(readFileSync(resolve(answersFile), "utf8"));
  const interactive = options.isInteractive ?? process.stdin.isTTY === true;
  const prompt = options.prompt ?? ttyPrompt;

  if (write && !interactive && !yes) {
    stderr("fix --write needs a TTY or --yes; nothing was written");
    return 2;
  }

  const { report, unknownIds, answers, previewBoot } = await resolveQuestions(root, entry, runSetupUses, dataReport, fromFile, yes, interactive, prompt, options.forceInstalledMajor, options.plugins);
  if (unknownIds.length > 0) {
    stderr(`--answers names an id this run never asked: ${unknownIds.join(", ")}`);
    return 2;
  }

  const { states, rejectedIds } = verifyAndApply(report.findings);
  const adjustedFindings = downgradeRejected(report.findings, rejectedIds);
  const adjustedReport: UpgradeReport = { ...report, findings: adjustedFindings, summary: summarize(adjustedFindings) };
  const changed = [...states].filter(([, state]) => state.current !== state.source);

  if (write && !allowDirty) {
    for (const [file] of changed) {
      const dirty = await isDirty(file, root);
      if (dirty === undefined) {
        stderr(`could not check "${relative(root, file)}" for uncommitted changes; pass --allow-dirty once you have confirmed it by hand`);
        return 2;
      }
      if (dirty) {
        stderr(`"${relative(root, file)}" has uncommitted changes; pass --allow-dirty or commit first`);
        return 2;
      }
    }
  }

  const saveAnswersFile = stringFlag(args, "save-answers");
  const applied: string[] = [];
  const skipConfirmation = yes || !interactive;
  for (const [file, state] of changed) {
    if (!write) {
      const diff = unifiedDiff(relative(root, file), state.source, state.current);
      if (diff !== "") stdout(diff);
      continue;
    }
    const proceed = skipConfirmation || (await confirmFile(file, root, state.source, state.current, prompt));
    if (!proceed) continue;
    writeFileSync(file, state.current);
    applied.push(relative(root, file));
  }

  if (write) {
    for (const file of applied) stdout(`wrote ${file}`);
    if (applied.length > 0) stdout("run `pnpm install` to pick up any dependency range changes");
  } else {
    printReport(adjustedReport, args, stdout);
    const isRawBootError = (f: Finding): boolean => f.rule.startsWith("boot/");
    const finalEdits = adjustedFindings.flatMap((f) => (f.fix.kind === "auto" ? f.fix.edits : []));
    const preview = previewBoot ? await previewBoot(finalEdits) : undefined;
    if (preview && preview.issues.length > 0) {
      const missingPackages = [...new Set(preview.issues.map((i) => i.use).filter((use): use is string => use !== undefined))];
      if (missingPackages.length > 0) {
        const plural = missingPackages.length > 1;
        stdout(`could not verify the boot result: ${missingPackages.join(", ")} ${plural ? "are" : "is"} added by these edits but not installed yet; install ${plural ? "them" : "it"}, then run \`fix\` again to verify`);
      }
      for (const issue of preview.issues.filter((i) => i.use === undefined)) {
        stdout(`could not verify the boot result: ${issue.file ?? "a file"} failed to load: ${issue.message}`);
      }
      for (const f of adjustedFindings.filter((f) => isRawBootError(f) && f.fix.kind !== "auto")) stdout(`  not verified: ${f.id}`);
    } else {
      const nonBootRemaining = adjustedFindings.filter((f) => f.fix.kind !== "auto" && !isRawBootError(f));
      if (preview) {
        const bootRemaining = preview.bootCheck.errors.map(bootErrorFinding);
        const afterEdits = summarize([...nonBootRemaining, ...bootRemaining]);
        const notChecked = preview.bootCheck.notChecked.length;
        const notCheckedSuffix = notChecked > 0 ? ` (${notChecked} not checked)` : "";
        stdout(`after these edits: ${afterEdits.error} errors remain (${afterEdits.ask} need your answer, ${afterEdits.manual} manual)${notCheckedSuffix}`);
      } else {
        stdout(
          previewBoot === undefined
            ? "could not verify the boot result: no boot check ran; upgrade @michaelthielemann/kestrel to 6 first, then run `fix` again to verify"
            : "could not verify the boot result: the edited copy could not be reloaded; run `fix` again to verify",
        );
        for (const f of adjustedFindings.filter((f) => isRawBootError(f) && f.fix.kind !== "auto")) stdout(`  not verified: ${f.id}`);
      }
    }
  }
  if (write && saveAnswersFile !== undefined) writeFileSync(resolve(saveAnswersFile), JSON.stringify(Object.fromEntries(answers), null, 2));
  return exitCodeFor(adjustedReport.findings, failOn);
}

async function runData(args: ParsedArgs, stdout: (line: string) => void, stderr: (line: string) => void): Promise<number> {
  const db = stringFlag(args, "db");
  if (db === undefined) {
    stderr("data requires --db <sqlite file>");
    return 2;
  }
  const root = resolve(stringFlag(args, "root") ?? ".");
  const result = await runDataStep(resolve(db), root);
  if (result.error !== undefined) {
    stderr(result.error);
    return result.exitCode;
  }
  if (result.report) {
    if (boolFlag(args, "json")) stdout(JSON.stringify(result.report, null, 2));
    else stdout(renderHuman(result.report));
    const out = stringFlag(args, "out");
    if (out !== undefined) writeFileSync(resolve(out), JSON.stringify(result.report, null, 2));
  }
  return result.exitCode;
}

export async function runCli(argv: readonly string[], options: RunUpgradeCliOptions): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  try {
    if (command === "check") return await runCheck(args, stdout, options);
    if (command === "fix") return await runFix(args, stdout, stderr, options);
    if (command === "data") return await runData(args, stdout, stderr);
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 2;
  }
  stderr(`unknown command "${command ?? ""}"; expected check, fix or data`);
  return 2;
}
