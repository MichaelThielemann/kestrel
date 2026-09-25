import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { checkBoot, type BootCheck, type BootProblem } from "@michaelthielemann/kestrel";
import { applyEdits } from "./apply.ts";
import { askFindings, invalidClosedAnswers, parseAnswersFile, resolveAnswer, staleAnswerIds, ttyPrompt, unknownAnswerIds, type PromptFn } from "./answers.ts";
import { boolFlag, parseArgs, stringFlag, type ParsedArgs } from "./args.ts";
import { unifiedDiff } from "./diff.ts";
import { runDataStep } from "./data.ts";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { ModelFieldsLocator, StepListLocator } from "./edits.ts";
import { isRecord } from "./guards.ts";
import { loadBackendProject, loadIssuesAsFindings, type LoadIssue, type LoadResult } from "./project.ts";
import type { AskFix, LoadedProject, MediaWiring, Rule, RuleContext, RunUpgradeCliOptions, SourceRuleContext, SwitchEditsResult, UpgradePlugin } from "./plugin.ts";
import { detectPlugin, mergeRules, mergeSandboxEntries } from "./pluginRules.ts";
import { renderHuman, summarize, whereOf, type Edit, type Finding, type Severity, type UpgradeReport } from "./report.ts";
import { DEFAULT_RULES, readFileOrUndefined } from "./rules.ts";
import { hookFailedFinding, ruleCheckFailedFinding, upgradingDocs, verifyEditsWith, type VerifyEditsResult } from "./ruleHelpers.ts";
import { sandboxBootInput, type SandboxTable } from "./sandbox.ts";
import { createScratchCopy, removeScratchCopy, type ScratchCopy } from "./scratch.ts";
import { verifiesAfterEdit } from "./verify.ts";
import { hostUpgradeCommand, installedVersions, majorOf, toolVersion } from "./versions.ts";

interface InternalRunOptions extends RunUpgradeCliOptions {
  forceInstalledMajor?: number;
}

/**
 * `RuleContext` plus a seam only a built-in rule reaches, never a plugin's own: `pluginKind` is the
 * active plugin's own `UpgradePlugin.kind` (absent without one), and `previewDetails` runs a preview
 * boot the same way `previewBoot` does but additionally returns the reloaded project's own active
 * module list and every load issue it reported, separately from a refused edit (see `BootPreview`) —
 * `offer/event-queue` uses both to confirm a switch actually took effect at the module-list level and
 * to name the real cause when it could not verify one. Exported for this package's own built-in rules
 * to import; `cli-run.ts` is not part of the package's published entry points, so this never reaches a
 * plugin author through `RuleContext`, which stays as published.
 */
export interface InternalRuleContext extends RuleContext {
  pluginKind?: string;
  previewDetails?: (edits: readonly Edit[]) => Promise<{ moduleUses?: readonly string[]; issues: readonly LoadIssue[]; failed?: LoadIssue } | undefined>;
  /** The active plugin's own `idempotentPipelines(project)` result, when it supplies the hook; `offer/event-queue` skips asking `idempotent:<pipeline>` for a name listed here. */
  vouchedIdempotentPipelines?: readonly string[];
  /** The active plugin's own `mediaWiring(project)` result, when it supplies the hook; `modules/delivery-media` uses it instead of its own heuristic. */
  hostMediaWiring?: MediaWiring;
}

interface ResolvedProject {
  project?: LoadedProject;
  issues: LoadIssue[];
  findings?: Finding[];
  rules: readonly Rule[];
  sandboxEntries?: SandboxTable;
  locateSteps?: StepListLocator;
  locateModelFields?: ModelFieldsLocator;
  switchEdits?: (ctx: RuleContext, relayPipelines: readonly string[]) => Promise<SwitchEditsResult>;
  idempotentPipelines?: readonly string[];
  mediaWiring?: MediaWiring;
  reload: (scratchDir: string) => Promise<LoadResult>;
}

async function withDerivedContentModel(project: LoadedProject | undefined, plugin: UpgradePlugin, root: string): Promise<{ project: LoadedProject | undefined; finding?: Finding }> {
  if (project === undefined || project.contentModel !== undefined || plugin.dataModel === undefined) return { project };
  try {
    const derived = await plugin.dataModel(root);
    return { project: derived === undefined ? project : { ...project, contentModel: derived } };
  } catch (err) {
    return { project, finding: hookFailedFinding(plugin.kind, "dataModel", err) };
  }
}

