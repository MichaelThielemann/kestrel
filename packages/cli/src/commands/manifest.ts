import type { Manifest } from "@michaelthielemann/kestrel";
import { parseStrict } from "../args.ts";
import { renderTable } from "../inspect/table.ts";
import { inspectProject } from "../inspectProject.ts";
import { COMMAND_USAGE } from "../usage.ts";

function fail(message: string): number {
  process.stderr.write(`kestrel manifest: ${message}\n\n${COMMAND_USAGE.manifest ?? ""}\n`);
  return 2;
}

function markSandboxed(manifest: Manifest, rewritten: readonly string[]): Manifest {
  return {
    ...manifest,
    modules: manifest.modules.map((m) => (rewritten.includes(m.use) ? { ...m, config: { ...m.config, variables: m.config.variables.map((v) => ({ ...v, sandboxed: true })) } } : m)),
  };
}

function renderHuman(manifest: Manifest): string {
  const sections: string[] = [];
  sections.push(
    "modules\n" +
      renderTable(
        ["name", "use", "version", "provides", "requires", "steps", "event hook"],
        manifest.modules.map((m) => [m.name, m.use, m.version ?? "", m.provides.join(", "), m.requires.join(", "), String(m.steps.length), m.eventHook ? "yes" : ""]),
      ),
  );
  sections.push(`contracts\n${manifest.contracts.join("\n")}`);
  const triggersOf = (name: string): string =>
    [...manifest.triggers.http.filter((t) => t.pipeline === name).map((t) => `${t.method} ${t.path}`), ...manifest.triggers.events.filter((t) => t.pipeline === name).map((t) => `on ${t.event}`), ...manifest.triggers.crons.filter((t) => t.pipeline === name).map((t) => `cron ${t.expression}`)].join(", ");
  sections.push("pipelines\n" + renderTable(["name", "steps", "triggers"], manifest.pipelines.map((p) => [p.name, String(p.steps.length), triggersOf(p.name)])));
  sections.push("http routes\n" + renderTable(["method", "path", "pipeline"], manifest.triggers.http.map((t) => [t.method, t.path, t.pipeline])));
  sections.push("event triggers\n" + renderTable(["event", "pipeline"], manifest.triggers.events.map((t) => [t.event, t.pipeline])));
  sections.push("crons\n" + renderTable(["expression", "pipeline"], manifest.triggers.crons.map((t) => [t.expression, t.pipeline])));
  sections.push("warnings\n" + (manifest.warnings.length === 0 ? "none" : manifest.warnings.map((w) => `${w.code}: ${w.message}`).join("\n")));
  return sections.join("\n\n");
}

/** `kestrel manifest`: the project's modules, contracts, pipelines and triggers as its boot check describes them. */
export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseStrict(argv, { json: "boolean", root: "string", "run-setup": "repeat", "no-plugins": "boolean" }, 0);
  if (!parsed.ok) return fail(parsed.error);
  const { args } = parsed;
  const result = await inspectProject({ root: args.strings.get("root") ?? ".", runSetup: args.repeated.get("run-setup") ?? [], noPlugins: args.booleans.has("no-plugins") });
  if (!result.ok) {
    process.stderr.write(`kestrel manifest: ${result.kind === "refused" ? result.message : result.outdated.map((o) => o.message).join("\n")}\n`);
    return 2;
  }
  const { prepared, bootCheck } = result.value;
  const manifest = bootCheck?.manifest;
  if (manifest === undefined) {
    process.stderr.write(`kestrel manifest: the project did not load far enough to describe it\n${prepared.issues.map((i) => `  ${i.file ?? i.use ?? ""}: ${i.message}`).join("\n")}\n`);
    return 2;
  }
  const marked = markSandboxed(manifest, prepared.box?.rewritten ?? []);
  process.stdout.write(`${args.booleans.has("json") ? JSON.stringify(marked, null, 2) : renderHuman(marked)}\n`);
  return 0;
}
