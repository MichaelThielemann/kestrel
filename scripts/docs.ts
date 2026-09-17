#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boot, loadConfig, loadModules, loadPipelines, silentLogger, type Manifest, type ModuleDefinition } from "../packages/core/src/index.ts";
import { buildManifest } from "../packages/core/src/describe.ts";
import { stepPrefix } from "../packages/core/src/defineModule.ts";
import { StepRegistry } from "../packages/core/src/registry.ts";
import { orderPackages, render, rootTable, splice, type PackageInfo, type Section } from "./docs-render.ts";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(workspace, "examples", "minimal");
const check = process.argv.includes("--check");

interface Package {
  dir: string;
  name: string;
}

function rel(file: string): string {
  return file.slice(workspace.length + 1);
}

function packages(): Package[] {
  return readdirSync(join(workspace, "packages"))
    .map((dir) => join(workspace, "packages", dir))
    .filter((dir) => existsSync(join(dir, "module.ts")) && existsSync(join(dir, "package.json")))
    .map((dir) => ({ dir, name: (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string }).name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function allPackages(): PackageInfo[] {
  const all = readdirSync(join(workspace, "packages"))
    .map((dir) => join(workspace, "packages", dir))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageInfo);
  return orderPackages(all);
}

async function exampleManifest(): Promise<Manifest> {
  const config = await loadConfig(join(example, "kestrel.config.ts"));
  const modules = await loadModules(example, config);
  const pipelines = await loadPipelines(example, config.pipelinesDir ?? "./pipelines");
  const kestrel = await boot({ config: { ...config, http: null }, modules, pipelines, logger: silentLogger, root: example });
  const manifest = kestrel.describe();
  await kestrel.stop();
  return manifest;
}

function registerStandaloneSteps(registry: StepRegistry, mod: ModuleDefinition): void {
  if (!mod.steps) return;
  try {
    registry.register(mod.name, stepPrefix(mod.name), mod.steps(undefined), mod.describe?.(undefined) ?? {});
  } catch {
    return;
  }
}

async function standalone(pkg: Package): Promise<Section> {
  const mod = (await import(pathToFileURL(join(pkg.dir, "module.ts")).href)) as { default: ModuleDefinition };
  const registry = new StepRegistry();
  registerStandaloneSteps(registry, mod.default);
  const manifest = buildManifest({ root: pkg.dir, modules: [mod.default], uses: [pkg.name], rawConfigs: new Map(), contracts: [], steps: registry, pipelines: new Map(), triggers: { http: [], events: [], crons: [] } });
  return { module: manifest.modules[0]!, steps: manifest.steps, manifest: null };
}

async function main(): Promise<void> {
  const manifest = await exampleManifest();
  const byUse = new Map(manifest.modules.map((m) => [m.use, m]));
  const outputs = new Map<string, string>();
  for (const pkg of packages()) {
    const readmeFile = join(pkg.dir, "README.md");
    const module = byUse.get(pkg.name);
    const section: Section = module ? { module, steps: manifest.steps.filter((s) => s.module === module.name), manifest } : await standalone(pkg);
    outputs.set(readmeFile, splice(existsSync(readmeFile) ? readFileSync(readmeFile, "utf8") : `# ${section.module.name}\n`, render(section), rel(readmeFile)));
  }
  outputs.set(join(example, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const rootReadmeFile = join(workspace, "README.md");
  outputs.set(rootReadmeFile, splice(readFileSync(rootReadmeFile, "utf8"), rootTable(allPackages()), rel(rootReadmeFile)));

  const drifted = [...outputs].filter(([file, content]) => !existsSync(file) || readFileSync(file, "utf8") !== content).map(([file]) => rel(file));
  if (check) {
    if (drifted.length > 0) {
      console.error(`docs drifted from the manifest, run \`pnpm docs:generate\`:\n${drifted.map((f) => `  ${f}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`docs match the manifest (${outputs.size} files)`);
  } else {
    for (const [file, content] of outputs) writeFileSync(file, content);
    console.log(`wrote ${drifted.length} of ${outputs.size} files`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
