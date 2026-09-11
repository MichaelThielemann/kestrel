#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boot, loadConfig, loadModules, loadPipelines, silentLogger, type JsonSchema, type Manifest, type ModuleDefinition, type ModuleManifest, type StepDescription, type StepManifest } from "../packages/core/src/index.ts";
import { buildManifest } from "../packages/core/src/describe.ts";
import { stepPrefix } from "../packages/core/src/defineModule.ts";
import { StepRegistry } from "../packages/core/src/registry.ts";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(workspace, "examples", "minimal");
const check = process.argv.includes("--check");
const START = "<!-- kestrel-docs:start -->";
const END = "<!-- kestrel-docs:end -->";
const MAX_LISTED_PIPELINES = 12;

interface Package {
  dir: string;
  name: string;
}

interface Section {
  module: ModuleManifest;
  steps: StepManifest[];
  manifest: Manifest | null;
}

function packages(): Package[] {
  return readdirSync(join(workspace, "packages"))
    .map((dir) => join(workspace, "packages", dir))
    .filter((dir) => existsSync(join(dir, "module.ts")) && existsSync(join(dir, "package.json")))
    .map((dir) => ({ dir, name: (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string }).name }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

/** A package the example does not load is described from its definition alone: steps and describe() are called without an instance. */
async function standalone(pkg: Package): Promise<Section> {
  const mod = (await import(pathToFileURL(join(pkg.dir, "module.ts")).href)) as { default: ModuleDefinition };
  const registry = new StepRegistry();
  try {
    if (mod.default.steps) registry.register(mod.default.name, stepPrefix(mod.default.name), mod.default.steps(undefined), mod.default.describe?.(undefined) ?? {});
  } catch {
    /* a module whose steps need the instance keeps its hand-written README only */
  }
  const manifest = buildManifest({ root: pkg.dir, modules: [mod.default], uses: [pkg.name], rawConfigs: new Map(), contracts: [], steps: registry, pipelines: new Map(), triggers: { http: [], events: [], crons: [] } });
  return { module: manifest.modules[0]!, steps: manifest.steps, manifest: null };
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function brief(schema: JsonSchema | undefined, depth = 0): string {
  if (schema === undefined) return "–";
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) return ((schema.oneOf ?? schema.anyOf) as JsonSchema[]).map((s) => brief(s, depth + 1)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return (schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
  const type = Array.isArray(schema.type) ? (schema.type as string[]).join(" | ") : (schema.type as string | undefined);
  if (type === "array") return `${brief(schema.items as JsonSchema | undefined, depth + 1)}[]`;
  if (type === "object" || (type === undefined && schema.properties !== undefined)) {
    const properties = schema.properties as Record<string, JsonSchema> | undefined;
    if (!properties || depth > 0) return "object";
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const open = schema.additionalProperties !== false ? ", …" : "";
    return `{ ${Object.entries(properties).map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${brief(v, depth + 1)}`).join(", ")}${open} }`;
  }
  return type ?? "any";
}

function inputCell(description: StepDescription): string {
  const parts: string[] = [];
  if (description.input !== undefined) parts.push(brief(description.input));
  const entries = Object.entries(description.query ?? {});
  if (entries.length > 0) parts.push(`?${entries.map(([k, v]) => `${k}: ${brief(v, 1)}`).join(", ")}`);
  return parts.length === 0 ? "–" : parts.join(" ");
}

function errors(description: StepDescription): string {
  return Object.entries(description.errors ?? {})
    .map(([status, text]) => `${status} ${text}`)
    .join("; ");
}

function configTable(module: ModuleManifest): string[] {
  if (module.config.variables.length === 0) return ["Config: `{}` – nothing to set.", ""];
  const rows = module.config.variables.map((v) => `| \`${v.path}\` | ${v.type} | ${v.required ? "yes" : "no"} | ${v.secret ? "*(secret)*" : v.default === undefined ? "–" : `\`${cell(JSON.stringify(v.default))}\``} |`);
  return ["| Config | Type | Required | Default |", "|---|---|---|---|", ...rows, ""];
}

function stepTable(steps: StepManifest[]): string[] {
  if (steps.length === 0) return [];
  const rows = steps.map((s) => {
    const name = `\`${s.name}${s.factory ? ":<arg>" : ""}\``;
    const d = s.description;
    if (!d) return `| ${name} | *(described per argument)* | | | | | |`;
    const paths = (list: readonly string[]) => (list.length === 0 ? "–" : list.map((p) => `\`${p}\``).join(", "));
    return `| ${name} | ${cell(d.summary)} | ${paths(d.reads)} | ${paths(d.writes)} | ${cell(inputCell(d))} | ${cell(brief(d.output ?? d.extendsOutput ?? d.extendsItems))} | ${cell(errors(d)) || "–"} |`;
  });
  return ["| Step | Summary | Reads | Writes | Input | Output | Errors |", "|---|---|---|---|---|---|---|", ...rows, ""];
}

