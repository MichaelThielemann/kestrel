import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { isRecord } from "./guards.ts";

function directDependencies(root: string): string[] {
  const file = resolve(root, "package.json");
  if (!existsSync(file)) return [];
  try {
    const pkg = boundaryCast<unknown>(JSON.parse(readFileSync(file, "utf8")), "json");
    if (!isRecord(pkg)) return [];
    const names = new Set<string>();
    for (const block of [pkg.dependencies, pkg.devDependencies]) if (isRecord(block)) for (const name of Object.keys(block)) names.add(name);
    return [...names];
  } catch {
    return [];
  }
}

function resolveFrom(base: string, specifier: string): string | undefined {
  try {
    return createRequire(pathToFileURL(base).href).resolve(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Resolves `specifier` the way the project's own code would find it: from `<root>/package.json`
 * first, then from the directory of each of the project's direct dependencies, so a package a host
 * dependency brings along (a project that depends on one preset package only, say) is found too.
 * `undefined` when none of them can resolve it.
 */
export function resolveInstalled(root: string, specifier: string): string | undefined {
  const own = resolveFrom(resolve(root, "package.json"), specifier);
  if (own !== undefined) return own;
  for (const dependency of directDependencies(root)) {
    const manifest = installedManifest(root, dependency);
    if (manifest === undefined) continue;
    const found = resolveFrom(manifest, specifier);
    if (found !== undefined) return found;
  }
  return undefined;
}

function installedManifest(root: string, name: string): string | undefined {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/** Imports what {@link resolveInstalled} finds; `undefined` when it finds nothing or the import fails. */
export async function importInstalled(root: string, specifier: string): Promise<unknown> {
  const file = resolveInstalled(root, specifier);
  if (file === undefined) return undefined;
  try {
    const mod: unknown = await import(pathToFileURL(file).href);
    return mod;
  } catch {
    return undefined;
  }
}
