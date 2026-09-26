import type { Delivery, ExplainGraph } from "./graph.ts";

function label(text: string): string {
  return `"${text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`;
}

function edgeLabel(delivery: Delivery): string {
  if (delivery.mode === "queue") return `queue · lane ${delivery.lane ?? "main"}${delivery.relayed === true ? " · relayed" : ""}`;
  return delivery.mode;
}

/** A Mermaid `flowchart LR` of an explain graph: one subgraph per pipeline, atomic groups nested, events as hexagons. */
export function renderMermaid(graph: ExplainGraph): string {
  const lines = ["flowchart LR"];
  const firstStep = new Map<string, string>();
  const stepIds = new Map<string, Map<number, string>>();
  graph.pipelines.forEach((pipeline, p) => {
    lines.push(`  subgraph p${p}[${label(pipeline.name)}]`);
    lines.push("    direction TB");
    const ids = new Map<number, string>();
    let group: number | undefined;
    for (const step of pipeline.steps) {
      if (step.atomic !== group) {
        if (group !== undefined) lines.push("    end");
        if (step.atomic !== undefined) lines.push(`    subgraph p${p}a${step.atomic}[${label(`atomic ${step.atomic}`)}]`);
        group = step.atomic;
      }
      const id = `p${p}s${step.index}`;
      ids.set(step.index, id);
      lines.push(`    ${id}[${label(`${step.index} ${step.spec}`)}]`);
    }
    if (group !== undefined) lines.push("    end");
    const stepList = pipeline.steps.map((s) => ids.get(s.index)!);
    for (let i = 1; i < stepList.length; i++) lines.push(`    ${stepList[i - 1]!} --> ${stepList[i]!}`);
    lines.push("  end");
    if (stepList[0] !== undefined) firstStep.set(pipeline.name, stepList[0]);
    stepIds.set(pipeline.name, ids);
  });
  graph.events.forEach((event, e) => {
    const id = `e${e}`;
    lines.push(`  ${id}{{${label(event.name)}}}`);
    graph.pipelines.forEach((pipeline) => {
      for (const step of pipeline.steps) if (step.emits === event.name) lines.push(`  ${stepIds.get(pipeline.name)?.get(step.index) ?? ""} --> ${id}`);
    });
    for (const listener of event.listeners) {
      const target = firstStep.get(listener.pipeline);
      if (target === undefined) continue;
      const arrow = listener.cycle === true ? "-.->" : "-->";
      lines.push(`  ${id} ${arrow}|${label(edgeLabel(listener.delivery))}| ${target}`);
    }
  });
  return lines.join("\n");
}
