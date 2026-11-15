import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";

/** The real directory of package `name` as Node resolves it from `from`, or by the `node_modules` directories above `from`; null when neither finds it. */
export function packageDir(name: string, from: string): string | null {
  try {
    return dirname(realpathSync(createRequire(join(from, "package.json")).resolve(`${name}/package.json`)));
  } catch {
    let dir = from;
    for (;;) {
      const candidate = join(dir, "node_modules", name, "package.json");
      if (existsSync(candidate)) return dirname(realpathSync(candidate));
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

function directDependencies(root: string): string[] {
  const file = join(root, "package.json");
  if (!existsSync(file)) return [];
  try {
    const pkg = boundaryCast<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(JSON.parse(readFileSync(file, "utf8")), "json");
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  } catch {
    return [];
  }
}

/**
 * The directory of package `name` as the project in `root` has it installed: resolved from `root` itself, or from the
 * directory of one of the project's direct dependencies, so a package that a dependency brings along (a project that
 * depends on one preset package, say, which pnpm does not hoist) is found too; null when none of them has it.
 */
export function installedPackageDir(name: string, root: string): string | null {
  const own = packageDir(name, root);
  if (own !== null) return own;
  for (const dependency of directDependencies(root)) {
    const dir = packageDir(dependency, root);
    const found = dir === null ? null : packageDir(name, dir);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The packages whose name starts with `prefix` that the direct dependencies of the project in `root` depend on, one
 * level deep, with the directory each resolves to from that dependency.
 */
export function packagesBroughtBy(root: string, prefix: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const dependency of directDependencies(root)) {
    const dir = packageDir(dependency, root);
    if (dir === null) continue;
    for (const name of directDependencies(dir)) {
      if (!name.startsWith(prefix) || found.has(name)) continue;
      const at = packageDir(name, dir);
      if (at !== null) found.set(name, at);
    }
  }
  return found;
}

/** The version in the `package.json` of package `name` resolved from `from`, or null. */
export function packageVersion(name: string, from: string): string | null {
  const dir = packageDir(name, from);
  if (dir === null) return null;
  const version = boundaryCast<{ version?: unknown }>(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), "json").version;
  return typeof version === "string" ? version : null;
}

function conditional(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  for (const condition of ["import", "node", "default"]) {
    const found = conditional(Reflect.get(value, condition));
    if (found !== null) return found;
  }
  return null;
}

/** The file an ESM import of the package in `dir` loads: its `exports` entry for `.` under the import, node or default condition, else `module`, `main` or `index.js`. */
export function packageEntry(dir: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const exports: unknown = Reflect.get(Object(manifest), "exports");
  const dot: unknown = typeof exports === "object" && exports !== null && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith(".")) ? Reflect.get(exports, ".") : exports;
  const fallback = [Reflect.get(Object(manifest), "module"), Reflect.get(Object(manifest), "main")].find((v): v is string => typeof v === "string");
  return join(dir, conditional(dot) ?? fallback ?? "index.js");
}
