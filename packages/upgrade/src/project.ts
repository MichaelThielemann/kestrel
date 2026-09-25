import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BootInput, KestrelConfigInput, ModuleDefinition, PipelineDefinition } from "@michaelthielemann/kestrel";
import { loadConfig, loadModule, loadPipelineFile, pipelineFiles } from "@michaelthielemann/kestrel/load";
import type { LoadIssue, LoadResult, PipelineFile } from "./plugin.ts";
import { upgradingDocs } from "./ruleHelpers.ts";
import type { Finding } from "./report.ts";

export type { LoadIssue, LoadResult } from "./plugin.ts";

function resolveModuleFile(root: string, use: string): string {
  if (use.startsWith("./") || use.startsWith("../") || isAbsolute(use)) return resolve(root, use);
  return createRequire(pathToFileURL(resolve(root, "package.json")).href).resolve(use);
}

/** Loads a backend project's config, modules and pipelines file by file, from the given root; one bad file becomes an issue and loading keeps going. */
export async function loadBackendProject(root: string, entry?: string): Promise<LoadResult> {
  const configFile = entry ?? join(root, "kestrel.config.ts");
  let config: KestrelConfigInput;
  try {
    config = await loadConfig(configFile);
  } catch (err) {
    return { issues: [{ file: configFile, message: err instanceof Error ? err.message : String(err) }] };
  }

  const modules: ModuleDefinition[] = [];
  const moduleFiles = new Map<string, string>();
  const issues: LoadIssue[] = [];
  for (const moduleEntry of config.modules) {
    try {
      const mod = await loadModule(root, moduleEntry);
      modules.push(mod);
      moduleFiles.set(mod.name, resolveModuleFile(root, moduleEntry.use));
    } catch (err) {
      issues.push({ use: moduleEntry.use, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const files = await pipelineFiles(root, config.pipelinesDir ?? "./pipelines");
  const pipelines: PipelineDefinition[] = [];
  const pipelineFileList: PipelineFile[] = [];
  for (const file of files) {
    try {
      const def = await loadPipelineFile(file);
      pipelines.push(def);
      pipelineFileList.push({ file, pipelines: [def.name] });
    } catch (err) {
      issues.push({ file, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const input: BootInput = { config, modules, pipelines, root };
  return { project: { input, kind: "backend", configFile, moduleFiles, pipelineFiles: pipelineFileList }, issues };
}

export function loadIssuesAsFindings(issues: readonly LoadIssue[]): Finding[] {
  return issues.map((issue) => ({
    id: `load/${issue.file ?? issue.use ?? issue.message}`,
    rule: "load/failed",
    severity: "error",
    tier: "source",
    where: issue.file !== undefined ? { file: issue.file } : issue.use !== undefined ? { module: issue.use } : {},
    message: issue.message,
    suggestion: "fix the file so it loads, then run check again",
    fix: { kind: "manual" },
    docs: upgradingDocs("load"),
  }));
}
