import type { BootCheck, BootInput } from "@michaelthielemann/kestrel";
import type { PromptFn } from "./answers.ts";
import type { Edit, Finding } from "./report.ts";
import { runCli } from "./cli-run.ts";

export type { AskFix, Edit, Finding, FindingFix, FindingLocation, Severity, Tier, UpgradeReport } from "./report.ts";

/** A project a plugin knows how to find and load; the layer registers one of these for its own project shape. */
export interface LoadedProject {
  input: BootInput;
  kind: string;
  configFile: string;
  moduleFiles: ReadonlyMap<string, string>;
  pipelineFiles: ReadonlyMap<string, string>;
  data?: Record<string, unknown>;
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
  load(root: string, scratch: string): Promise<LoadResult>;
  sandbox?: Record<string, (config: unknown, scratch: string) => unknown>;
  rules?: readonly Rule[];
  questions?: readonly Question[];
  /** Package names this plugin owns the versioning of; built-in dependency rules (`deps/kestrel-range` and the mixed-majors check) never read or edit one of these, even under this repo's own npm scope. */
  ownsPackages?: readonly string[];
  /** Replaces or disables a built-in rule by id (`null` disables it); two plugins naming the same id is a load error. */
  overrides?: Record<string, Rule | null>;
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
