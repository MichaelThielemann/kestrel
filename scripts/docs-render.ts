import type { JsonSchema, Manifest, ModuleManifest, StepDescription, StepManifest } from "../packages/core/src/index.ts";

export const START = "<!-- kestrel-docs:start -->";
export const END = "<!-- kestrel-docs:end -->";
export const ROOT_ORDER = ["@michaelthielemann/kestrel", "@michaelthielemann/kestrel-contracts", "@michaelthielemann/kestrel-h3", "@michaelthielemann/kestrel-openapi"];
const MAX_LISTED_PIPELINES = 12;

export interface Section {
  module: ModuleManifest;
  steps: StepManifest[];
  manifest: Manifest | null;
}

export interface PackageInfo {
  name: string;
  description: string;
}

export function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function brief(schema: JsonSchema | undefined, depth = 0): string {
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

export function inputCell(description: StepDescription): string {
  const parts: string[] = [];
  if (description.input !== undefined) parts.push(brief(description.input));
  const entries = Object.entries(description.query ?? {});
  if (entries.length > 0) parts.push(`?${entries.map(([k, v]) => `${k}: ${brief(v, 1)}`).join(", ")}`);
  return parts.length === 0 ? "–" : parts.join(" ");
}

export function errors(description: StepDescription): string {
  return Object.entries(description.errors ?? {})
    .map(([status, text]) => `${status} ${text}`)
    .join("; ");
}

export function configTable(module: ModuleManifest): string[] {
  if (module.config.variables.length === 0) return ["Config: `{}` – nothing to set.", ""];
  const rows = module.config.variables.map((v) => `| \`${v.path}\` | ${v.type} | ${v.required ? "yes" : "no"} | ${v.secret ? "*(secret)*" : v.default === undefined ? "–" : `\`${cell(JSON.stringify(v.default))}\``} |`);
  return ["| Config | Type | Required | Default |", "|---|---|---|---|", ...rows, ""];
}

export function stepTable(steps: StepManifest[]): string[] {
  if (steps.length === 0) return [];
  const rows = steps.map((s) => {
    const name = `\`${s.name}${s.factory ? ":<arg>" : ""}\``;
    const d = s.description;
    const paths = (list: readonly string[]) => (list.length === 0 ? "–" : list.map((p) => `\`${p}\``).join(", "));
    return `| ${name} | ${cell(d.summary)} | ${paths(d.reads)} | ${paths(d.writes)} | ${cell(inputCell(d))} | ${cell(brief(d.output ?? d.extendsOutput ?? d.extendsItems))} | ${cell(errors(d)) || "–"} |`;
  });
  return ["| Step | Summary | Reads | Writes | Input | Output | Errors |", "|---|---|---|---|---|---|---|", ...rows, ""];
}

export function pipelineList(module: ModuleManifest, manifest: Manifest): string[] {
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

export function render(section: Section): string {
  const { module, steps, manifest } = section;
  const contracts = [`provides ${module.provides.length === 0 ? "no contract" : module.provides.map((c) => `\`${c}\``).join(", ")}`, module.requires.length === 0 ? "" : `requires ${module.requires.map((c) => `\`${c}\``).join(", ")}`, module.optional.length === 0 ? "" : `optional ${module.optional.map((c) => `\`${c}\``).join(", ")}`].filter(Boolean).join("; ");
  const lines = [START, "## Generated from the manifest", `\`${module.use}\` – module \`${module.name}\`: ${contracts}${module.eventHook ? "; provides the event trigger hook" : ""}.`, "", ...configTable(module), ...stepTable(steps), ...(manifest ? pipelineList(module, manifest) : []), END];
  return lines.join("\n");
}

export function splice(readme: string, generated: string, file: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) throw new Error(`${file}: missing ${START} / ${END} markers`);
  return `${readme.slice(0, start)}${generated}${readme.slice(end + END.length)}`;
}

export function orderPackages(packages: PackageInfo[]): PackageInfo[] {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const fixed = ROOT_ORDER.map((name) => {
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`root package table: expected package "${name}" not found under packages/`);
    return pkg;
  });
  const rest = packages.filter((p) => !ROOT_ORDER.includes(p.name)).sort((a, b) => a.name.localeCompare(b.name));
  return [...fixed, ...rest];
}

export function rootTable(packages: PackageInfo[]): string {
  const rows = packages.map((p) => `| \`${p.name}\` | ${cell(p.description)} |`);
  return [START, "| Package | Purpose |", "|---|---|", ...rows, END].join("\n");
}
