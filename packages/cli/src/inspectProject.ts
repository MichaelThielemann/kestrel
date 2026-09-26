import { existsSync, readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { resolve } from "node:path";
import type { BootCheck } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { loadHostPlugins, PLUGIN_API_VERSION, refusalMessage, scanHosts, selectHostPlugin, type LoadedHost, type OutdatedHost } from "@michaelthielemann/kestrel-upgrade/hosts";
import type { HostProblem, LoadedProject, LoadIssue } from "@michaelthielemann/kestrel-upgrade/plugin";
import { loadBackendProject } from "@michaelthielemann/kestrel-upgrade/project";
import { mergeSandboxEntries, sandboxBootInput, type SandboxResult } from "@michaelthielemann/kestrel-upgrade/sandbox";
import { createScratchCopy, removeScratchCopy } from "@michaelthielemann/kestrel-upgrade/scratch";
import { importProjectCore, isProjectLoad, projectCoreUrl, type ProjectCore } from "./projectCore.ts";
import { cliVersion } from "./usage.ts";

export interface ProjectOptions {
  root: string;
  runSetup: readonly string[];
  noPlugins: boolean;
}

export interface PluginInfo {
  package: string;
  version: string;
  kind: string;
}

/** A project loaded into its scratch copy, with the process cwd set to that copy. */
export interface PreparedProject {
  root: string;
  scratchDir: string;
  core: ProjectCore;
  coreVersion: string;
  kind: string;
  installed: Record<string, string>;
  plugins: PluginInfo[];
  plugin?: LoadedHost;
  project?: LoadedProject;
  issues: LoadIssue[];
  box?: SandboxResult;
}

export type PrepareFailure = { ok: false; kind: "refused"; message: string } | { ok: false; kind: "outdated"; outdated: OutdatedHost[]; root: string; installed: Record<string, string> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The installed version of every `@michaelthielemann/kestrel*` package the project's package.json names. */
export function installedKestrelVersions(root: string): Record<string, string> {
  const rootPkgFile = resolve(root, "package.json");
  const pkg = readJson(rootPkgFile);
  const installed: Record<string, string> = {};
  if (!isRecord(pkg)) return installed;
  for (const block of [pkg.dependencies, pkg.devDependencies]) {
    if (!isRecord(block)) continue;
    for (const name of Object.keys(block)) {
      if (!name.startsWith("@michaelthielemann/kestrel")) continue;
      try {
        const file = findPackageJSON(name, rootPkgFile);
        const dep = file === undefined ? undefined : readJson(file);
        if (isRecord(dep) && typeof dep.version === "string") installed[name] = dep.version;
      } catch {
        continue;
      }
    }
  }
  return installed;
}

/** Replaces the scratch directory in every string of `value` with the project root. */
export function remapPaths<T>(value: T, scratchDir: string, root: string): T {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return item.split(scratchDir).join(root);
    if (Array.isArray(item)) return item.map(walk);
    if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    return item;
  };
  return boundaryCast<T>(walk(value), "json");
}

async function choosePlugin(root: string, noPlugins: boolean): Promise<{ ok: true; plugin?: LoadedHost } | PrepareFailure> {
  if (noPlugins) return { ok: true };
  const cli = cliVersion();
  const scan = scanHosts(root, { cliVersion: cli });
  if (scan.refused.length > 0) return { ok: false, kind: "refused", message: scan.refused.map(refusalMessage).join("\n") };
  if (scan.outdated.length > 0) return { ok: false, kind: "outdated", outdated: scan.outdated, root, installed: installedKestrelVersions(root) };
  const { loaded, refused } = await loadHostPlugins(scan.loadable, { pluginApiVersion: PLUGIN_API_VERSION, cliVersion: cli });
  if (refused.length > 0) return { ok: false, kind: "refused", message: refused.map(refusalMessage).join("\n") };
  const selection = await selectHostPlugin(loaded, root);
  if (!selection.ok) return { ok: false, kind: "refused", message: selection.message };
  return selection.active === undefined ? { ok: true } : { ok: true, plugin: selection.active };
}

/**
 * Loads the project at `options.root` into a scratch copy that is also the process cwd while `body`
 * runs, through the detecting host plugin or the built-in backend loader with the project's own
 * core, and sandboxes its boot input. The cwd is restored and the copy removed afterwards.
 */
export async function withProject<T>(options: ProjectOptions, body: (prepared: PreparedProject) => Promise<T>): Promise<{ ok: true; value: T } | PrepareFailure> {
  const root = resolve(options.root);
  const resolved = await importProjectCore(root);
  if (!resolved.ok) return { ok: false, kind: "refused", message: resolved.message };
  const chosen = await choosePlugin(root, options.noPlugins);
  if (!chosen.ok) return chosen;
  const plugin = chosen.plugin;
  if (plugin === undefined && !existsSync(resolve(root, "kestrel.config.ts"))) {
    return { ok: false, kind: "refused", message: `${root} has no kestrel.config.ts, and no host package's plugin detects it` };
  }
  const loadModule: unknown = plugin === undefined ? await import(projectCoreUrl(root, "/load")) : undefined;
  const scratch = await createScratchCopy(root);
  const previousCwd = process.cwd();
  process.chdir(scratch.dir);
  try {
    const issues: LoadIssue[] = [];
    let project: LoadedProject | undefined;
    try {
      if (plugin !== undefined) {
        const result = await plugin.plugin.load(root, scratch.dir, new Map());
        project = result.project;
        issues.push(...result.issues);
      } else {
        if (!isProjectLoad(loadModule)) throw new Error("the project core's ./load export is missing its loaders");
        const result = await loadBackendProject(scratch.dir, undefined, loadModule);
        project = result.project;
        issues.push(...result.issues);
      }
    } catch (err) {
      issues.push({ message: err instanceof Error ? err.message : String(err) });
    }
    let box: SandboxResult | undefined;
    if (project !== undefined) {
      const merged = plugin === undefined ? { issues: [] } : mergeSandboxEntries(plugin.plugin);
      issues.push(...merged.issues);
      const entries = "entries" in merged && merged.entries !== undefined ? { entries: merged.entries } : {};
      box = sandboxBootInput(project.input, { dir: scratch.dir, consent: options.runSetup, ...entries });
    }
    const prepared: PreparedProject = {
      root,
      scratchDir: scratch.dir,
      core: resolved.core,
      coreVersion: resolved.version,
      kind: project?.kind ?? (plugin === undefined ? "backend" : plugin.kind),
      installed: installedKestrelVersions(root),
      plugins: plugin === undefined ? [] : [{ package: plugin.package, version: plugin.version, kind: plugin.kind }],
      issues,
      ...(plugin === undefined ? {} : { plugin }),
      ...(project === undefined ? {} : { project }),
      ...(box === undefined ? {} : { box }),
    };
    return { ok: true, value: await body(prepared) };
  } finally {
    process.chdir(previousCwd);
    await removeScratchCopy(scratch);
  }
}

/** A project's boot check in the scratch copy, plus what its host plugin checks beyond `boot()`. */
export interface Inspection {
  prepared: PreparedProject;
  bootCheck?: BootCheck;
  host: HostProblem[];
}

/** Runs `checkBoot()` of the project's own core on the sandboxed input, then the host plugin's `hostChecks`. */
export async function inspectProject(options: ProjectOptions): Promise<{ ok: true; value: Inspection } | PrepareFailure> {
  return withProject(options, async (prepared) => {
    if (prepared.project === undefined || prepared.box === undefined) return { prepared: { ...prepared, issues: remapPaths(prepared.issues, prepared.scratchDir, prepared.root) }, host: [] };
    const bootCheck = await prepared.core.checkBoot({ ...prepared.box.input, root: prepared.scratchDir, logger: prepared.core.silentLogger }, { setup: prepared.box.setup });
    const host: HostProblem[] = [];
    const plugin = prepared.plugin?.plugin;
    if (plugin?.hostChecks !== undefined) {
      try {
        host.push(...(await plugin.hostChecks(prepared.project, bootCheck)));
      } catch (err) {
        host.push({ code: "host-checks-failed", severity: "error", owner: prepared.plugin?.package ?? "host", reason: `hostChecks() threw: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    const { scratchDir, root } = prepared;
    const remapped: PreparedProject = { ...prepared, issues: remapPaths(prepared.issues, scratchDir, root) };
    return { prepared: remapped, bootCheck: remapPaths(bootCheck, scratchDir, root), host: remapPaths(host, scratchDir, root) };
  });
}