async function resolveProject(root: string, entry: string | undefined, scratchDir: string, plugin: UpgradePlugin | undefined, cache: Map<string, unknown>): Promise<ResolvedProject> {
  if (plugin === undefined) {
    const { project, issues } = await loadBackendProject(scratchDir, entry === undefined ? undefined : resolve(root, entry));
    const reload = (dir: string): Promise<LoadResult> => loadBackendProject(dir, entry === undefined ? undefined : resolve(root, entry));
    return { ...(project === undefined ? {} : { project }), issues, rules: DEFAULT_RULES, reload };
  }
  const { rules, issues: ruleIssues } = mergeRules(DEFAULT_RULES, plugin);
  const { entries, issues: sandboxIssues } = mergeSandboxEntries(plugin);
  const mergeIssues = [...ruleIssues, ...sandboxIssues];
  const sandboxEntries = entries === undefined ? {} : { sandboxEntries: entries };
  const switchEditsHook = plugin.switchEdits;
  const locators = {
    ...(plugin.locateSteps === undefined ? {} : { locateSteps: plugin.locateSteps }),
    ...(plugin.locateModelFields === undefined ? {} : { locateModelFields: plugin.locateModelFields }),
    ...(switchEditsHook === undefined ? {} : { switchEdits: (ctx: RuleContext, relayPipelines: readonly string[]): Promise<SwitchEditsResult> => switchEditsHook(ctx, relayPipelines) }),
  };
  const reload = async (dir: string): Promise<LoadResult> => {
    try {
      return await plugin.load(root, dir, cache);
    } catch (err) {
      return { issues: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  try {
    const { project: loaded, issues } = await plugin.load(root, scratchDir, cache);
    const { project, finding } = await withDerivedContentModel(loaded, plugin, root);
    const idempotentPipelines = project === undefined ? undefined : plugin.idempotentPipelines?.(project);
    const mediaWiring = project === undefined ? undefined : plugin.mediaWiring?.(project);
    return {
      ...(project === undefined ? {} : { project }),
      issues: [...mergeIssues, ...issues],
      findings: finding ? [finding] : [],
      rules,
      ...sandboxEntries,
      ...locators,
      ...(idempotentPipelines === undefined ? {} : { idempotentPipelines }),
      ...(mediaWiring === undefined ? {} : { mediaWiring }),
      reload,
    };
  } catch (err) {
    return { issues: [...mergeIssues, { message: err instanceof Error ? err.message : String(err) }], rules, ...sandboxEntries, ...locators, reload };
  }
}

const execFileAsync = promisify(execFile);
const TOOL_VERSION = toolVersion();

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function deepestExistingAncestor(path: string): string {
  let current = path;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function hasSymlinkBelow(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  let current = root;
  for (const part of rel.split(sep)) {
    if (part === "") continue;
    current = join(current, part);
    if (!existsSync(current)) return false;
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

type PathEscape = "outside" | "symlink";

function pathEscapeReason(candidate: string, root: string): PathEscape | undefined {
  if (!existsSync(root)) {
    const rel = relative(root, candidate);
    return rel.startsWith("..") || isAbsolute(rel) ? "outside" : undefined;
  }
  if (hasSymlinkBelow(candidate, root)) return "symlink";
  const rootReal = realpathOrSelf(root);
  const existingReal = realpathOrSelf(deepestExistingAncestor(candidate));
  const rel = relative(rootReal, existingReal);
  return rel.startsWith("..") || isAbsolute(rel) ? "outside" : undefined;
}

function escapeText(reason: PathEscape, copyLabel: string): string {
  return reason === "symlink" ? `reaches outside its own ${copyLabel} through a symlink` : `resolves outside its own ${copyLabel}`;
}

function stripTempDirs(raw: string, dirs: readonly (string | undefined)[]): string {
  let out = raw;
  for (const dir of dirs) {
    if (dir === undefined) continue;
    out = out.split(`${dir}${sep}`).join("").split(dir).join("");
  }
  return out;
}

function displayPath(file: string, root: string): string {
  const rel = relative(root, file);
  return rel.startsWith("..") || isAbsolute(rel) ? file : rel;
}

function remap(file: string, scratch: string, root: string): string {
  const rel = relative(scratch, file);
  return rel.startsWith("..") || isAbsolute(rel) ? file : resolve(root, rel);
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
  pluginCache?: Map<string, unknown>;
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
    docs: upgradingDocs("boot-code"),
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

function refusedEditFinding(issue: LoadIssue): Finding {
  return {
    id: `preview/edit-refused:${issue.file ?? issue.message}`,
    rule: "preview/edit-refused",
    severity: "warning",
    tier: "boot",
    where: whereOf({ file: issue.file }),
    message: issue.message,
    suggestion: "review the edit and the rule or plugin hook that produced it",
    fix: { kind: "none" },
    docs: upgradingDocs("preview-edit-refused"),
  };
}

function refusedEditFindings(issues: readonly LoadIssue[]): Finding[] {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const issue of issues) {
    const key = `${issue.file ?? ""}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(refusedEditFinding(issue));
  }
  return findings;
}

interface BootPreview {
  bootCheck: BootCheck;
  issues: LoadIssue[];
  refused?: LoadIssue;
  failed?: LoadIssue;
  moduleUses?: readonly string[];
}

interface BuildResult {
  report: UpgradeReport;
  previewBoot?: (edits: readonly Edit[]) => Promise<BootPreview | undefined>;
}

function withHostUpgradeCommand(findings: readonly Finding[], command: string): Finding[] {
  return findings.map((f) => (f.rule === "load/failed" ? { ...f, suggestion: `this project depends on "${command}", which already runs @michaelthielemann/kestrel-upgrade's own rules against it; run "${command}" instead of this standalone command` } : f));
}

function envForceMajor(): number | undefined {
  const raw = process.env.KESTREL_UPGRADE_FORCE_MAJOR;
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

async function buildReport(root: string, entry: string | undefined, options: BuildOptions): Promise<BuildResult> {
  const { plugin, issues: detectIssues } = await detectPlugin(options.plugins ?? [], root);
  const versions = installedVersions(root);
  const kestrelVersion = versions.installed["@michaelthielemann/kestrel"];
  const kestrelMajor = options.forceMajor ?? envForceMajor() ?? (kestrelVersion === undefined ? undefined : majorOf(kestrelVersion));
  const findings: Finding[] = [...loadIssuesAsFindings(detectIssues)];
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
        docs: upgradingDocs("deps-kestrel-range"),
      });
    }
    if (kestrelMajor !== undefined && kestrelMajor < 6) {
      findings.push({
        id: "deps/pre-install",
        rule: "deps/pre-install",
        severity: "info",
        tier: "source",
        where: {},
        message: "the 5.x packages are installed; this run sees the source tier only",
        suggestion: "install the 6.0.0 packages and run check again for the load and boot checks",
        fix: { kind: "none" },
        docs: upgradingDocs(),
      });
    }

    const pluginCache = options.pluginCache ?? new Map<string, unknown>();
    const { project, issues, findings: resolvedFindings, rules, sandboxEntries, locateSteps, locateModelFields, switchEdits, idempotentPipelines, mediaWiring, reload } = await resolveProject(root, entry, scratch.dir, plugin, pluginCache);
    const loadFindings = loadIssuesAsFindings(issues);
    const hostCommand = project === undefined && plugin === undefined ? hostUpgradeCommand(root) : undefined;
    findings.push(...(hostCommand === undefined ? loadFindings : withHostUpgradeCommand(loadFindings, hostCommand)), ...(resolvedFindings ?? []));

    const sourceCtx: SourceRuleContext = { root: scratch.dir, scratch: scratch.dir, readFile: readFileOrUndefined, answers: options.answers };
    for (const rule of rules) {
      if (rule.needs !== "source") continue;
      try {
        findings.push(...(await rule.check(sourceCtx)));
      } catch (err) {
        findings.push(ruleCheckFailedFinding(rule.id, err));
      }
    }

    let tiers: UpgradeReport["tiers"] = { source: project ? "done" : "failed", load: "not-run", boot: "not-run", data: "not-run" };
    let bootCheck: Awaited<ReturnType<typeof checkBoot>> = { errors: [], warnings: [], notChecked: [] };
    let outside: readonly string[] = [];
    let sandboxInfo: { rewritten: readonly string[]; consented: readonly string[]; outside: readonly string[] } | undefined;

    let previewBootRaw: ((edits: readonly Edit[]) => Promise<BootPreview | undefined>) | undefined;
    let previewBoot: ((edits: readonly Edit[]) => Promise<BootCheck | undefined>) | undefined;
    const previewRefusals: LoadIssue[] = [];
    const previewCache = new Map<string, Promise<BootPreview | undefined>>();
    const editsCacheKey = (edits: readonly Edit[]): string => JSON.stringify(edits.map((e) => [e.file, e.start, e.end, e.text, e.create === true]));

    if (project) {
      if (kestrelMajor === 6 && !versions.mixedMajors) {
        tiers = { ...tiers, load: "done" };
        const box = sandboxBootInput(project.input, { dir: scratch.dir, consent: options.runSetupUses, ...(sandboxEntries === undefined ? {} : { entries: sandboxEntries }) });
        outside = box.outside;
        sandboxInfo = { rewritten: box.rewritten, consented: box.consented, outside: box.outside };
        bootCheck = await checkBoot(box.input, { setup: box.setup });
        tiers = { ...tiers, boot: "done" };
        for (const key of box.unmatched) {
          findings.push({
            id: `sandbox/unmatched-entry:${key}`,
            rule: "sandbox/unmatched-entry",
            severity: "warning",
            tier: "boot",
            where: {},
            message: `plugin "${plugin?.kind ?? ""}"'s sandbox entry "${key}" matches no module-list entry, so it rewrites nothing`,
            suggestion: "key the entry by a module-list entry's full use string, without a ?/# suffix",
            fix: { kind: "manual" },
            docs: upgradingDocs("sandbox-unmatched-entry"),
          });
        }
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
            docs: upgradingDocs("sandbox-blobstore-standin"),
          });
        }

        const previewBootRawUncached = async (edits: readonly Edit[]): Promise<BootPreview | undefined> => {
          let preview: ScratchCopy | undefined;
          try {
            try {
              preview = await createScratchCopy(root);
              const grouped = groupByFile(edits);
              for (const [file, fileEdits] of grouped) {
                const fileEscape = pathEscapeReason(file, scratch.dir);
                if (fileEscape !== undefined) {
                  const issue: LoadIssue = { file, message: `an edit targeting "${displayPath(file, scratch.dir)}" ${escapeText(fileEscape, "scratch copy")}; refused, not applied to this preview` };
                  previewRefusals.push(issue);
                  return { bootCheck: { errors: [], warnings: [], notChecked: [] }, issues: [], refused: issue };
                }
                const target = resolve(preview.dir, relative(scratch.dir, file));
                const targetEscape = pathEscapeReason(target, preview.dir);
                if (targetEscape !== undefined) {
                  const issue: LoadIssue = { file, message: `an edit targeting "${displayPath(file, scratch.dir)}" maps to a preview location that ${escapeText(targetEscape, "preview copy")}; refused, not applied to this preview` };
                  previewRefusals.push(issue);
                  return { bootCheck: { errors: [], warnings: [], notChecked: [] }, issues: [], refused: issue };
                }
                const creating = fileEdits.some((e) => e.create === true);
                if (!existsSync(target) && !creating) continue;
                const targetSource = creating ? "" : readFileSync(target, "utf8");
                writeFileSync(target, applyEdits(targetSource, fileEdits).text);
              }
              const { project: reloadedProject, issues: reloadIssues } = await reload(preview.dir);
              if (!reloadedProject) {
                const detail = reloadIssues.map((i) => i.message).join("; ") || "no reason was given";
                return { bootCheck: { errors: [], warnings: [], notChecked: [] }, issues: [{ message: `the edited copy could not be reloaded: ${detail}` }] };
              }
              const previewSandbox = sandboxBootInput(reloadedProject.input, { dir: preview.dir, consent: options.runSetupUses, ...(sandboxEntries === undefined ? {} : { entries: sandboxEntries }) });
              const bootCheck = await checkBoot(previewSandbox.input, { setup: previewSandbox.setup });
              return { bootCheck, issues: reloadIssues, moduleUses: reloadedProject.input.config.modules.map((m) => m.use) };
            } catch (err) {
              const raw = err instanceof Error ? err.message : String(err);
              const message = stripTempDirs(raw, [preview?.dir, scratch.dir]);
              const issue: LoadIssue = { message: `the preview could not apply its edits or reload: ${message}` };
              return { bootCheck: { errors: [], warnings: [], notChecked: [] }, issues: [], failed: issue };
            }
          } finally {
            if (preview !== undefined) await removeScratchCopy(preview);
          }
        };
        previewBootRaw = (edits) => {
          const key = editsCacheKey(edits);
          const cached = previewCache.get(key);
          if (cached !== undefined) return cached;
          const promise = previewBootRawUncached(edits);
          previewCache.set(key, promise);
          return promise;
        };
        previewBoot = async (edits) => {
          const raw = await previewBootRaw!(edits);
          return raw === undefined || raw.issues.length > 0 || raw.refused !== undefined || raw.failed !== undefined ? undefined : raw.bootCheck;
        };
      }

      const projectWithData = options.dataReport === undefined ? project : { ...project, dataReport: options.dataReport };
      const boundPreviewBoot = previewBoot;
      const verifyEdits =
        boundPreviewBoot === undefined
          ? undefined
          : (edits: readonly Edit[], verifyOptions?: { pipelines?: readonly string[] }): Promise<VerifyEditsResult> => verifyEditsWith(boundPreviewBoot, bootCheck, edits, verifyOptions?.pipelines ?? []);
      const boundPreviewBootRaw = previewBootRaw;
      const previewDetails =
        boundPreviewBootRaw === undefined
          ? undefined
          : async (edits: readonly Edit[]): Promise<{ moduleUses?: readonly string[]; issues: readonly LoadIssue[]; failed?: LoadIssue } | undefined> => {
              const raw = await boundPreviewBootRaw(edits);
              if (raw === undefined) return undefined;
              const issues = raw.refused ? [raw.refused, ...raw.issues] : raw.issues;
              return { ...(raw.moduleUses === undefined ? {} : { moduleUses: raw.moduleUses }), issues, ...(raw.failed === undefined ? {} : { failed: raw.failed }) };
            };
      const ctx = {
        root: scratch.dir,
        scratch: scratch.dir,
        project: projectWithData,
        bootCheck,
        readFile: readFileOrUndefined,
        answers: options.answers,
        ...(locateSteps === undefined ? {} : { locateSteps }),
        ...(locateModelFields === undefined ? {} : { locateModelFields }),
        ...(switchEdits === undefined ? {} : { switchEdits }),
        ...(idempotentPipelines === undefined ? {} : { vouchedIdempotentPipelines: idempotentPipelines }),
        ...(mediaWiring === undefined ? {} : { hostMediaWiring: mediaWiring }),
        ...(previewBoot === undefined ? {} : { previewBoot }),
        ...(verifyEdits === undefined ? {} : { verifyEdits }),
        ...(previewDetails === undefined ? {} : { previewDetails }),
        ...(plugin === undefined ? {} : { pluginKind: plugin.kind }),
      };
      for (const rule of rules) {
        if (rule.needs === "source") continue;
        try {
          findings.push(...(await rule.check(ctx)));
        } catch (err) {
          findings.push(ruleCheckFailedFinding(rule.id, err));
        }
      }
      findings.push(...refusedEditFindings(previewRefusals));

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
          docs: upgradingDocs("not-checked"),
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
      ...(sandboxInfo === undefined ? {} : { sandbox: sandboxInfo }),
      summary: summarize(remapped),
      findings: remapped,
    };
    const boundPreviewBoot =
      previewBootRaw === undefined
        ? undefined
        : async (edits: readonly Edit[]): Promise<BootPreview | undefined> => {
            const mapped = edits.map((e) => ({ ...e, file: resolve(scratch.dir, relative(root, e.file)) }));
            const raw = await previewBootRaw(mapped);
            if (raw === undefined) return undefined;
            const remapIssue = (issue: LoadIssue): LoadIssue => (issue.file === undefined ? issue : { ...issue, file: remap(issue.file, scratch.dir, root) });
            return { ...raw, issues: raw.issues.map(remapIssue), ...(raw.refused === undefined ? {} : { refused: remapIssue(raw.refused) }) };
          };
    return { report, ...(boundPreviewBoot === undefined ? {} : { previewBoot: boundPreviewBoot }) };
  } finally {
    await removeScratchCopy(scratch);
  }
}

function printReport(report: UpgradeReport, args: ParsedArgs, stdout: (line: string) => void): void {
  if (boolFlag(args, "json")) stdout(JSON.stringify(report, null, 2));
  else stdout(renderHuman(report));
}

async function runCheck(args: ParsedArgs, stdout: (line: string) => void, options: InternalRunOptions): Promise<number> {
  const root = resolve(stringFlag(args, "root") ?? ".");
  const entry = stringFlag(args, "entry");
  const failOn = failOnOf(args);
  const runSetupUses = args.repeated.get("run-setup") ?? [];
  const dataReport = readDataReport(stringFlag(args, "data-report"));
  const { report } = await buildReport(root, entry, { runSetupUses, answers: new Map(), dataReport, forceMajor: options.forceInstalledMajor, plugins: options.plugins });
  const { rejectedIds, conflictsWith, pathExists, unsafeTargets } = verifyAndApply(report.findings, root);
  const findings = downgradeRejected(report.findings, rejectedIds, conflictsWith, pathExists, unsafeTargets);
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

interface FileState {
  source: string;
  current: string;
}

function isUnsafeWriteTarget(file: string, root: string): boolean {
  if (pathEscapeReason(file, root) !== undefined) return true;
  const rel = relative(root, file);
  return rel.split(sep).includes("node_modules");
}

function verifyAndApply(findings: readonly Finding[], root: string): { states: Map<string, FileState>; rejectedIds: Set<string>; conflictsWith: Map<string, string[]>; pathExists: Set<string>; unsafeTargets: Set<string> } {
  const sources = new Map<string, string>();
  const accepted = new Map<string, Edit[]>();
  const ownerOf = new Map<Edit, Finding>();
  for (const finding of findings) {
    if (finding.fix.kind !== "auto") continue;
    for (const edit of finding.fix.edits) ownerOf.set(edit, finding);
  }
  const rejectedIds = new Set<string>();
  const conflictsWith = new Map<string, string[]>();
  const pathExists = new Set<string>();
  const unsafeTargets = new Set<string>();
  const sourceFor = (file: string): string | undefined => {
    const existing = sources.get(file);
    if (existing !== undefined) return existing;
    if (!existsSync(file)) return undefined;
    const source = readFileSync(file, "utf8");
    sources.set(file, source);
    return source;
  };
  const ownersOfAccepted = (file: string, findingId: string): Set<string> => {
    const rules = new Set<string>();
    for (const e of accepted.get(file) ?? []) {
      const owner = ownerOf.get(e);
      if (owner !== undefined && owner.id !== findingId) rules.add(owner.rule);
    }
    return rules;
  };
  for (const finding of findings) {
    if (finding.fix.kind !== "auto" || finding.fix.edits.length === 0) continue;
    const perFile = groupByFile(finding.fix.edits);
    let ok = true;
    const conflictingRules = new Set<string>();
    let createdPathExists = false;
    let unsafeTarget = false;
    for (const [file, edits] of perFile) {
      if (isUnsafeWriteTarget(file, root)) {
        ok = false;
        unsafeTarget = true;
        break;
      }
      const creating = edits.some((e) => e.create === true);
      if (creating) {
        if (existsSync(file)) {
          ok = false;
          createdPathExists = true;
          break;
        }
        if (sources.has(file)) {
          ok = false;
          for (const rule of ownersOfAccepted(file, finding.id)) conflictingRules.add(rule);
          break;
        }
      }
      const source = creating ? "" : sourceFor(file);
      if (source === undefined) {
        ok = false;
        break;
      }
      const { text, applied, conflicted } = applyEdits(source, [...(accepted.get(file) ?? []), ...edits]);
      const unresolved = conflicted.filter((c) => !applied.some((a) => a.start <= c.start && a.end >= c.end));
      if (unresolved.length > 0) {
        ok = false;
        for (const edit of unresolved) {
          const owner = ownerOf.get(edit);
          if (owner !== undefined && owner.id !== finding.id) conflictingRules.add(owner.rule);
        }
        break;
      }
      if (!verifiesAfterEdit(file, text)) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      rejectedIds.add(finding.id);
      if (createdPathExists) pathExists.add(finding.id);
      if (unsafeTarget) unsafeTargets.add(finding.id);
      if (conflictingRules.size > 0) conflictsWith.set(finding.id, [...conflictingRules]);
      continue;
    }
    for (const [file, edits] of perFile) {
      if (edits.some((e) => e.create === true) && !sources.has(file)) sources.set(file, "");
      accepted.set(file, [...(accepted.get(file) ?? []), ...edits]);
    }
  }
  const states = new Map<string, FileState>();
  for (const [file, source] of sources) {
    const { text } = applyEdits(source, accepted.get(file) ?? []);
    states.set(file, { source, current: text });
  }
  return { states, rejectedIds, conflictsWith, pathExists, unsafeTargets };
}

function downgradeRejected(findings: readonly Finding[], rejectedIds: ReadonlySet<string>, conflictsWith: ReadonlyMap<string, string[]>, pathExists: ReadonlySet<string>, unsafeTargets: ReadonlySet<string>): Finding[] {
  return findings.map((f) => {
    if (!rejectedIds.has(f.id)) return f;
    const conflicting = conflictsWith.get(f.id);
    const reason = pathExists.has(f.id)
      ? "the file it would create already exists"
      : unsafeTargets.has(f.id)
        ? "its own edit targets a path inside node_modules or outside the project"
        : conflicting && conflicting.length > 0
          ? `conflicts with ${conflicting.join(", ")} on the same file span`
          : "the edit did not verify after applying";
    return { ...f, fix: { kind: "manual" as const }, suggestion: `${f.suggestion} (${reason}; do this by hand)` };
  });
}

interface AskLoopResult {
  report: UpgradeReport;
  answers: Map<string, string>;
  previewBoot?: (edits: readonly Edit[]) => Promise<BootPreview | undefined>;
}

async function resolveQuestions(root: string, entry: string | undefined, runSetupUses: readonly string[], dataReport: Record<string, unknown> | undefined, fromFile: ReadonlyMap<string, string> | undefined, yes: boolean, interactive: boolean, prompt: PromptFn, forceMajor: number | undefined, plugins: readonly UpgradePlugin[] | undefined): Promise<AskLoopResult & { unknownIds: string[]; staleIds: string[]; invalidAnswers: Array<{ id: string; value: string }> }> {
  const answers = new Map<string, string>();
  const everAsked = new Set<string>();
  const askedFixes = new Map<string, AskFix>();
  const pluginCache = new Map<string, unknown>();
  let built: BuildResult | undefined;
  for (let round = 0; round < 8; round++) {
    built = await buildReport(root, entry, { runSetupUses, answers, dataReport, forceMajor, plugins, pluginCache });
    const asks = askFindings(built.report.findings);
    for (const { fix } of asks) {
      everAsked.add(fix.question);
      askedFixes.set(fix.question, fix);
    }
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
  const staleIds = fromFile === undefined ? [] : staleAnswerIds(fromFile, everAsked);
  const invalidAnswers = fromFile === undefined ? [] : invalidClosedAnswers(fromFile, askedFixes);
  return { report: built!.report, answers, ...(built!.previewBoot === undefined ? {} : { previewBoot: built!.previewBoot }), unknownIds, staleIds, invalidAnswers };
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

async function runFix(args: ParsedArgs, stdout: (line: string) => void, stderr: (line: string) => void, options: InternalRunOptions): Promise<number> {
  const root = resolve(stringFlag(args, "root") ?? ".");
  const entry = stringFlag(args, "entry");
  const failOn = failOnOf(args);
  const write = boolFlag(args, "write");
  const allowDirty = boolFlag(args, "allow-dirty");
  const yes = boolFlag(args, "yes");
  const humanLine = boolFlag(args, "json") ? stderr : stdout;
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

  const { report, unknownIds, staleIds, invalidAnswers, answers, previewBoot } = await resolveQuestions(root, entry, runSetupUses, dataReport, fromFile, yes, interactive, prompt, options.forceInstalledMajor, options.plugins);
  if (invalidAnswers.length > 0) {
    for (const { id, value } of invalidAnswers) stderr(`--answers: "${id}" is "${value}", which is not one of its choices`);
    return 2;
  }
  if (unknownIds.length > 0) {
    stderr(`--answers names an id this run never asked: ${unknownIds.join(", ")}`);
    return 2;
  }
  for (const id of staleIds) humanLine(`--answers: "${id}" is not asked this run; ignored as a stale answer from an earlier pass`);

  const { states, rejectedIds, conflictsWith, pathExists, unsafeTargets } = verifyAndApply(report.findings, root);
  const adjustedFindings = downgradeRejected(report.findings, rejectedIds, conflictsWith, pathExists, unsafeTargets);
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
      if (diff !== "") humanLine(diff);
      continue;
    }
    const proceed = skipConfirmation || (await confirmFile(file, root, state.source, state.current, prompt));
    if (!proceed) continue;
    writeFileSync(file, state.current);
    applied.push(relative(root, file));
  }

  if (write) {
    for (const file of applied) humanLine(`wrote ${file}`);
    if (applied.length > 0) {
      humanLine("run `pnpm install` to pick up any dependency range changes, then run `check` again");
    } else if (changed.length > 0) {
      humanLine("wrote nothing: every write was declined");
    } else if (rejectedIds.size > 0) {
      humanLine("wrote nothing: every proposed edit failed to verify");
      for (const f of adjustedFindings) {
        if (rejectedIds.has(f.id)) humanLine(`  ${f.id}: ${f.suggestion}`);
      }
    } else {
      humanLine("wrote nothing: no finding had an edit to apply");
    }
    const writtenFiles = new Set(changed.filter(([file]) => applied.includes(relative(root, file))).map(([file]) => file));
    for (const f of adjustedFindings) {
      if (f.severity !== "warning" || f.fix.kind !== "auto") continue;
      if (!f.fix.edits.some((e) => writtenFiles.has(e.file))) continue;
      humanLine(`  ${f.message}: ${f.suggestion}`);
    }
  } else {
    const isRawBootError = (f: Finding): boolean => f.rule.startsWith("boot/");
    const finalEdits = adjustedFindings.flatMap((f) => (f.fix.kind === "auto" ? f.fix.edits : []));
    const preview = previewBoot ? await previewBoot(finalEdits) : undefined;
    const refusedFinding = preview?.refused ? refusedEditFinding(preview.refused) : undefined;
    if (refusedFinding !== undefined) {
      adjustedFindings.push(refusedFinding);
      adjustedReport.summary = summarize(adjustedFindings);
    }
    printReport(adjustedReport, args, stdout);
    if (refusedFinding !== undefined) {
      humanLine(`could not verify the boot result: ${refusedFinding.message}`);
      for (const f of adjustedFindings.filter((f) => isRawBootError(f) && f.fix.kind !== "auto")) humanLine(`  not verified: ${f.id}`);
    } else if (preview?.failed !== undefined) {
      humanLine(`could not verify the boot result: ${preview.failed.message}`);
      for (const f of adjustedFindings.filter((f) => isRawBootError(f) && f.fix.kind !== "auto")) humanLine(`  not verified: ${f.id}`);
    } else if (preview && preview.issues.length > 0) {
      const missingPackages = [...new Set(preview.issues.map((i) => i.use).filter((use): use is string => use !== undefined))];
      if (missingPackages.length > 0) {
        const plural = missingPackages.length > 1;
        humanLine(`could not verify the boot result: ${missingPackages.join(", ")} ${plural ? "are" : "is"} added by these edits but not installed yet; install ${plural ? "them" : "it"}, then run \`fix\` again to verify`);
      }
      for (const issue of preview.issues.filter((i) => i.use === undefined)) {
        humanLine(`could not verify the boot result: ${issue.file ?? "a file"} failed to load: ${issue.message}`);
      }
      for (const f of adjustedFindings.filter((f) => isRawBootError(f) && f.fix.kind !== "auto")) humanLine(`  not verified: ${f.id}`);
    } else {
      const nonBootRemaining = adjustedFindings.filter((f) => f.fix.kind !== "auto" && !isRawBootError(f));
      if (preview) {
        const bootRemaining = preview.bootCheck.errors.map(bootErrorFinding);
        const afterEdits = summarize([...nonBootRemaining, ...bootRemaining]);
        const notChecked = preview.bootCheck.notChecked.length;
        const notCheckedSuffix = notChecked > 0 ? ` (${notChecked} not checked)` : "";
        humanLine(`after these edits: ${afterEdits.error} errors remain (${afterEdits.ask} need your answer, ${afterEdits.manual} manual)${notCheckedSuffix}`);
      } else if (adjustedReport.tiers.source === "failed") {
        humanLine("could not verify the boot result: the project itself did not load; resolve the load failure above, then run `check` again once its own fix (a dependency range bump, say) is installed");
        for (const f of adjustedFindings.filter((f) => isRawBootError(f) && f.fix.kind !== "auto")) humanLine(`  not verified: ${f.id}`);
      } else {
        humanLine("could not verify the boot result: no boot check ran; upgrade @michaelthielemann/kestrel to 6 first, then run `fix` again to verify");
        for (const f of adjustedFindings.filter((f) => isRawBootError(f) && f.fix.kind !== "auto")) humanLine(`  not verified: ${f.id}`);
      }
    }
  }
  if (write && saveAnswersFile !== undefined) writeFileSync(resolve(saveAnswersFile), JSON.stringify(Object.fromEntries(answers), null, 2));
  return exitCodeFor(adjustedReport.findings, failOn);
}

async function runData(args: ParsedArgs, stdout: (line: string) => void, stderr: (line: string) => void, options: InternalRunOptions): Promise<number> {
  const db = stringFlag(args, "db");
  if (db === undefined) {
    stderr("data requires --db <sqlite file>");
    return 2;
  }
  const root = resolve(stringFlag(args, "root") ?? ".");
  const result = await runDataStep(resolve(db), root, options.plugins ?? []);
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

export async function runCli(argv: readonly string[], options: InternalRunOptions): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  try {
    if (command === "check") return await runCheck(args, stdout, options);
    if (command === "fix") return await runFix(args, stdout, stderr, options);
    if (command === "data") return await runData(args, stdout, stderr, options);
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 2;
  }
  stderr(`unknown command "${command ?? ""}"; expected check, fix or data`);
  return 2;
}
