import { readFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Core from "@michaelthielemann/kestrel";
import type * as CoreLoad from "@michaelthielemann/kestrel/load";
import { cliVersion } from "./usage.ts";

const CORE = "@michaelthielemann/kestrel";

/** The parts of the project's own `@michaelthielemann/kestrel` the commands use. */
export type ProjectCore = Pick<typeof Core, "boot" | "checkBoot" | "loadConfig" | "loadModules" | "loadPipelines" | "consoleLogger" | "silentLogger" | "KestrelBootError">;

/** The project core's `./load` export, in the shape the upgrade engine's project loader takes. */
export type ProjectLoad = Pick<typeof CoreLoad, "loadConfig" | "loadModule" | "loadPipelineFile" | "pipelineFiles">;

export type ResolvedCore = { ok: true; version: string; core: ProjectCore } | { ok: false; message: string };

function hasMembers(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  return names.every((name) => name in value && typeof Reflect.get(value, name) !== "undefined");
}

function isProjectCore(value: unknown): value is ProjectCore {
  return hasMembers(value, ["boot", "checkBoot", "loadConfig", "loadModules", "loadPipelines", "consoleLogger", "silentLogger", "KestrelBootError"]);
}

/** Whether an imported module is the core's `./load` export. */
export function isProjectLoad(value: unknown): value is ProjectLoad {
  return hasMembers(value, ["loadConfig", "loadModule", "loadPipelineFile", "pipelineFiles"]);
}

function majorOf(version: string): string {
  return version.split(".")[0] ?? version;
}

function installedCoreVersion(root: string): string | undefined {
  try {
    const file = findPackageJSON(CORE, resolve(root, "package.json"));
    if (file === undefined) return undefined;
    const pkg: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** The file URL of the project core's export at `subpath` (`""` for the root export), resolved from `<root>/package.json`. */
export function projectCoreUrl(root: string, subpath: string): string {
  return pathToFileURL(createRequire(resolve(root, "package.json")).resolve(`${CORE}${subpath}`)).href;
}

/**
 * Resolves the project's own `@michaelthielemann/kestrel` from `<root>/package.json` and checks that its
 * major matches this CLI's before anything of it is imported.
 */
export function checkProjectCore(root: string): { ok: true; version: string } | { ok: false; message: string } {
  const version = installedCoreVersion(root);
  const cli = cliVersion();
  if (version === undefined) return { ok: false, message: `${CORE} is not installed in ${root}; add it next to @michaelthielemann/kestrel-cli and install` };
  if (majorOf(version) !== majorOf(cli)) {
    return { ok: false, message: `installed ${CORE} ${version} does not match kestrel-cli ${cli}; run "npx -y @michaelthielemann/kestrel-cli@${majorOf(version)} …", or "kestrel-cli upgrade" from the ${majorOf(cli)}.x CLI` };
  }
  return { ok: true, version };
}

/** Imports the project's own core root export, after `checkProjectCore` accepted it. */
export async function importProjectCore(root: string): Promise<ResolvedCore> {
  const checked = checkProjectCore(root);
  if (!checked.ok) return checked;
  // eslint-disable-next-line no-restricted-syntax
  const mod: unknown = await import(projectCoreUrl(root, ""));
  if (!isProjectCore(mod)) return { ok: false, message: `${CORE} ${checked.version} in ${root} does not export what kestrel-cli needs` };
  return { ok: true, version: checked.version, core: mod };
}
