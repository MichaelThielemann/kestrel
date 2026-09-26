import { dirname } from "node:path";
import type { BootCheck, BootInput, BootProblem } from "@michaelthielemann/kestrel";
import type { PromptFn } from "./answers.ts";
import type { ModelFieldsLocator, StepListLocator } from "./edits.ts";
import type { Edit, Finding } from "./report.ts";
import type { HostScan } from "./hosts.ts";
import { runCli } from "./cli-run.ts";
import { readFileOrUndefined } from "./rules.ts";

export type { AskFix, Edit, Finding, FindingFix, FindingLocation, Severity, Tier, UpgradeReport } from "./report.ts";
export type { ModelFieldsLocator, StepListLocator } from "./edits.ts";

export { PLUGIN_API_MIN, PLUGIN_API_VERSION } from "./apiVersion.ts";
export { parseArgs, stringFlag, type ParsedArgs } from "./args.ts";
export type { HostScan, LoadableHost, OutdatedHost, RefusedHost } from "./hosts.ts";

/** One file a plugin's own pipeline layout lives in, and the pipeline(s) it defines — more than one when a layout keeps several pipelines in one file; a rule that iterates every pipeline file reports at most once per entry. */
export interface PipelineFile {
  file: string;
  pipelines: readonly string[];
}

/**
 * A project a plugin knows how to find and load, in the project shape that plugin supports. Every
 * path here (`configFile`, `moduleFiles`' and `pipelineFiles`' entries) must sit inside the
 * `scratch` directory `load()` was given, since a rule's edits target these paths and a
 * boot preview maps them onto its own throwaway copy by their position relative to that same
 * `scratch` — a real-root path escaping that mapping is refused rather than written, even through a
 * symlink (see `previewBootRaw`'s own confinement check). `DataContentModel.file` is the one
 * documented exception: it is always a real-root path, since `dataModel(root)` only ever receives
 * that root.
 */
export interface LoadedProject {
  /** What `checkBoot()` needs to run against the project: its config, modules and pipelines, already loaded. */
  input: BootInput;
  /** The project shape this came from (e.g. a host framework's name), for a rule that only applies to one kind. */
  kind: string;
  /** The project's own `kestrel.config.ts` (or equivalent), inside the `scratch` directory `load()` was given. */
  configFile: string;
  /** Every loaded module's file, keyed by its `use` string. */
  moduleFiles: ReadonlyMap<string, string>;
  /** Every file the project's pipelines live in. */
  pipelineFiles: readonly PipelineFile[];
  /** A plugin's own project-specific data, in whatever shape it likes; `check`/`fix` never reads or writes this. */
  data?: Record<string, unknown>;
  /** `--data-report`'s parsed content, kept separate from `data` so a `check`/`fix` run never overwrites what a plugin's own `load()` stored there. `model/underscore-field` reads its counts from here. */
  dataReport?: Record<string, unknown>;
  /** The content model `model/underscore-field` reads directly when present, for a project layout where it does not sit at a `content-default` module's config on `kestrel.config.ts`; the built-in loader leaves this undefined and the rule falls back to that search. `check`/`fix` derives this from `UpgradePlugin.dataModel` when a plugin supplies that hook but not this field directly, so a plugin need only implement one of the two. */
  contentModel?: DataContentModel;
}

/** One file or module a plugin's `load()` (or the built-in loader) could not load; surfaces as a `load/failed` finding. */
export interface LoadIssue {
  file?: string;
  use?: string;
  message: string;
}

/** `load()`'s result: a project loaded file by file, one bad file becoming an issue without stopping the rest; `project` is absent only when the config file itself could not load. */
export interface LoadResult {
  project?: LoadedProject;
  issues: LoadIssue[];
}

/** One content field the `data` command's underscore-field counter reads, whether it starts with `_` or not; `localized` decides whether it counts one column or one per locale. */
export interface DataContentField {
  localized?: boolean;
}

/** One content type the `data` command's underscore-field counter reads; `fields` in the shape stored in `persistence@1`, one column (or one per locale) per field. */
export interface DataContentType {
  fields: Record<string, DataContentField>;
}

/** The content model the `data` command's underscore-field counter needs: every type's fields and whether each is localized, plus the project's locales. */
export interface DataContentModel {
  types: Record<string, DataContentType>;
  locales?: readonly string[];
  /** The identifier `RuleContext.locateModelFields` receives as `use` when `model/underscore-field` renames a field here, for a project with no `kestrel.config.ts` module-list entry to name instead. */
  use?: string;
  /**
   * The file `model/underscore-field` reads and writes a rename edit into, for a project whose
   * content model does not sit in `LoadedProject.configFile`; that file is used when this is absent.
   * An absolute path under the project's real root — `dataModel(root)` only ever receives that root,
   * never the scratch copy `check`/`fix` runs rules against, so this is never a scratch path and is
   * never remapped; it reaches the final report exactly as given.
   */
  file?: string;
}

