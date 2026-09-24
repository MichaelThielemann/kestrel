import type { BootCheck, BootInput } from "@michaelthielemann/kestrel";
import type { PromptFn } from "./answers.ts";
import type { ModelFieldsLocator, StepListLocator } from "./edits.ts";
import type { Edit, Finding } from "./report.ts";
import { runCli } from "./cli-run.ts";

export type { AskFix, Edit, Finding, FindingFix, FindingLocation, Severity, Tier, UpgradeReport } from "./report.ts";
export type { ModelFieldsLocator, StepListLocator } from "./edits.ts";

/** A project a plugin knows how to find and load; the layer registers one of these for its own project shape. */
export interface LoadedProject {
  input: BootInput;
  kind: string;
  configFile: string;
  moduleFiles: ReadonlyMap<string, string>;
  pipelineFiles: ReadonlyMap<string, string>;
  /** A plugin's own project-specific data, in whatever shape it likes; `check`/`fix` never reads or writes this. */
  data?: Record<string, unknown>;
  /** `--data-report`'s parsed content, kept separate from `data` so a `check`/`fix` run never overwrites what a plugin's own `load()` stored there. `model/underscore-field` reads its counts from here. */
  dataReport?: Record<string, unknown>;
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
}

export interface RuleContext {
  root: string;
  scratch: string;
  project: LoadedProject;
  bootCheck: BootCheck;
  readFile(file: string): string | undefined;
  /** Answers already known for this run (from `--answers`, a TTY prompt, or a `--yes` default), so a rule whose question only makes sense after another one's answer can look it up. */
  answers: ReadonlyMap<string, string>;
  /** The active plugin's own `ownsPackages`, empty when none is active; built-in dependency rules never read or edit one of these. */
  ownsPackages: readonly string[];
  /** The active plugin's own step-list locator, when it supplies one; a rule that edits a pipeline's step list (like `pipelines/verified-user`) passes it through to `insertPipelineStep`. */
  locateSteps?: StepListLocator;
  /** The active plugin's own content-model locator, when it supplies one; `model/underscore-field` passes it through to `renameContentField`. */
  locateModelFields?: ModelFieldsLocator;
  /**
   * Applies the given edits to a scratch copy of the affected files, reloads the project and runs
   * `checkBoot()` on it, then restores the copy — a rule uses this to verify an edit it is about to
   * offer before offering it. `undefined` when the boot tier is not available in this run.
   */
  previewBoot?(edits: readonly Edit[]): Promise<BootCheck | undefined>;
}

/** One 5.8 -> 6.0 rule: turns a loaded project (plus the boot check it produced) into findings. */
export interface Rule {
  id: string;
  check(ctx: RuleContext): readonly Finding[] | Promise<readonly Finding[]>;
  /** Turns a chosen answer to one of this rule's `ask` questions into edits; `undefined` when the answer needs no edit or the id is not this rule's. */
  applyAnswer?(questionId: string, value: string, ctx: RuleContext): Edit[] | undefined;
}

export interface Question {
  id: string;
  prompt: string;
  choices?: readonly string[];
  defaultValue?: string;
}

export interface UpgradePlugin {
  kind: string;
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
   * re-ask round's or a later edit preview's `scratch` copy of the same project.
   */
  load(root: string, scratch: string, cache: Map<string, unknown>): Promise<LoadResult>;
  sandbox?: Record<string, (config: unknown, scratch: string) => unknown>;
  rules?: readonly Rule[];
  questions?: readonly Question[];
  /** Package names this plugin owns the versioning of; built-in dependency rules (`deps/kestrel-range` and the mixed-majors check) never read or edit one of these, even under this repo's own npm scope. */
  ownsPackages?: readonly string[];
  /** Replaces or disables a built-in rule by id (`null` disables it); two plugins naming the same id is a load error. */
  overrides?: Record<string, Rule | null>;
  /** Locates a pipeline's own step array(s) directly, for a project layout where a pipeline is not a `definePipeline({ name, steps })` call; the built-in search runs when this is absent. */
  locateSteps?: StepListLocator;
  /** Locates a content type's `fields` object literal directly, for a project layout where it does not sit at `config.types.<typeName>.fields` on a module-list entry; the built-in search runs when this is absent. */
  locateModelFields?: ModelFieldsLocator;
  /**
   * Supplies the content model the `data` command's underscore-field counter needs, for a project
   * layout where it cannot be read from a `content-default` module's config on `kestrel.config.ts`.
   * `undefined` (the hook itself, or its result) skips underscore-field counting for this project
   * without failing the rest of the `data` command, which stays SQLite-only either way.
   */
  dataModel?(root: string): Promise<DataContentModel | undefined>;
}

export interface RunUpgradeCliOptions {
  plugins?: readonly UpgradePlugin[];
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Overrides TTY detection (`process.stdin.isTTY`), for a host that knows better or a test. */
  isInteractive?: boolean;
  /** Overrides the real `node:readline` prompt, for a host with its own UI or a test. */
  prompt?: PromptFn;
  /**
   * Overrides the installed `@michaelthielemann/kestrel` major the load/boot tier gate reads, for a
   * test running against a project whose own packages are not yet labelled 6.0.0. The report's
   * `project.installed` field still shows what is actually on disk.
   */
  forceInstalledMajor?: number;
}

/** Runs the `check` / `fix` / `data` CLI against `argv`, returning the process exit code. A host bin (the layer's own) passes its plugin here instead of shipping a second copy of the engine. */
export function runUpgradeCli(argv: readonly string[], options: RunUpgradeCliOptions = {}): Promise<number> {
  return runCli(argv, options);
}
