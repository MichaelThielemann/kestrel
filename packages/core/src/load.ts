import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { boundaryCast } from "./cast.ts";
import type { KestrelConfigInput } from "./defineConfig.ts";
import type { ModuleDefinition } from "./defineModule.ts";
import type { PipelineDefinition } from "./definePipeline.ts";
import { KestrelBootError } from "./errors.ts";
import { isRecord } from "./guards.ts";

function isModuleDefinition(value: unknown): value is ModuleDefinition {
  return isRecord(value) && typeof value.name === "string" && typeof value.setup === "function" && Array.isArray(value.provides) && Array.isArray(value.requires) && value.configSchema !== undefined;
}

function isPipelineDefinition(value: unknown): value is PipelineDefinition {
  return isRecord(value) && typeof value.name === "string" && Array.isArray(value.steps);
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error;
}

async function importDefault(file: string, owner: string): Promise<unknown> {
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    throw new KestrelBootError(owner, `cannot load ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const def = boundaryCast<{ default?: unknown }>(mod, "host").default;
  if (def === undefined) throw new KestrelBootError(owner, `${file} has no default export`);
  return def;
}

export async function loadConfig(file: string): Promise<KestrelConfigInput> {
  const def = await importDefault(file, "kestrel.config");
  if (typeof def !== "object" || def === null) throw new KestrelBootError("kestrel.config", "default export is not an object");
  return boundaryCast<KestrelConfigInput>(def, "host");
}

export function resolveModuleFile(root: string, use: string): string {
  if (use.startsWith("./") || use.startsWith("../") || isAbsolute(use)) return resolve(root, use);
  return createRequire(pathToFileURL(resolve(root, "package.json")).href).resolve(use);
}

export async function loadModules(root: string, config: KestrelConfigInput): Promise<ModuleDefinition[]> {
  const out: ModuleDefinition[] = [];
  for (const entry of config.modules) {
    let file: string;
    try {
      file = resolveModuleFile(root, entry.use);
    } catch (err) {
      throw new KestrelBootError(entry.use, `cannot resolve module: ${err instanceof Error ? err.message : String(err)}`);
    }
    const def = await importDefault(file, entry.use);
    if (!isModuleDefinition(def)) {
      throw new KestrelBootError(entry.use, "default export is not a defineModule() result");
    }
    out.push(def);
  }
  return out;
}

export async function loadPipelines(root: string, dir: string): Promise<PipelineDefinition[]> {
  const abs = resolve(root, dir);
  try {
    if (!(await stat(abs)).isDirectory()) throw new KestrelBootError("pipelines", `${abs} is not a directory`);
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return [];
    throw err;
  }
  const files = (await readdir(abs)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
  const out: PipelineDefinition[] = [];
  for (const file of files) {
    const def = await importDefault(resolve(abs, file), `pipelines/${file}`);
    if (!isPipelineDefinition(def)) {
      throw new KestrelBootError(`pipelines/${file}`, "default export is not a definePipeline() result");
    }
    out.push(def);
  }
  return out;
}