/**
 * A project's own media wiring, as its host layer knows it — `modules/delivery-media` uses these
 * values directly when `UpgradePlugin.mediaWiring` supplies them, instead of deriving a value it
 * cannot always get right on its own.
 */
export interface MediaWiring {
  /** The path media and image variants are served from (media-default's and images-default's own `publicPath`), commonly `/media`. */
  publicPath: string;
  /** The prefix `publicCopy` writes ready files under, on both media-default and images-default. */
  copyPrefix: string;
  /** delivery-static's own `reservedPaths`, including `publicPath` and every other mount the project reserves for itself (its API, its admin UI). */
  reservedPaths: readonly string[];
}

/** `offer/event-queue`'s switch for a project layout `UpgradePlugin.switchEdits` supplies. */
export interface SwitchEditsResult {
  /** All-or-nothing edit parts for the switch, one label per file or step the project's own layout needs touched; `offer/event-queue` combines them the same way it combines the built-in kestrel.config.ts-shaped switch's own parts — a part that could not be located is `undefined`, making the whole switch manual and naming every missing label. */
  parts: Record<string, Edit[] | undefined>;
  /** Deployment markers making the queue's own long-running worker unsafe here (a build setting that deploys the server as short-lived functions, a serverless platform's own config file, …); non-empty keeps the offer's gate unmet, the same way the built-in check does for a CLI/server backend project. */
  blockers: readonly string[];
}

/**
 * The context a `needs: "source"` rule gets: a project the loader could not load (a plugin's `load()`
 * returned no project, or the config threw on the installed code) still has a `root`, files to
 * `readFile`, and answers already known, so a rule scoped to that alone — `deps/kestrel-range`
 * bumping a dependency range in `package.json`, say — still runs and still offers its fix. `root` is
 * the same scratch-relative root `RuleContext.root` is; there is no loaded project, boot check or
 * preview here, so this type has none of them, rather than leaving them present but always
 * `undefined`.
 */
export interface SourceRuleContext {
  root: string;
  scratch: string;
  readFile(file: string): string | undefined;
  answers: ReadonlyMap<string, string>;
}

export interface RuleContext {
  root: string;
  scratch: string;
  project: LoadedProject;
  bootCheck: BootCheck;
  readFile(file: string): string | undefined;
  /** Answers already known for this run (from `--answers`, a TTY prompt, or a `--yes` default), so a rule whose question only makes sense after another one's answer can look it up. */
  answers: ReadonlyMap<string, string>;
  /** The active plugin's own step-list locator, when it supplies one; a rule that edits a pipeline's step list (like `pipelines/verified-user`) passes it through to `insertPipelineStep`. */
  locateSteps?: StepListLocator;
  /** The active plugin's own content-model locator, when it supplies one; `model/underscore-field` passes it through to `renameContentField`. */
  locateModelFields?: ModelFieldsLocator;
  /** The active plugin's own queue-offer switch, when it supplies one; `offer/event-queue` calls it instead of its own kestrel.config.ts-shaped switch and deployment-marker check. */
  switchEdits?: (ctx: RuleContext, relayPipelines: readonly string[]) => Promise<SwitchEditsResult>;
  /**
   * The low-level form: applies the given edits to a scratch copy of the affected files, reloads the
   * project and runs `checkBoot()` on it, then restores the copy — a rule uses this to verify an edit
   * it is about to offer before offering it. `undefined` when the boot tier is not available in this
   * run. `verifyEdits` is the diffed, higher-level form built on top of this.
   */
  previewBoot?: (edits: readonly Edit[]) => Promise<BootCheck | undefined>;
  /**
   * Runs `previewBoot(edits)` and diffs its boot check against this run's own baseline, then folds in
   * whether every pipeline named in `pipelines` was actually checked: `verified` is true only when the
   * preview booted and none of them is in the result's `notChecked`. `unchecked` names the ones that
   * were not, each with its own `notChecked` reason, so a caller unable to trust a clean diff here can
   * say why — empty, not one entry per named pipeline, when the preview did not run at all (no boot
   * tier, or the reload itself failing), which carries no such reason. `undefined` under the same
   * conditions `previewBoot` is.
   */
  verifyEdits?: (edits: readonly Edit[], options?: { pipelines?: readonly string[] }) => Promise<{ verified: boolean; newErrors: readonly BootProblem[]; unchecked: readonly { name: string; because: string }[] }>;
}

