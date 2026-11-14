import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { effectiveModuleConfig } from "@michaelthielemann/kestrel";
import { loadConfig } from "@michaelthielemann/kestrel/load";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { isRecord } from "./guards.ts";
import { importInstalled } from "./installed.ts";
import type { UpgradePlugin } from "./plugin.ts";
import { detectPlugin } from "./pluginRules.ts";
import { createScratchCopy, removeScratchCopy } from "./scratch.ts";
import { useToken } from "./useToken.ts";

/** A module package with storage migrations, and the collections whose presence shows that a database holds its data. */
export interface StoragePackage {
  package: string;
  collections: readonly string[];
}

/** The module packages whose `./storage` export the `data` and `migrate` commands run, in the order a module depends on another. */
export const STORAGE_PACKAGES: readonly StoragePackage[] = [
  { package: "@michaelthielemann/kestrel-media-default", collections: ["media_items"] },
  { package: "@michaelthielemann/kestrel-images-default", collections: ["images_variants", "images_retired"] },
];

/** A package whose collections the database holds but whose `./storage` export could not be loaded from the project. */
export interface UnresolvedStorage {
  package: string;
  collections: string[];
}

/**
 * What {@link projectStorages} found. `configFrom` names where the module configs came from;
 * `configProblem` is set when the module configs could be loaded neither from `kestrel.config.ts` nor
 * through the project's host plugin although at least one of the two is there, so the storages were
 * built with the defaults. `mediaPrefix` is the key prefix the
 * media storage converts to, when the database holds media.
 */
export interface ProjectStorages {
  storages: ModuleStorage[];
  unresolved: UnresolvedStorage[];
  configFrom: string;
  configProblem?: string;
  mediaPrefix?: string;
}

/** The inputs of {@link projectStorages} besides the project and the database. */
export interface ProjectStoragesOptions {
  /** The host plugins to load the module configs through when `kestrel.config.ts` does not load by itself. */
  plugins?: readonly UpgradePlugin[];
  /** A media key prefix that replaces the one of `media-default`'s config. */
  mediaPrefix?: string;
}

const MEDIA_PACKAGE = "@michaelthielemann/kestrel-media-default";

function tablesOf(file: string): Set<string> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = boundaryCast<Array<{ name: string }>>(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), "host");
    return new Set(rows.map((r) => r.name));
  } finally {
    db.close();
  }
}

interface ModuleConfigs {
  configs: Map<string, unknown>;
  from: string;
  problem?: string;
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

function byToken(modules: ReadonlyArray<Parameters<typeof effectiveModuleConfig>[0] & { use: string }>): Map<string, unknown> {
  const configs = new Map<string, unknown>();
  for (const entry of modules) if (!configs.has(useToken(entry.use))) configs.set(useToken(entry.use), effectiveModuleConfig(entry));
  return configs;
}

async function pluginConfigs(root: string, plugin: UpgradePlugin): Promise<ModuleConfigs | string> {
  const scratch = await createScratchCopy(root);
  try {
    const loaded = await plugin.load(root, scratch.dir, new Map());
    if (loaded.project === undefined) return `the "${plugin.kind}" plugin could not load the project${loaded.issues.length === 0 ? "" : `: ${loaded.issues.map((i) => i.message).join("; ")}`}`;
    return { configs: byToken(loaded.project.input.config.modules), from: `the "${plugin.kind}" plugin` };
  } catch (thrown) {
    return `the "${plugin.kind}" plugin's load() threw: ${messageOf(thrown)}`;
  } finally {
    await removeScratchCopy(scratch);
  }
}

async function moduleConfigs(root: string, plugins: readonly UpgradePlugin[]): Promise<ModuleConfigs> {
  const file = join(root, "kestrel.config.ts");
  const problems: string[] = [];
  if (existsSync(file)) {
    try {
      const config = await loadConfig(file);
      return { configs: byToken(config.modules), from: "kestrel.config.ts" };
    } catch (thrown) {
      problems.push(`kestrel.config.ts could not be loaded: ${messageOf(thrown)}`);
    }
  }
  const { plugin } = await detectPlugin(plugins, root);
  if (plugin !== undefined) {
    const fromPlugin = await pluginConfigs(root, plugin);
    if (typeof fromPlugin !== "string") return fromPlugin;
    problems.push(fromPlugin);
  }
  return problems.length === 0 ? { configs: new Map(), from: "the defaults, without a kestrel.config.ts" } : { configs: new Map(), from: "the defaults", problem: problems.join("; ") };
}

function storageFactory(mod: unknown): ((config: unknown) => ModuleStorage) | undefined {
  if (!isRecord(mod) || typeof mod.storage !== "function") return undefined;
  return boundaryCast<(config: unknown) => ModuleStorage>(mod.storage, "host");
}

/**
 * The storages of the modules whose collections `dbFile` holds, built from the `./storage` export of
 * each module package as the project has it installed, with the module's config from
 * `<root>/kestrel.config.ts`, from the project's host plugin when that file does not load by itself,
 * and the defaults when there is neither. A module whose collections are absent has no data to
 * convert and is left out; one whose `./storage` export cannot be loaded is listed under `unresolved`.
 */
export async function projectStorages(root: string, dbFile: string, options: ProjectStoragesOptions = {}): Promise<ProjectStorages> {
  const tables = tablesOf(dbFile);
  const { configs, from, problem } = await moduleConfigs(root, options.plugins ?? []);
  const storages: ModuleStorage[] = [];
  const unresolved: UnresolvedStorage[] = [];
  let mediaPrefix: string | undefined;
  for (const candidate of STORAGE_PACKAGES) {
    const present = candidate.collections.filter((c) => tables.has(c));
    if (present.length === 0) continue;
    const factory = storageFactory(await importInstalled(root, `${candidate.package}/storage`));
    if (factory === undefined) {
      unresolved.push({ package: candidate.package, collections: present });
      continue;
    }
    const loaded = configs.get(useToken(candidate.package));
    const config: Record<string, unknown> = isRecord(loaded) ? { ...loaded } : {};
    if (candidate.package === MEDIA_PACKAGE) {
      if (options.mediaPrefix !== undefined) config.prefix = options.mediaPrefix;
      mediaPrefix = typeof config.prefix === "string" ? config.prefix : "media/";
    }
    storages.push(factory(config));
  }
  return { storages, unresolved, configFrom: options.mediaPrefix === undefined ? from : "--media-prefix", ...(problem === undefined ? {} : { configProblem: problem }), ...(mediaPrefix === undefined ? {} : { mediaPrefix }) };
}
