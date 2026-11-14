import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { effectiveModuleConfig } from "@michaelthielemann/kestrel";
import { loadConfig } from "@michaelthielemann/kestrel/load";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { isRecord } from "./guards.ts";
import { importInstalled } from "./installed.ts";
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

/** What {@link projectStorages} found. */
export interface ProjectStorages {
  storages: ModuleStorage[];
  unresolved: UnresolvedStorage[];
}

function tablesOf(file: string): Set<string> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = boundaryCast<Array<{ name: string }>>(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), "host");
    return new Set(rows.map((r) => r.name));
  } finally {
    db.close();
  }
}

async function moduleConfigs(root: string): Promise<Map<string, unknown>> {
  const configs = new Map<string, unknown>();
  const file = join(root, "kestrel.config.ts");
  if (!existsSync(file)) return configs;
  try {
    const config = await loadConfig(file);
    for (const entry of config.modules) if (!configs.has(useToken(entry.use))) configs.set(useToken(entry.use), effectiveModuleConfig(entry));
  } catch {
    return configs;
  }
  return configs;
}

function storageFactory(mod: unknown): ((config: unknown) => ModuleStorage) | undefined {
  if (!isRecord(mod) || typeof mod.storage !== "function") return undefined;
  return boundaryCast<(config: unknown) => ModuleStorage>(mod.storage, "host");
}

/**
 * The storages of the modules whose collections `dbFile` holds, built from the `./storage` export of
 * each module package as the project has it installed, with the module's config from
 * `<root>/kestrel.config.ts` when that file loads (the defaults otherwise). A module whose collections
 * are absent has no data to convert and is left out; one whose `./storage` export cannot be loaded is
 * listed under `unresolved`.
 */
export async function projectStorages(root: string, dbFile: string): Promise<ProjectStorages> {
  const tables = tablesOf(dbFile);
  const configs = await moduleConfigs(root);
  const storages: ModuleStorage[] = [];
  const unresolved: UnresolvedStorage[] = [];
  for (const candidate of STORAGE_PACKAGES) {
    const present = candidate.collections.filter((c) => tables.has(c));
    if (present.length === 0) continue;
    const factory = storageFactory(await importInstalled(root, `${candidate.package}/storage`));
    if (factory === undefined) {
      unresolved.push({ package: candidate.package, collections: present });
      continue;
    }
    const config = configs.get(useToken(candidate.package));
    storages.push(factory(isRecord(config) ? config : {}));
  }
  return { storages, unresolved };
}
