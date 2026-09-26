import type { Delivery, ExplainGraph, GraphPipeline, GraphStep } from "./graph.ts";

function deliveryText(delivery: Delivery): string {
  if (delivery.mode === "queue") return `queue · lane ${delivery.lane ?? "main"}${delivery.relayed === true ? " · relayed" : ""}`;
  return delivery.mode;
}

function triggerText(pipeline: GraphPipeline): string {
  const parts = [...pipeline.triggers.http.map((t) => `${t.method} ${t.path}`), ...pipeline.triggers.events.map((e) => `on ${e}`), ...pipeline.triggers.crons.map((c) => `cron ${c}`)];
  return parts.join(", ");
}

function stepLine(step: GraphStep, relayTargets: readonly string[]): string {
  const label = `${step.atomic === undefined ? "" : `[atomic ${step.atomic}] `}${step.spec}`;
  const details: string[] = [];
  if (step.reads.length > 0) details.push(`reads ${step.reads.join(", ")}`);
  if (step.writes.length > 0) details.push(`writes ${step.writes.join(", ")}`);
  if (step.emits !== undefined) details.push(`→ ${step.emits}`);
  if (step.relay === true) details.push(relayTargets.length === 0 ? "relays in the request" : `relays in the request: ${relayTargets.join(", ")}`);
  return `  ${String(step.index).padStart(2)}  ${label.padEnd(36)} ${(step.module ?? "").padEnd(18)} ${details.join("   ")}`.trimEnd();
}

/** The human-readable form of an explain graph: each pipeline with its steps, then the events it emits and their listeners, indented by depth. */
export function renderText(graph: ExplainGraph): string {
  const pipelines = new Map(graph.pipelines.map((p) => [p.name, p]));
  const events = new Map(graph.events.map((e) => [e.name, e]));
  const lines: string[] = [];
  const printed = new Set<string>();
  const relayTargets = (pipeline: GraphPipeline): string[] =>
    pipeline.steps
      .flatMap((s) => (s.emits === undefined ? [] : (events.get(s.emits)?.listeners ?? [])))
      .filter((l) => l.delivery.mode === "queue" && l.delivery.relayed === true)
      .map((l) => l.pipeline);

  const printPipeline = (name: string, indent: string, path: readonly string[]): void => {
    const pipeline = pipelines.get(name);
    if (pipeline === undefined) return;
    if (printed.has(name)) {
      lines.push(`${indent}(${name}, see above)`);
      return;
    }
    printed.add(name);
    lines.push(`${indent}${name}  ${triggerText(pipeline)}${pipeline.checked ? "" : `  (not checked: ${pipeline.because ?? ""})`}`.trimEnd());
    const targets = relayTargets(pipeline);
    for (const step of pipeline.steps) lines.push(`${indent}${stepLine(step, targets)}`);
    for (const m of pipeline.moduleEmits) lines.push(`${indent}  may emit (${m.module}): ${m.events.join(", ")}`);
    const emitted = [...new Set([...pipeline.steps.flatMap((s) => (s.emits === undefined ? [] : [s.emits])), ...pipeline.moduleEmits.flatMap((m) => m.events)])];
    for (const event of emitted) printEvent(event, `${indent}  `, [...path, name]);
  };

  const printEvent = (name: string, indent: string, path: readonly string[]): void => {
    const event = events.get(name);
    if (event === undefined) return;
    lines.push(`${indent}${name}`);
    if (event.listeners.length === 0) lines.push(`${indent}  (no listener)`);
    for (const listener of event.listeners) {
      const cycle = path.includes(listener.pipeline);
      lines.push(`${indent}  → ${listener.pipeline.padEnd(20)} ${deliveryText(listener.delivery)}${cycle ? " · cycle" : ""}`);
      if (!cycle && pipelines.has(listener.pipeline)) printPipeline(listener.pipeline, `${indent}      `, path);
    }
  };

  if (graph.root.kind === "pipeline") printPipeline(graph.root.name, "", []);
  else {
    const event = events.get(graph.root.name);
    lines.push(`event ${graph.root.name}`);
    for (const sender of event?.emittedBy ?? []) lines.push("pipeline" in sender ? `  emitted by ${sender.pipeline} (step ${sender.step})` : `  may be emitted by module ${sender.module}`);
    printEvent(graph.root.name, "", []);
  }
  lines.push(`delivery: ${graph.delivery.mode}${graph.delivery.provider === null ? "" : ` (${graph.delivery.provider})`}`);
  return lines.join("\n");
}
