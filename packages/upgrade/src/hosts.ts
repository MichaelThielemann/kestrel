import { existsSync, readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { PLUGIN_API_MIN, PLUGIN_API_VERSION } from "./apiVersion.ts";
import { BACKEND_PACKAGE_NAMES } from "./backendPackages.ts";
import { isRecord, isString } from "./guards.ts";
import type { KestrelPluginHost, UpgradePlugin } from "./plugin.ts";

const UPGRADE_PACKAGE_NAME = "@michaelthielemann/kestrel-upgrade";

/** A direct dependency whose `kestrel` field passed every data check; its entry has not been imported yet. */
export interface LoadableHost {
  package: string;
  version: string;
  /** The absolute, real path of the plugin entry inside the package directory. */
  entry: string;
  pluginApi: number;
  engine: string;
}

/** A direct dependency that is not built for the running CLI; its plugin is never imported. */
export interface OutdatedHost {
  package: string;
  version: string;
  reason: string;
  /** The `deps/host-outdated` message naming the package, its version and the reason. */
  message: string;
}

/** A direct dependency whose `kestrel` field is malformed or unsafe, or whose plugin failed to load; nothing of it runs. */
export interface RefusedHost {
  package: string;
  version: string;
  reason: string;
}

/** The classification of a project's direct dependencies by their `kestrel` field, read as data only. */
export interface HostScan {
  loadable: LoadableHost[];
  outdated: OutdatedHost[];
  refused: RefusedHost[];
}

/** A host plugin that was imported, built and validated. */
export interface LoadedHost {
  package: string;
  version: string;
  kind: string;
  plugin: UpgradePlugin;
}

function readJson(file: string): unknown {
  return boundaryCast<unknown>(JSON.parse(readFileSync(file, "utf8")), "json");
}

function directDependencies(pkg: unknown): string[] {
  if (!isRecord(pkg)) return [];
  const names = new Set<string>();
  for (const block of [pkg.dependencies, pkg.devDependencies]) {
    if (isRecord(block)) for (const name of Object.keys(block)) names.add(name);
  }
  return [...names];
}

function dependsOnUpgrade(pkg: Record<string, unknown>): boolean {
  return [pkg.dependencies, pkg.peerDependencies].some((block) => isRecord(block) && UPGRADE_PACKAGE_NAME in block);
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** True when `range` has the only accepted form, `^<major>.<minor>.<patch>`. */
export function isCaretRange(range: string): boolean {
  return /^\^\d+\.\d+\.\d+$/.test(range);
}

/** Whether `version` satisfies a caret range of the form `^<major>.<minor>.<patch>`; any other range form is never satisfied. */
export function satisfiesCaret(version: string, range: string): boolean {
  if (!isCaretRange(range)) return false;
  const want = parseVersion(range.slice(1));
  const have = parseVersion(version);
  if (want === undefined || have === undefined) return false;
  const [wm, wn, wp] = want;
  const [hm, hn, hp] = have;
  const atLeast = hm > wm || (hm === wm && (hn > wn || (hn === wn && hp >= wp)));
  if (!atLeast) return false;
  if (wm > 0) return hm === wm;
  if (wn > 0) return hm === 0 && hn === wn;
  return hm === 0 && hn === 0 && hp === wp;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function outdated(name: string, version: string, reason: string, cliVersion: string): OutdatedHost {
  const major = parseVersion(cliVersion)?.[0] ?? cliVersion;
  return { package: name, version, reason, message: `dependency "${name}" ${version} is not built for this kestrel-cli (${reason}); install its release for kestrel ${major} first, then run this again` };
}

type Classified = { kind: "loadable"; host: LoadableHost } | { kind: "outdated"; host: OutdatedHost } | { kind: "refused"; host: RefusedHost } | { kind: "none" };

function classify(name: string, pkgFile: string, cliVersion: string): Classified {
  const pkg = readJson(pkgFile);
  if (!isRecord(pkg)) return { kind: "none" };
  const version = isString(pkg.version) ? pkg.version : "0.0.0";
  const field = pkg.kestrel;
  if (field === undefined) return dependsOnUpgrade(pkg) ? { kind: "outdated", host: outdated(name, version, "it declares no kestrel field", cliVersion) } : { kind: "none" };
  const refuse = (reason: string): Classified => ({ kind: "refused", host: { package: name, version, reason } });
  if (!isRecord(field)) return refuse("its kestrel field is not an object");
  const { plugin, pluginApi, engine } = field;
  if (!isString(plugin) || plugin === "") return refuse("kestrel.plugin is not a path");
  if (typeof pluginApi !== "number" || !Number.isInteger(pluginApi)) return refuse("kestrel.pluginApi is not an integer");
  if (!isString(engine) || !isCaretRange(engine)) return refuse(`kestrel.engine ${JSON.stringify(engine)} is not of the form ^<major>.<minor>.<patch>`);
  if (isAbsolute(plugin)) return refuse(`kestrel.plugin "${plugin}" is an absolute path`);
  const dir = dirname(pkgFile);
  const entry = resolve(dir, plugin);
  if (!isInside(entry, dir)) return refuse(`kestrel.plugin "${plugin}" leaves the package directory`);
  const extension = extname(entry);
  if (extension !== ".mjs" && extension !== ".js") return refuse(`kestrel.plugin "${plugin}" is not a .mjs or .js file`);
  if (!existsSync(entry)) return refuse(`kestrel.plugin "${plugin}" does not exist`);
  const realEntry = realpathSync(entry);
  if (!isInside(realEntry, realpathSync(dir))) return refuse(`kestrel.plugin "${plugin}" resolves outside the package directory through a symlink`);
  if (pluginApi > PLUGIN_API_VERSION) return refuse(`needs plugin API ${pluginApi}, this kestrel-cli has ${PLUGIN_API_VERSION}; update kestrel-cli`);
  if (pluginApi < PLUGIN_API_MIN) return { kind: "outdated", host: outdated(name, version, `it declares plugin API ${pluginApi}, this kestrel-cli needs at least ${PLUGIN_API_MIN}`, cliVersion) };
  if (!satisfiesCaret(cliVersion, engine)) return { kind: "outdated", host: outdated(name, version, `it is built for kestrel-cli ${engine}, this is ${cliVersion}`, cliVersion) };
  return { kind: "loadable", host: { package: name, version, entry: realEntry, pluginApi, engine } };
}

/**
 * Classifies the project's direct dependencies (`dependencies` and `devDependencies` of
 * `<root>/package.json`, minus kestrel's own packages) by the `kestrel` field of their installed
 * `package.json`, read as data only. Nothing is imported.
 */
export function scanHosts(root: string, options: { cliVersion: string }): HostScan {
  const scan: HostScan = { loadable: [], outdated: [], refused: [] };
  const rootPkgFile = resolve(root, "package.json");
  if (!existsSync(rootPkgFile)) return scan;
  let rootPkg: unknown;
  try {
    rootPkg = readJson(rootPkgFile);
  } catch {
    return scan;
  }
  for (const name of directDependencies(rootPkg)) {
    if (BACKEND_PACKAGE_NAMES.includes(name)) continue;
    let pkgFile: string | undefined;
    try {
      pkgFile = findPackageJSON(name, rootPkgFile);
    } catch {
      continue;
    }
    if (pkgFile === undefined) continue;
    let result: Classified;
    try {
      result = classify(name, pkgFile, options.cliVersion);
    } catch (err) {
      result = { kind: "refused", host: { package: name, version: "unknown", reason: `its package.json could not be read: ${err instanceof Error ? err.message : String(err)}` } };
    }
    if (result.kind === "loadable") scan.loadable.push(result.host);
    else if (result.kind === "outdated") scan.outdated.push(result.host);
    else if (result.kind === "refused") scan.refused.push(result.host);
  }
  return scan;
}

/** Structural check of a factory's return value against the members every `UpgradePlugin` has. */
export function isUpgradePlugin(value: unknown): value is UpgradePlugin {
  return isRecord(value) && isString(value.kind) && typeof value.detect === "function" && typeof value.load === "function";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Imports each loadable host's entry by file URL and calls its default export with `host`; a throw or an invalid result refuses that host instead of throwing. */
export async function loadHostPlugins(loadable: readonly LoadableHost[], host: KestrelPluginHost): Promise<{ loaded: LoadedHost[]; refused: RefusedHost[] }> {
  const loaded: LoadedHost[] = [];
  const refused: RefusedHost[] = [];
  for (const candidate of loadable) {
    const refuse = (reason: string): void => {
      refused.push({ package: candidate.package, version: candidate.version, reason });
    };
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(candidate.entry).href);
    } catch (err) {
      refuse(`its plugin entry failed to import: ${message(err)}`);
      continue;
    }
    const factory = isRecord(mod) ? mod.default : undefined;
    if (typeof factory !== "function") {
      refuse("its plugin entry has no default export function");
      continue;
    }
    let plugin: unknown;
    try {
      plugin = await boundaryCast<(host: KestrelPluginHost) => unknown>(factory, "host")(host);
    } catch (err) {
      refuse(`its plugin factory threw: ${message(err)}`);
      continue;
    }
    if (!isUpgradePlugin(plugin)) {
      refuse("its plugin factory did not return a plugin with kind, detect and load");
      continue;
    }
    loaded.push({ package: candidate.package, version: candidate.version, kind: plugin.kind, plugin });
  }
  return { loaded, refused };
}

/** The outcome of choosing the host plugin for a project: at most one loaded plugin may detect it. */
export type HostSelection = { ok: true; active?: LoadedHost } | { ok: false; message: string };

/** Calls `detect(root)` on every loaded plugin; a throwing `detect` or more than one plugin detecting the project is a refusal naming the packages. */
export async function selectHostPlugin(loaded: readonly LoadedHost[], root: string): Promise<HostSelection> {
  const detecting: LoadedHost[] = [];
  for (const candidate of loaded) {
    try {
      if (await candidate.plugin.detect(root)) detecting.push(candidate);
    } catch (err) {
      return { ok: false, message: `dependency "${candidate.package}" ${candidate.version}: its plugin's detect() threw: ${message(err)}` };
    }
  }
  if (detecting.length > 1) return { ok: false, message: `more than one dependency registers a plugin that detects this project: ${detecting.map((d) => `"${d.package}"`).join(", ")}; remove all but one` };
  return detecting[0] === undefined ? { ok: true } : { ok: true, active: detecting[0] };
}

/** One line per refused host, naming the package and the reason. */
export function refusalMessage(refused: RefusedHost): string {
  return `dependency "${refused.package}" ${refused.version} was refused as a kestrel plugin: ${refused.reason}`;
}

export { PLUGIN_API_MIN, PLUGIN_API_VERSION } from "./apiVersion.ts";