function pipelineList(module: ModuleManifest, manifest: Manifest): string[] {
  const owned = new Set(module.steps);
  const routes = new Map<string, string[]>();
  for (const t of manifest.triggers.http) routes.set(t.pipeline, [...(routes.get(t.pipeline) ?? []), `${t.method} ${t.path}`]);
  for (const t of manifest.triggers.events) routes.set(t.pipeline, [...(routes.get(t.pipeline) ?? []), `event ${t.event}`]);
  for (const t of manifest.triggers.crons) routes.set(t.pipeline, [...(routes.get(t.pipeline) ?? []), `cron ${t.expression}`]);
  const using = manifest.pipelines.filter((p) => p.steps.some((s) => owned.has(s.name)));
  if (using.length === 0) return [];
  if (using.length > MAX_LISTED_PIPELINES) return [`Used by ${using.length} of ${manifest.pipelines.length} pipelines in \`examples/minimal\`.`, ""];
  const lines = using.map((p) => `- **${p.name}** (${(routes.get(p.name) ?? ["no trigger"]).join(", ")}): ${p.steps.map((s) => (owned.has(s.name) ? `**\`${s.spec}\`**` : `\`${s.spec}\``)).join(" → ")}`);
  return ["Pipelines in `examples/minimal` using these steps:", "", ...lines, ""];
}

function render(section: Section): string {
  const { module, steps, manifest } = section;
  const contracts = [`provides ${module.provides.length === 0 ? "no contract" : module.provides.map((c) => `\`${c}\``).join(", ")}`, module.requires.length === 0 ? "" : `requires ${module.requires.map((c) => `\`${c}\``).join(", ")}`, module.optional.length === 0 ? "" : `optional ${module.optional.map((c) => `\`${c}\``).join(", ")}`].filter(Boolean).join("; ");
  const lines = [START, "## Generated from the manifest", `\`${module.use}\` – module \`${module.name}\`: ${contracts}${module.eventHook ? "; provides the event trigger hook" : ""}.`, "", ...configTable(module), ...stepTable(steps), ...(manifest ? pipelineList(module, manifest) : []), END];
  return lines.join("\n");
}

function splice(readme: string, generated: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) return `${readme.replace(/\s*$/, "")}\n\n${generated}\n`;
  return `${readme.slice(0, start)}${generated}${readme.slice(end + END.length)}`;
}

const manifest = await exampleManifest();
const byUse = new Map(manifest.modules.map((m) => [m.use, m]));
const outputs = new Map<string, string>();
for (const pkg of packages()) {
  const readmeFile = join(pkg.dir, "README.md");
  const module = byUse.get(pkg.name);
  const section: Section = module ? { module, steps: manifest.steps.filter((s) => s.module === module.name), manifest } : await standalone(pkg);
  outputs.set(readmeFile, splice(existsSync(readmeFile) ? readFileSync(readmeFile, "utf8") : `# ${section.module.name}\n`, render(section)));
}
outputs.set(join(example, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const drifted = [...outputs].filter(([file, content]) => !existsSync(file) || readFileSync(file, "utf8") !== content).map(([file]) => file.slice(workspace.length + 1));
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
