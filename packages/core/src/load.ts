import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { KestrelConfigInput } from "./defineConfig.ts";
import type { ModuleDefinition } from "./defineModule.ts";
import type { PipelineDefinition } from "./definePipeline.ts";
import { KestrelBootError } from "./errors.ts";

async function importDefault(file: string, owner: string): Promise<unknown> {
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    throw new KestrelBootError(owner, `cannot load ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const def = (mod as { default?: unknown }).default;
  if (def === undefined) throw new KestrelBootError(owner, `${file} has no default export`);
  return def;
}

export async function loadConfig(file: string): Promise<KestrelConfigInput> {
  const def = await importDefault(file, "kestrel.config");
  if (typeof def !== "object" || def === null) throw new KestrelBootError("kestrel.config", "default export is not an object");
  return def as KestrelConfigInput;
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
    const m = def as Partial<ModuleDefinition>;
    if (typeof m !== "object" || m === null || typeof m.name !== "string" || typeof m.setup !== "function" || !Array.isArray(m.provides) || !Array.isArray(m.requires) || m.configSchema === undefined) {
      throw new KestrelBootError(entry.use, "default export is not a defineModule() result");
    }
    out.push(m as ModuleDefinition);
  }
  return out;
}

export async function loadPipelines(root: string, dir: string): Promise<PipelineDefinition[]> {
  const abs = resolve(root, dir);
  try {
    if (!(await stat(abs)).isDirectory()) throw new KestrelBootError("pipelines", `${abs} is not a directory`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files = (await readdir(abs)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
  const out: PipelineDefinition[] = [];
  for (const file of files) {
    const def = await importDefault(resolve(abs, file), `pipelines/${file}`);
    const p = def as Partial<PipelineDefinition>;
    if (typeof p !== "object" || p === null || typeof p.name !== "string" || !Array.isArray(p.steps)) {
      throw new KestrelBootError(`pipelines/${file}`, "default export is not a definePipeline() result");
    }
    out.push(p as PipelineDefinition);
  }
  return out;
}
