import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const RUNTIME_PACKAGES = ["@michaelthielemann/kestrel-replication-sqlite", "@michaelthielemann/kestrel"];

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function packageDir(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    if (dirname(dir) === dir) return null;
  }
}

function versionIn(dir: string | null): string | null {
  if (dir === null) return null;
  const version: unknown = Reflect.get(Object(readJson(join(dir, "package.json"))), "version");
  return typeof version === "string" ? version : null;
}

/**
 * The installed versions of the dependencies of the `package.json` in `dir`, and of the Kestrel runtime packages they
 * bring along. Without a `package.json` in `dir` it is empty: a `node_modules` there or above belongs to another
 * package, such as the dependencies of kestrel-ops in its bundle.
 */
export function installedPackages(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dependencies: unknown = Reflect.get(Object(readJson(join(dir, "package.json"))), "dependencies");
  const direct = typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
  const dirs: string[] = [];
  for (const name of direct) {
    const found = packageDir(name, dir);
    const version = versionIn(found);
    if (found !== null) dirs.push(found);
    if (version !== null) out[name] = version;
  }
  for (const name of RUNTIME_PACKAGES) {
    if (out[name] !== undefined) continue;
    for (const from of dirs) {
      const version = versionIn(packageDir(name, from));
      if (version === null) continue;
      out[name] = version;
      break;
    }
  }
  return out;
}
