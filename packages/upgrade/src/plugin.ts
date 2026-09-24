import type { BootCheck, BootInput } from "@michaelthielemann/kestrel";
import type { Finding } from "./report.ts";
import { runCli } from "./cli-run.ts";

export type { Edit, Finding, FindingFix, FindingLocation, Severity, Tier, UpgradeReport } from "./report.ts";

/** A project a plugin knows how to find and load; the layer registers one of these for its own project shape. */
export interface LoadedProject {
  input: BootInput;
  kind: string;
  configFile: string;
  moduleFiles: ReadonlyMap<string, string>;
  pipelineFiles: ReadonlyMap<string, string>;
  data?: Record<string, unknown>;
}

export interface RuleContext {
  root: string;
  scratch: string;
  project: LoadedProject;
  bootCheck: BootCheck;
  readFile(file: string): string | undefined;
}

/** One 5.8 -> 6.0 rule: turns a loaded project (plus the boot check it produced) into findings. */
export interface Rule {
  id: string;
  check(ctx: RuleContext): readonly Finding[] | Promise<readonly Finding[]>;
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
  load(root: string, scratch: string): Promise<LoadedProject>;
  sandbox?: Record<string, (config: unknown, scratch: string) => unknown>;
  rules?: readonly Rule[];
  questions?: readonly Question[];
}

export interface RunUpgradeCliOptions {
  plugins?: readonly UpgradePlugin[];
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Runs the `check` / `fix` / `data` CLI against `argv`, returning the process exit code. A host bin (the layer's own) passes its plugin here instead of shipping a second copy of the engine. */
export function runUpgradeCli(argv: readonly string[], options: RunUpgradeCliOptions = {}): Promise<number> {
  return runCli(argv, options);
}
