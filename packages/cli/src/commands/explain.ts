import { parseStrict } from "../args.ts";
import { buildGraph } from "../inspect/graph.ts";
import { renderMermaid } from "../inspect/mermaid.ts";
import { renderText } from "../inspect/text.ts";
import { inspectProject } from "../inspectProject.ts";
import { COMMAND_USAGE } from "../usage.ts";

function fail(message: string): number {
  process.stderr.write(`kestrel explain: ${message}\n\n${COMMAND_USAGE.explain ?? ""}\n`);
  return 2;
}

/** `kestrel explain`: a pipeline's or an event's steps, emitted events, listeners and their delivery. */
export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseStrict(argv, { event: "string", json: "boolean", mermaid: "boolean", depth: "string", root: "string", "run-setup": "repeat", "no-plugins": "boolean" }, 1);
  if (!parsed.ok) return fail(parsed.error);
  const { args } = parsed;
  const event = args.strings.get("event");
  const pipeline = args.positionals[0];
  if ((event === undefined) === (pipeline === undefined)) return fail("name one pipeline, or one event with --event");
  if (args.booleans.has("json") && args.booleans.has("mermaid")) return fail("--json and --mermaid exclude each other");
  const depthText = args.strings.get("depth") ?? "4";
  const depth = Number(depthText);
  if (!Number.isInteger(depth) || depth < 0) return fail(`--depth takes a whole number, not "${depthText}"`);
  const result = await inspectProject({ root: args.strings.get("root") ?? ".", runSetup: args.repeated.get("run-setup") ?? [], noPlugins: args.booleans.has("no-plugins") });
  if (!result.ok) {
    process.stderr.write(`kestrel explain: ${result.kind === "refused" ? result.message : result.outdated.map((o) => o.message).join("\n")}\n`);
    return 2;
  }
  const { prepared, bootCheck } = result.value;
  if (prepared.project === undefined || bootCheck === undefined) {
    process.stderr.write(`kestrel explain: the project did not load\n${prepared.issues.map((i) => `  ${i.file ?? i.use ?? ""}: ${i.message}`).join("\n")}\n`);
    return 2;
  }
  const root = event === undefined ? { kind: "pipeline" as const, name: pipeline ?? "" } : { kind: "event" as const, name: event };
  const built = buildGraph({ manifest: bootCheck.manifest, pipelines: prepared.project.input.pipelines, triggers: prepared.project.input.config.triggers, problems: bootCheck.errors, notChecked: bootCheck.notChecked }, root, depth);
  if (!built.ok) {
    process.stderr.write(`kestrel explain: ${built.message}\n`);
    return 2;
  }
  const { graph } = built;
  const output = args.booleans.has("json") ? JSON.stringify(graph, null, 2) : args.booleans.has("mermaid") ? renderMermaid(graph) : renderText(graph);
  process.stdout.write(`${output}\n`);
  if (graph.problems.length > 0 || graph.notChecked.length > 0) process.stderr.write(`kestrel explain: the boot check found ${graph.problems.length} problem(s) and left ${graph.notChecked.length} item(s) unchecked; run kestrel check for details\n`);
  return 0;
}