/**
 * Builds the `RuleContext` a rule's `check()` receives, for testing a plugin's rule without running
 * the CLI. `root` and `scratch` default to the directory of `project.configFile`, `bootCheck` to a
 * check with no problems, `readFile` to reading the file from disk (`undefined` when it cannot be
 * read) and `answers` to none; the optional members stay absent. `overrides` replaces any of them.
 * A member `RuleContext` gains gets its default here, so a test built on this keeps compiling.
 */
export function createRuleContext(project: LoadedProject, overrides: Partial<Omit<RuleContext, "project">> = {}): RuleContext {
  const root = dirname(project.configFile);
  return { root, scratch: root, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers: new Map(), ...overrides, project };
}

/** A rule needing the loaded project, its boot check, or a preview — the default when `needs` is absent. */
export interface ProjectRule {
  id: string;
  needs?: "project";
  /** Turns the loaded project, its boot check and any prior answers into this round's findings for this rule. */
  check(ctx: RuleContext): readonly Finding[] | Promise<readonly Finding[]>;
}

/**
 * A rule needing only `SourceRuleContext` — never a loaded project, boot check or preview — so it
 * runs whether or not the project loaded this round, and still offers its fix when nothing else can.
 * The built-in `deps/kestrel-range` is one; a plugin's own rule declares this the same way.
 */
export interface SourceRule {
  id: string;
  needs: "source";
  /** Turns the project's root, its files and any prior answers into this round's findings for this rule. */
  check(ctx: SourceRuleContext): readonly Finding[] | Promise<readonly Finding[]>;
}

/**
 * One 5.8 -> 6.0 rule: turns a loaded project (plus the boot check it produced) into findings, or —
 * `needs: "source"` — just the root and its files. `RuleContext` is assignable to every variant's own
 * context (`SourceRuleContext` today), since each is the subset of `RuleContext` that `needs` value
 * actually requires; a later `needs` value's own, narrower context stays additive the same way,
 * never a breaking change to `RuleContext` itself. An answer to one of this rule's `ask` questions
 * reaches it only through `ctx.answers` on the next `check()` call — there is no separate
 * answer-to-edit path.
 */
export type Rule = ProjectRule | SourceRule;

