import type { BootWarning, JsonSchema, Logger, Manifest, ModuleManifest, StepDescription, StepManifest, UndeclaredOutputWarning, UndeclaredRequiredWarning, UnemittedEventWarning } from "../packages/core/src/index.ts";
import { STEP_SETS } from "../packages/contracts/src/steps.ts";

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

/** Whether a step is a member of a declared {@link STEP_SETS} step set (portable), only under a governed prefix (beside), or under no governed prefix at all (none). */
export function portabilityOf(name: string): "portable" | "beside" | "none" {
  const dot = name.indexOf(".");
  const prefix = dot === -1 ? name : name.slice(0, dot);
  for (const set of STEP_SETS) {
    if (set.prefix !== prefix) continue;
    return set.steps.includes(name) ? "portable" : "beside";
  }
  return "none";
}

export function stepTable(steps: StepManifest[]): string[] {
  if (steps.length === 0) return [];
  const rows = steps.map((s) => {
    const name = `\`${s.name}${s.factory ? ":<arg>" : ""}\``;
    const d = s.description;
    const paths = (list: readonly string[]) => (list.length === 0 ? "–" : list.map((p) => `\`${p}\``).join(", "));
    const portable = portabilityOf(s.name);
    return `| ${name} | ${cell(d.summary)} | ${paths(d.reads)} | ${paths(d.writes)} | ${cell(inputCell(d))} | ${cell(brief(d.output ?? d.extendsOutput ?? d.extendsItems))} | ${cell(errors(d)) || "–"} | ${portable === "none" ? "–" : portable} | ${d.atomicSafe === true ? "yes" : "no"} |`;
  });
  return ["| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |", "|---|---|---|---|---|---|---|---|---|", ...rows, ""];
}

/** Folds a flat, ordered step list into an arrow chain: consecutive steps sharing the same `atomic` ordinal render as one `[ a → b → c ]` segment. */
export function groupedArrowChain<S extends { atomic?: number }>(steps: readonly S[], render: (step: S) => string): string {
  const parts: string[] = [];
  let group: string[] | null = null;
  let ordinal: number | undefined;
  for (const step of steps) {
    if (step.atomic !== undefined && step.atomic === ordinal) {
      group!.push(render(step));
      continue;
    }
    if (group) parts.push(`[ ${group.join(" → ")} ]`);
    if (step.atomic === undefined) {
      group = null;
      ordinal = undefined;
      parts.push(render(step));
    } else {
      group = [render(step)];
      ordinal = step.atomic;
    }
  }
  if (group) parts.push(`[ ${group.join(" → ")} ]`);
  return parts.join(" → ");
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
  const lines = using.map((p) => `- **${p.name}** (${(routes.get(p.name) ?? ["no trigger"]).join(", ")}): ${groupedArrowChain(p.steps, (s) => (owned.has(s.name) ? `**\`${s.spec}\`**` : `\`${s.spec}\``))}`);
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

export type BootWarningKey = Pick<UnemittedEventWarning, "code" | "pipeline" | "event"> | Pick<UndeclaredOutputWarning, "code" | "pipeline" | "step"> | Pick<UndeclaredRequiredWarning, "code" | "pipeline" | "step" | "path">;

function bootWarningKey(warning: BootWarningKey): string {
  switch (warning.code) {
    case "unemitted-event":
      return `${warning.code}:${warning.pipeline}:${warning.event}`;
    case "undeclared-output":
      return `${warning.code}:${warning.pipeline}:${warning.step}`;
    case "undeclared-required":
      return `${warning.code}:${warning.pipeline}:${warning.step}:${warning.path}`;
    default: {
      const exhaustive: never = warning;
      return exhaustive;
    }
  }
}

export function unexpectedBootWarnings(warnings: readonly BootWarning[], allowlist: readonly BootWarningKey[]): BootWarning[] {
  const allowed = new Set(allowlist.map(bootWarningKey));
  return warnings.filter((warning) => !allowed.has(bootWarningKey(warning)));
}

export function formatBootWarning(warning: BootWarning): string {
  switch (warning.code) {
    case "unemitted-event":
      return `pipeline "${warning.pipeline}", event "${warning.event}": ${warning.message}`;
    case "undeclared-output":
      return `pipeline "${warning.pipeline}", step "${warning.step}": ${warning.message}`;
    case "undeclared-required":
      return `pipeline "${warning.pipeline}", step "${warning.step}", ${warning.path}: ${warning.message}`;
    default: {
      const exhaustive: never = warning;
      return exhaustive;
    }
  }
}

export interface LogEntry {
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export function collectingLogger(entries: LogEntry[]): Logger {
  return {
    step() {},
    info(message, data) {
      entries.push(data === undefined ? { level: "info", message } : { level: "info", message, data });
    },
    warn(message, data) {
      entries.push(data === undefined ? { level: "warn", message } : { level: "warn", message, data });
    },
    error(message, data) {
      entries.push(data === undefined ? { level: "error", message } : { level: "error", message, data });
    },
  };
}

function matchesBootWarning(entry: LogEntry, warning: BootWarning): boolean {
  switch (warning.code) {
    case "unemitted-event":
      return entry.message === warning.message && entry.data?.pipeline === warning.pipeline && entry.data?.event === warning.event;
    case "undeclared-output":
      return entry.message === warning.message && entry.data?.pipeline === warning.pipeline && entry.data?.step === warning.step;
    case "undeclared-required":
      return entry.message === warning.message && entry.data?.pipeline === warning.pipeline && entry.data?.step === warning.step && entry.data?.path === warning.path;
    default: {
      const exhaustive: never = warning;
      return exhaustive;
    }
  }
}

/**
 * Warn- or error-level entries from a boot's logger that are not already accounted for by one of
 * `bootWarnings` (a `kestrel.warnings` entry is also logged through `logger.warn`, so it is
 * matched off here rather than reported a second time).
 */
export function unexpectedLogEntries(entries: readonly LogEntry[], bootWarnings: readonly BootWarning[]): LogEntry[] {
  const remaining = [...bootWarnings];
  const unexpected: LogEntry[] = [];
  for (const entry of entries) {
    if (entry.level !== "warn" && entry.level !== "error") continue;
    const index = remaining.findIndex((warning) => matchesBootWarning(entry, warning));
    if (index === -1) unexpected.push(entry);
    else remaining.splice(index, 1);
  }
  return unexpected;
}
