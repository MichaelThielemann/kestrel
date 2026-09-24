import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { resolve } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { isRecord, isString } from "./guards.ts";

export interface InstalledVersions {
  installed: Record<string, string>;
  mixedMajors: boolean;
}

function packageVersion(root: string, name: string): string | undefined {
  try {
    const pkgFile = findPackageJSON(name, resolve(root, "package.json"));
    if (pkgFile === undefined) return undefined;
    const pkg = boundaryCast<unknown>(JSON.parse(readFileSync(pkgFile, "utf8")), "json");
    return isRecord(pkg) && isString(pkg.version) ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export function majorOf(version: string): number {
  return Number(version.split(".")[0]);
}

function dependencyNames(pkg: unknown): string[] {
  if (!isRecord(pkg)) return [];
  const deps = isRecord(pkg.dependencies) ? Object.keys(pkg.dependencies) : [];
  const devDeps = isRecord(pkg.devDependencies) ? Object.keys(pkg.devDependencies) : [];
  return [...deps, ...devDeps];
}

/** Every `@michaelthielemann/kestrel*` package the project's own `package.json` names, with its installed version where resolvable. */
export function installedVersions(root: string): InstalledVersions {
  const pkg = boundaryCast<unknown>(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")), "json");
  const names = new Set(dependencyNames(pkg).filter((n) => n.startsWith("@michaelthielemann/kestrel")));
  const installed: Record<string, string> = {};
  for (const name of names) {
    const version = packageVersion(root, name);
    if (version !== undefined) installed[name] = version;
  }
  const majors = new Set(Object.values(installed).map(majorOf));
  return { installed, mixedMajors: majors.size > 1 };
}