export interface UpgradePlugin {
  /** Identifies this plugin's project shape (e.g. a host framework's name), reported as `LoadedProject.kind`. */
  kind: string;
  /** True when `root` is a project this plugin knows how to load; the engine tries each registered plugin in turn. */
  detect(root: string): boolean | Promise<boolean>;
  /**
   * Loads the project at `root` into `scratch`, a fresh, uniquely-named directory this call alone
   * ever sees — `check`/`fix` calls `load()` again, with a new `scratch`, for every re-ask round and
   * every edit preview, and a host processing several projects in one process calls it again for
   * each `root`. If `load()` uses its own module loader with a cache keyed by a fixed path (one that
   * does not vary with `scratch`, such as a bundled fallback file), that cache must be fresh per call
   * or disabled — otherwise a later call can silently answer from an earlier project's or an earlier
   * preview's cached module instead of the current files.
   *
   * `cache` is one plain `Map`, shared by every `load()` call for this one `check`/`fix` invocation
   * only (never across two different projects, or two separate CLI invocations) — a plugin whose own
   * loading involves an expensive, root-only step (running a build tool's own "prepare" step, say)
   * can stash its result there under a key of its own choosing and skip repeating it for a later
   * re-ask round's or a later edit preview's `scratch` copy of the same project. A cached value must
   * be path-independent (a parsed config object, a computed flag), or the plugin must rebase it onto
   * the current `scratch` itself before using it — a cached absolute path or file handle from an
   * earlier `scratch` silently points at a directory this call already removed.
   */
  load(root: string, scratch: string, cache: Map<string, unknown>): Promise<LoadResult>;
  /**
   * Sandbox config rewrites added to the built-in table, keyed by a module-list entry's full `use`
   * string without a `?`/`#` suffix (`"@acme/kestrel-archive"`, `"./modules/archive.ts"`). A key the
   * built-in table already rewrites is a load error naming the plugin and the key, and the built-in
   * rewrite stays in force; a key that matches no module-list entry is a `sandbox/unmatched-entry`
   * warning.
   */
  sandbox?: Record<string, (config: unknown, scratch: string) => unknown>;
  /** Additional rules this plugin contributes, run alongside the built-in ones. */
  rules?: readonly Rule[];
  /** Locates a pipeline's own step array(s) directly, for a project layout where a pipeline is not a `definePipeline({ name, steps })` call; the built-in search runs when this is absent. */
  locateSteps?: StepListLocator;
  /** Locates a content type's `fields` object literal directly, for a project layout where it does not sit at `config.types.<typeName>.fields` on a module-list entry; the built-in search runs when this is absent. */
  locateModelFields?: ModelFieldsLocator;
  /**
   * Supplies the content model the `data` command's underscore-field counter needs, for a project
   * layout where it cannot be read from a `content-default` module's config on `kestrel.config.ts`.
   * `undefined` (the hook itself, or its result) skips underscore-field counting for this project
   * without failing the rest of the `data` command, which stays SQLite-only either way. `check`/`fix`
   * also calls this to fill in `LoadedProject.contentModel` when `load()` did not set it directly, so
   * `model/underscore-field` sees the same model without the plugin declaring it twice.
   */
  dataModel?(root: string): Promise<DataContentModel | undefined>;
  /**
   * Supplies `offer/event-queue`'s switch for a project layout where events-direct is not a
   * `kestrel.config.ts` module-list entry: the edits that replace it with events-queue (as
   * all-or-nothing parts) and any deployment markers that forbid the switch outright. The built-in
   * rule keeps every gate (an open event-payload or emits finding, a boot preview, no default when
   * unverified) and only asks this hook for the edits and the extra markers — a plugin never has to
   * replace `offer/event-queue` itself. The built-in kestrel.config.ts-shaped switch runs when this
   * is absent.
   */
  switchEdits?: (ctx: RuleContext, relayPipelines: readonly string[]) => Promise<SwitchEditsResult>;
  /**
   * Names pipelines this plugin already knows are safe to run more than once for the same event —
   * its own preset's, say, already documented and audited for idempotency, and offering a
   * `switch-to-queue` question the project's own owner cannot judge. `offer/event-queue` asks its own
   * `idempotent:<pipeline>` question, gating the switch on a "yes", for every consumer event pipeline
   * except the ones named here, which it treats as already answered "yes" without needing one in
   * `--answers`. Absent, every consumer event pipeline is asked about, unchanged.
   */
  idempotentPipelines?(project: LoadedProject): readonly string[];
  /**
   * Supplies the project's own media wiring, for a project layout where `modules/delivery-media`
   * cannot always derive a safe value on its own — an old `media.publicPath` under a path the project
   * reserves for its own API or admin UI, say, where the rule cannot see what the project's real
   * mounts are. When supplied, the rule uses these values directly and offers an auto edit, one
   * finding per module entry, instead of falling back to manual advice; absent, or `undefined` for a
   * given project, it keeps its own existing behavior.
   */
  mediaWiring?(project: LoadedProject): MediaWiring | undefined;
  /**
   * The checks a host's own server start runs beyond `boot()`, given the loaded project and its
   * boot check. `kestrel check` reports what this returns next to the boot problems; the upgrade
   * commands do not call it.
   */
  hostChecks?(project: LoadedProject, bootCheck: BootCheck): readonly HostProblem[] | Promise<readonly HostProblem[]>;
}

/** What the running kestrel CLI passes to a plugin factory. */
export interface KestrelPluginHost {
  /** The running engine's `PLUGIN_API_VERSION`; compare this, not the value imported from the plugin's own copy of this package. */
  pluginApiVersion: number;
  /** The running kestrel-cli version. */
  cliVersion: string;
}

/** One problem a host's own boot finds beyond `boot()`. */
export interface HostProblem {
  code: string;
  severity: "error" | "warning";
  owner: string;
  reason: string;
  pipeline?: string;
  module?: string;
  file?: string;
}

/** The default export of the module a host package's `kestrel.plugin` field names. */
export type KestrelPluginFactory = (host: KestrelPluginHost) => UpgradePlugin | Promise<UpgradePlugin>;

export interface RunUpgradeCliOptions {
  plugins?: readonly UpgradePlugin[];
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Overrides TTY detection (`process.stdin.isTTY`), for a host that knows better or a test. */
  isInteractive?: boolean;
  /** Overrides the real `node:readline` prompt, for a host with its own UI or a test. */
  prompt?: PromptFn;
  /** Host packages already classified by the caller; the engine classifies the project's direct dependencies itself when this is absent. */
  hosts?: HostScan;
}

/** Runs the `check` / `fix` / `data` commands against `argv`, returning the process exit code. A caller passes the plugins; the kestrel CLI discovers them from the `kestrel` field of the project's direct dependencies. */
export function runUpgradeCli(argv: readonly string[], options: RunUpgradeCliOptions = {}): Promise<number> {
  return runCli(argv, options);
}
