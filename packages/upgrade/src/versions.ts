import { readFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { resolve } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { BACKEND_PACKAGE_NAMES } from "./backendPackages.ts";
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

/**
 * Every `@michaelthielemann/kestrel*` package the project's own `package.json` names, with its
 * installed version where resolvable. `mixedMajors` looks only at this repo's own backend packages
 * (`BACKEND_PACKAGE_NAMES`) — never at a plugin's own package, even one under the same npm scope.
 */
export function installedVersions(root: string): InstalledVersions {
  const pkg = boundaryCast<unknown>(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")), "json");
  const names = new Set(dependencyNames(pkg).filter((n) => n.startsWith("@michaelthielemann/kestrel")));
  const installed: Record<string, string> = {};
  for (const name of names) {
    const version = packageVersion(root, name);
    if (version !== undefined) installed[name] = version;
  }
  const backendMajors = new Set(Object.entries(installed).filter(([name]) => BACKEND_PACKAGE_NAMES.includes(name)).map(([, version]) => majorOf(version)));
  return { installed, mixedMajors: backendMajors.size > 1 };
}

/** This package's own version, read from its `package.json`; `"0.0.0"` when it cannot be resolved (a bundling layout this lookup does not expect). */
export function toolVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = boundaryCast<unknown>(JSON.parse(readFileSync(require.resolve("../package.json"), "utf8")), "json");
    return isRecord(pkg) && isString(pkg.version) ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
