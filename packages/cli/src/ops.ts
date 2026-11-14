import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The package behind `kestrel status`, `backup`, `restore` and `update`; the CLI loads it only when one of them runs. */
export const OPS_PACKAGE = "@michaelthielemann/kestrel-ops";

type Runner = (argv: readonly string[]) => Promise<number>;

interface LoadedOps {
  version: string;
  runOps: Runner;
  runUpdate: Runner | null;
}

const isRunner = (value: unknown): value is Runner => typeof value === "function";

function resolveFrom(base: string): string | null {
  try {
    return createRequire(base).resolve(`${OPS_PACKAGE}/run`);
  } catch {
    return null;
  }
}

function versionNear(file: string): string {
  for (let dir = dirname(file); dirname(dir) !== dir; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (Reflect.get(Object(pkg), "name") !== OPS_PACKAGE) continue;
    const version: unknown = Reflect.get(Object(pkg), "version");
    return typeof version === "string" ? version : "unknown";
  }
  return "unknown";
}

async function loadOps(root: string): Promise<LoadedOps | null> {
  const file = resolveFrom(join(root, "package.json")) ?? resolveFrom(import.meta.url);
  if (file === null) return null;
  const mod: unknown = await import(pathToFileURL(file).href);
  const runOps: unknown = Reflect.get(Object(mod), "runOps");
  const runUpdate: unknown = Reflect.get(Object(mod), "runUpdate");
  if (!isRunner(runOps)) throw new Error(`${OPS_PACKAGE} at ${file} exports no runOps`);
  return { version: versionNear(file), runOps, runUpdate: isRunner(runUpdate) ? runUpdate : null };
}

/** Runs `kestrel <command> ...argv` through the kestrel-ops installed for the project in the current directory, or next to the CLI; without one it explains how to install it and answers 2. */
export async function runOpsCommand(command: "status" | "backup" | "restore" | "update", argv: readonly string[]): Promise<number> {
  const ops = await loadOps(process.cwd());
  if (ops === null) {
    process.stderr.write(`kestrel ${command} needs ${OPS_PACKAGE}, which is not installed in this project.\nInstall it as a development dependency, together with the target package kestrel.environments.json names:\n  pnpm add -D ${OPS_PACKAGE}\n`);
    return 2;
  }
  if (command !== "update") return ops.runOps([command, ...argv]);
  if (ops.runUpdate === null) {
    process.stderr.write(`kestrel update: the installed ${OPS_PACKAGE} ${ops.version} has no update assistant; status, backup and restore work with it.\n`);
    return 2;
  }
  return ops.runUpdate(argv);
}
