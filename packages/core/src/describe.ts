import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Triggers } from "./boot.ts";
import { boundaryCast } from "./cast.ts";
import type { JsonSchema, ModuleDefinition, StepDescription } from "./defineModule.ts";
import { PLACEHOLDER_ARG, type StepRegistry } from "./registry.ts";
import type { ResolvedPipeline } from "./runner.ts";
import { VERSION } from "./version.ts";
import { describeConfig, type ConfigVariable } from "./zodSchema.ts";

export type { ConfigStatus, ConfigVariable } from "./zodSchema.ts";
export { PLACEHOLDER_ARG } from "./registry.ts";

export interface ModuleManifest {
  name: string;
  use: string;
  version: string | null;
  provides: string[];
  requires: string[];
  optional: string[];
  config: { schema: JsonSchema; variables: ConfigVariable[] };
  steps: string[];
  eventHook: boolean;
  emits: string[];
}

export interface StepManifest {
  name: string;
  module: string;
  factory: boolean;
  description: StepDescription;
}

export interface PipelineStepManifest {
  spec: string;
  name: string;
  module: string;
  description: StepDescription;
}

export interface PipelineManifest {
  name: string;
  steps: PipelineStepManifest[];
}

export interface TriggersManifest {
  http: { method: string; path: string; pipeline: string }[];
  events: { event: string; pipeline: string }[];
  crons: { expression: string; pipeline: string }[];
}

export interface Manifest {
  core: { version: string };
  contracts: string[];
  modules: ModuleManifest[];
  steps: StepManifest[];
  pipelines: PipelineManifest[];
  triggers: TriggersManifest;
}

export interface ManifestInput {
  root: string;
  modules: readonly ModuleDefinition[];
  uses: readonly string[];
  rawConfigs: ReadonlyMap<ModuleDefinition, unknown>;
  contracts: readonly string[];
  steps: StepRegistry;
  pipelines: ReadonlyMap<string, ResolvedPipeline>;
  triggers: Triggers;
}

export function coreVersion(): string {
  return VERSION;
}

function packageNameOf(use: string): string {
  const parts = use.split("/");
  return use.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? use);
}

/** Version of the package a `use` entry names, found by walking up from the resolved module file to the package.json carrying that name; null for path entries and anything unresolvable. */
export function packageVersion(root: string, use: string): string | null {
  if (use.startsWith("./") || use.startsWith("../") || isAbsolute(use)) return null;
  const name = packageNameOf(use);
  let file: string;
  try {
    file = createRequire(pathToFileURL(resolve(root, "package.json")).href).resolve(use);
  } catch {
    return null;
  }
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = boundaryCast<{ name?: unknown; version?: unknown }>(JSON.parse(readFileSync(candidate, "utf8")), "json");
        if (pkg.name === name) return typeof pkg.version === "string" ? pkg.version : null;
      } catch {
        return null;
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

function stepName(spec: string): string {
  const colon = spec.indexOf(":");
  return colon === -1 ? spec : spec.slice(0, colon);
}

export function buildManifest(input: ManifestInput): Manifest {
  const registered = input.steps.list();
  const modules = input.modules.map((mod, i): ModuleManifest => {
    const use = input.uses[i] ?? "";
    return {
      name: mod.name,
      use,
      version: packageVersion(input.root, use),
      provides: mod.provides.map((c) => c.name),
      requires: mod.requires.map((c) => c.name),
      optional: (mod.optional ?? []).map((c) => c.name),
      config: describeConfig(mod.configSchema, input.rawConfigs.get(mod)),
      steps: registered.filter((s) => s.owner === mod.name).map((s) => s.name),
      eventHook: mod.triggers?.event !== undefined,
      emits: [...(mod.emits ?? [])],
    };
  });
  const steps = registered.map((s): StepManifest => ({ name: s.name, module: s.owner, factory: s.factory, description: typeof s.describe === "function" ? s.describe(PLACEHOLDER_ARG) : s.describe }));
  const pipelines = [...input.pipelines.values()].map((p): PipelineManifest => ({
    name: p.name,
    steps: p.steps.map((s) => ({ spec: s.name, name: stepName(s.name), module: input.steps.owner(stepName(s.name)) ?? "", description: s.description })),
  }));
  return {
    core: { version: coreVersion() },
    contracts: [...input.contracts],
    modules,
    steps,
    pipelines,
    triggers: {
      http: input.triggers.http.map((r) => ({ method: r.method, path: `/${r.segments.join("/")}`, pipeline: r.pipeline })),
      events: input.triggers.events.map((e) => ({ event: e.event, pipeline: e.pipeline })),
      crons: input.triggers.crons.map((c) => ({ expression: c.expression, pipeline: c.pipeline })),
    },
  };
}
