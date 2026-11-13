import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Manifest } from "@michaelthielemann/kestrel";
import { loadConfig, loadPipelines } from "@michaelthielemann/kestrel/load";
import { buildGraph } from "../src/inspect/graph.ts";
import { renderMermaid } from "../src/inspect/mermaid.ts";
import { FIXTURES, MINIMAL, runCli } from "./harness.ts";

const dom = new JSDOM("");
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
const { default: mermaid } = await import("mermaid");

async function manifestOf(root: string, extra: readonly string[] = []): Promise<Manifest> {
  const result = await runCli(["manifest", "--json", "--root", root, ...extra]);
  expect(result.code).toBe(0);
  return boundaryCast<Manifest>(JSON.parse(result.stdout), "json");
}

async function diagrams(root: string, extra: readonly string[] = []): Promise<string[]> {
  const manifest = await manifestOf(root, extra);
  const config = await loadConfig(join(root, "kestrel.config.ts"));
  const pipelines = await loadPipelines(root, config.pipelinesDir ?? "./pipelines");
  return pipelines.map((p) => {
    const built = buildGraph({ manifest, pipelines, triggers: config.triggers, problems: [], notChecked: [] }, { kind: "pipeline", name: p.name }, 4);
    if (!built.ok) throw new Error(built.message);
    return renderMermaid(built.graph);
  });
}

describe("kestrel explain --mermaid", { timeout: 120_000 }, () => {
  it("renders a flowchart mermaid accepts for the queue fixture", async () => {
    const charts = await diagrams(join(FIXTURES, "explain-queue"), ["--run-setup", "./modules/things.ts"]);
    expect(charts.length).toBe(3);
    for (const chart of charts) {
      expect(chart.startsWith("flowchart LR")).toBe(true);
      await expect(mermaid.parse(chart)).resolves.toBeTruthy();
    }
    expect(charts.join("\n")).toContain("-.->");
    await expect(mermaid.parse("flowchart LR\n  a[\"x\"] -->|")).rejects.toThrow();
  });

  it("renders a flowchart mermaid accepts for every pipeline of the minimal example", async () => {
    const charts = await diagrams(MINIMAL);
    expect(charts.length).toBeGreaterThan(20);
    for (const chart of charts) await expect(mermaid.parse(chart)).resolves.toBeTruthy();
  });
});
