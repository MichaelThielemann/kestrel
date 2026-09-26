import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { ExplainGraph } from "../src/inspect/graph.ts";
import { copyProject, FIXTURES, removeDir, runCli } from "./harness.ts";

const FIXTURE = join(FIXTURES, "explain-queue");
const CONSENT = ["--run-setup", "./modules/things.ts"];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

async function explainJson(root: string, args: readonly string[]): Promise<ExplainGraph> {
  const result = await runCli(["explain", ...args, "--json", "--root", root, ...CONSENT]);
  expect(result.code).toBe(0);
  return boundaryCast<ExplainGraph>(JSON.parse(result.stdout), "json");
}

function withConfig(label: string, replace: (source: string) => string): string {
  const dir = copyProject(FIXTURE, label);
  dirs.push(dir);
  const file = join(dir, "kestrel.config.ts");
  writeFileSync(file, replace(readFileSync(file, "utf8")));
  return dir;
}

describe("kestrel explain", { timeout: 60_000 }, () => {
  it("shows the atomic group, the emitted event, the relay and each listener's queue delivery, marking the back edge as a cycle", async () => {
    const graph = await explainJson(FIXTURE, ["makeThing"]);
    expect(graph.root).toEqual({ kind: "pipeline", name: "makeThing" });
    expect(graph.delivery).toEqual({ provider: "events/queue", mode: "queue" });
    const make = graph.pipelines.find((p) => p.name === "makeThing");
    expect(make?.triggers.http).toEqual([{ method: "POST", path: "/things" }]);
    expect(make?.steps.map((s) => [s.index, s.spec, s.atomic ?? null, s.emits ?? null, s.relay ?? null])).toEqual([
      [1, "things.create", 1, null, null],
      [2, "events.emit:thing.done", 1, "thing.done", null],
      [3, "events.relay", null, null, true],
    ]);
    expect(make?.steps[0]).toMatchObject({ module: "things/local", reads: ["payload"], writes: ["result"], summary: "creates a thing" });
    const event = graph.events.find((e) => e.name === "thing.done");
    expect(event?.listeners).toEqual([
      { pipeline: "onA", delivery: { mode: "queue", lane: "main", relayed: true } },
      { pipeline: "onB", delivery: { mode: "queue", lane: "slow", relayed: false }, cycle: true },
    ]);
    expect(graph.pipelines.map((p) => p.name)).toEqual(["makeThing", "onA", "onB"]);

    const text = await runCli(["explain", "makeThing", "--root", FIXTURE, ...CONSENT]);
    expect(text.stdout).toContain("[atomic 1] things.create");
    expect(text.stdout).toContain("relays in the request: onA");
    expect(text.stdout).toContain("→ onB                  queue · lane slow · cycle");
    const chart = await runCli(["explain", "makeThing", "--mermaid", "--root", FIXTURE, ...CONSENT]);
    expect(chart.stdout.startsWith("flowchart LR")).toBe(true);
  });

  it("reads the queue's lanes and relayed pipelines from the effective config, defaults included", async () => {
    const dir = withConfig("explain-defaults", (source) => source.replace('config: { lanes: { slow: ["onB"] }, relayPipelines: ["onA"] }', "config: {}"));
    const graph = await explainJson(dir, ["makeThing"]);
    expect(graph.events.find((e) => e.name === "thing.done")?.listeners.map((l) => l.delivery)).toEqual([
      { mode: "queue", lane: "main", relayed: true },
      { mode: "queue", lane: "main", relayed: true },
    ]);
  });

  it("lists the senders and listeners of an event", async () => {
    const graph = await explainJson(FIXTURE, ["--event", "thing.done"]);
    expect(graph.root).toEqual({ kind: "event", name: "thing.done" });
    const event = graph.events.find((e) => e.name === "thing.done");
    expect(event?.emittedBy).toEqual([
      { pipeline: "makeThing", step: 2 },
      { pipeline: "onB", step: 2 },
    ]);
    expect(event?.listeners.map((l) => l.pipeline)).toEqual(["onA", "onB"]);
  });

  it("exits 2 for an unknown pipeline and names close matches", async () => {
    const result = await runCli(["explain", "makeThin", "--root", FIXTURE, ...CONSENT]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown pipeline "makeThin"; did you mean "makeThing"?');
  });

  it("reports direct delivery with events-direct", async () => {
    const dir = withConfig("explain-direct", (source) => source.replace('{ use: "@michaelthielemann/kestrel-events-queue", config: { lanes: { slow: ["onB"] }, relayPipelines: ["onA"] } }', '{ use: "@michaelthielemann/kestrel-events-direct", config: {} }'));
    writeFileSync(join(dir, "package.json"), readFileSync(join(dir, "package.json"), "utf8").replace("kestrel-events-queue", "kestrel-events-direct"));
    const graph = await explainJson(dir, ["makeThing"]);
    expect(graph.delivery).toEqual({ provider: "events/direct", mode: "direct" });
    expect(graph.events[0]?.listeners[0]?.delivery).toEqual({ mode: "direct" });
  });

  it("still explains a pipeline whose module was not set up, from its raw steps", async () => {
    const result = await runCli(["explain", "makeThing", "--json", "--root", FIXTURE]);
    expect(result.code).toBe(0);
    const graph = boundaryCast<ExplainGraph>(JSON.parse(result.stdout), "json");
    expect(graph.pipelines[0]).toMatchObject({ name: "makeThing", checked: false });
    expect(graph.pipelines[0]?.steps.map((s) => s.spec)).toEqual(["things.create", "events.emit:thing.done", "events.relay"]);
    expect(result.stderr).toContain("unchecked");
  });
});
