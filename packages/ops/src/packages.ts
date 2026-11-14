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
