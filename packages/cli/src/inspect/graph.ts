import type { BootProblem, Manifest, NotChecked, PipelineDefinition } from "@michaelthielemann/kestrel";

export type DeliveryMode = "direct" | "queue" | "unknown" | "none";

export interface Delivery {
  mode: DeliveryMode;
  lane?: string;
  relayed?: boolean;
}

export interface GraphStep {
  index: number;
  spec: string;
  name: string;
  module: string | null;
  atomic?: number;
  reads: string[];
  writes: string[];
  summary: string;
  emits?: string;
  relay?: true;
}

export interface GraphPipeline {
  name: string;
  checked: boolean;
  because?: string;
  triggers: { http: { method: string; path: string }[]; events: string[]; crons: string[] };
  steps: GraphStep[];
  moduleEmits: { module: string; events: string[] }[];
}

export type Sender = { pipeline: string; step: number } | { module: string };

export interface GraphListener {
  pipeline: string;
  delivery: Delivery;
  cycle?: true;
}

export interface GraphEvent {
  name: string;
  emittedBy: Sender[];
  listeners: GraphListener[];
}

/** `kestrel explain --json`, `schema: 1`. */
export interface ExplainGraph {
  schema: 1;
  root: { kind: "pipeline" | "event"; name: string };
  delivery: { provider: string | null; mode: DeliveryMode };
  pipelines: GraphPipeline[];
  events: GraphEvent[];
  problems: BootProblem[];
  notChecked: NotChecked[];
}

export interface GraphInput {
  manifest: Manifest | undefined;
  pipelines: readonly PipelineDefinition[];
  triggers: readonly ({ http: string; pipeline: string } | { event: string; pipeline: string } | { cron: string; pipeline: string })[];
  problems: readonly BootProblem[];
  notChecked: readonly NotChecked[];
}

const EMIT = "events.emit";
const RELAY = "events.relay";

interface Provider {
  name: string | null;
  mode: DeliveryMode;
  lanes: Record<string, readonly string[]>;
  relayPipelines: "all" | readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function deliveryProvider(manifest: Manifest | undefined): Provider {
  const hook = manifest?.modules.find((m) => m.eventHook);
  if (hook === undefined) return { name: null, mode: "none", lanes: {}, relayPipelines: "all" };
  if (hook.name === "events/direct") return { name: hook.name, mode: "direct", lanes: {}, relayPipelines: "all" };
  if (hook.name !== "events/queue") return { name: hook.name, mode: "unknown", lanes: {}, relayPipelines: "all" };
  const value = (path: string): unknown => hook.config.variables.find((v) => v.path === path)?.value;
  const rawLanes = value("lanes");
  const lanes: Record<string, readonly string[]> = {};
  if (isRecord(rawLanes)) for (const [lane, names] of Object.entries(rawLanes)) lanes[lane] = stringList(names);
  const rawRelay = value("relayPipelines");
  return { name: hook.name, mode: "queue", lanes, relayPipelines: Array.isArray(rawRelay) ? stringList(rawRelay) : "all" };
}

function deliveryFor(provider: Provider, pipeline: string): Delivery {
  if (provider.mode !== "queue") return { mode: provider.mode };
  const lane = Object.entries(provider.lanes).find(([, names]) => names.includes(pipeline))?.[0] ?? "main";
  const relayed = provider.relayPipelines === "all" || provider.relayPipelines.includes(pipeline);
  return { mode: "queue", lane, relayed };
}

function emittedEvent(spec: string): string | undefined {
  const colon = spec.indexOf(":");
  if (colon === -1 || spec.slice(0, colon) !== EMIT) return undefined;
  const event = spec.slice(colon + 1);
  return event === "" ? undefined : event;
}

function stepName(spec: string): string {
  const colon = spec.indexOf(":");
  return colon === -1 ? spec : spec.slice(0, colon);
}

function rawSteps(def: PipelineDefinition): { spec: string; atomic?: number }[] {
  const out: { spec: string; atomic?: number }[] = [];
  let group = 0;
  for (const entry of def.steps) {
    if (typeof entry === "string") out.push({ spec: entry });
    else {
      group++;
      for (const spec of entry.atomic) out.push({ spec, atomic: group });
    }
  }
  return out;
}

class GraphBuilder {
  private readonly provider: Provider;
  private readonly checked = new Map<string, Manifest["pipelines"][number]>();
  private readonly raw = new Map<string, PipelineDefinition>();
  private readonly nodes = new Map<string, GraphPipeline>();
  private readonly reached = new Set<string>();
  private readonly events = new Map<string, GraphEvent>();

  private readonly input: GraphInput;

  constructor(input: GraphInput) {
    this.input = input;
    this.provider = deliveryProvider(input.manifest);
    for (const p of input.manifest?.pipelines ?? []) this.checked.set(p.name, p);
    for (const p of input.pipelines) this.raw.set(p.name, p);
  }

  pipelineNames(): string[] {
    return [...new Set([...this.checked.keys(), ...this.raw.keys()])].sort();
  }

  eventNames(): string[] {
    const names = new Set<string>();
    for (const name of this.pipelineNames()) for (const event of this.pipelineEvents(this.pipeline(name))) names.add(event);
    for (const t of this.input.triggers) if ("event" in t) names.add(t.event);
    for (const m of this.input.manifest?.modules ?? []) for (const event of m.emits) names.add(event);
    return [...names].sort();
  }

  private triggersOf(name: string): GraphPipeline["triggers"] {
    const manifest = this.input.manifest?.triggers;
    const http: { method: string; path: string }[] = [];
    const events: string[] = [];
    const crons: string[] = [];
    if (manifest !== undefined && this.checked.has(name)) {
      for (const t of manifest.http) if (t.pipeline === name) http.push({ method: t.method, path: t.path });
      for (const t of manifest.events) if (t.pipeline === name) events.push(t.event);
      for (const t of manifest.crons) if (t.pipeline === name) crons.push(t.expression);
    } else {
      for (const t of this.input.triggers) {
        if (t.pipeline !== name) continue;
        if ("http" in t) {
          const [method = "", path = ""] = t.http.split(/\s+/, 2);
          http.push({ method, path });
        } else if ("event" in t) events.push(t.event);
        else crons.push(t.cron);
      }
    }
    return { http, events, crons };
  }

  pipeline(name: string): GraphPipeline {
    const existing = this.nodes.get(name);
    if (existing !== undefined) return existing;
    const manifest = this.checked.get(name);
    let node: GraphPipeline;
    if (manifest !== undefined) {
      const steps = manifest.steps.map((step, i): GraphStep => {
        const emits = emittedEvent(step.spec);
        return {
          index: i + 1,
          spec: step.spec,
          name: step.name,
          module: step.module,
          ...(step.atomic === undefined ? {} : { atomic: step.atomic }),
          reads: [...step.description.reads],
          writes: [...step.description.writes],
          summary: step.description.summary,
          ...(emits === undefined ? {} : { emits }),
          ...(stepName(step.spec) === RELAY ? { relay: true as const } : {}),
        };
      });
      const owners = [...new Set(manifest.steps.map((s) => s.module))];
      const moduleEmits = owners.flatMap((owner) => {
        const events = this.input.manifest?.modules.find((m) => m.name === owner)?.emits ?? [];
        return events.length === 0 ? [] : [{ module: owner, events: [...events] }];
      });
      node = { name, checked: true, triggers: this.triggersOf(name), steps, moduleEmits };
    } else {
      const def = this.raw.get(name);
      const because = this.input.notChecked.find((n) => n.kind === "pipeline" && n.name === name)?.because ?? "it was not checked";
      const steps = (def === undefined ? [] : rawSteps(def)).map((step, i): GraphStep => {
        const emits = emittedEvent(step.spec);
        return {
          index: i + 1,
          spec: step.spec,
          name: stepName(step.spec),
          module: null,
          ...(step.atomic === undefined ? {} : { atomic: step.atomic }),
          reads: [],
          writes: [],
          summary: "",
          ...(emits === undefined ? {} : { emits }),
          ...(stepName(step.spec) === RELAY ? { relay: true as const } : {}),
        };
      });
      node = { name, checked: false, because, triggers: this.triggersOf(name), steps, moduleEmits: [] };
    }
    this.nodes.set(name, node);
    return node;
  }

  private pipelineEvents(node: GraphPipeline): string[] {
    const events: string[] = [];
    for (const step of node.steps) if (step.emits !== undefined && !events.includes(step.emits)) events.push(step.emits);
    for (const m of node.moduleEmits) for (const event of m.events) if (!events.includes(event)) events.push(event);
    return events;
  }

  private listenersOf(event: string): string[] {
    const listeners: string[] = [];
    const add = (pipeline: string): void => {
      if (!listeners.includes(pipeline)) listeners.push(pipeline);
    };
    for (const t of this.input.manifest?.triggers.events ?? []) if (t.event === event) add(t.pipeline);
    for (const t of this.input.triggers) if ("event" in t && t.event === event) add(t.pipeline);
    return listeners;
  }

  private sendersOf(event: string): Sender[] {
    const senders: Sender[] = [];
    for (const name of this.pipelineNames()) {
      for (const step of this.pipeline(name).steps) if (step.emits === event) senders.push({ pipeline: name, step: step.index });
    }
    for (const m of this.input.manifest?.modules ?? []) if (m.emits.includes(event)) senders.push({ module: m.name });
    return senders;
  }

  private event(name: string): GraphEvent {
    const existing = this.events.get(name);
    if (existing !== undefined) return existing;
    const node: GraphEvent = { name, emittedBy: this.sendersOf(name), listeners: this.listenersOf(name).map((pipeline) => ({ pipeline, delivery: deliveryFor(this.provider, pipeline) })) };
    this.events.set(name, node);
    return node;
  }

  private visitEvent(name: string, path: readonly string[], depth: number, maxDepth: number): void {
    const node = this.event(name);
    if (depth >= maxDepth) return;
    for (const listener of node.listeners) {
      if (path.includes(listener.pipeline)) {
        listener.cycle = true;
        continue;
      }
      const seen = this.reached.has(listener.pipeline);
      this.reach(listener.pipeline);
      if (!seen) this.visitPipeline(listener.pipeline, [...path, listener.pipeline], depth + 1, maxDepth);
    }
  }

  reach(name: string): void {
    this.pipeline(name);
    this.reached.add(name);
  }

  visitPipeline(name: string, path: readonly string[], depth: number, maxDepth: number): void {
    for (const event of this.pipelineEvents(this.pipeline(name))) this.visitEvent(event, path, depth, maxDepth);
  }

  startEvent(name: string, maxDepth: number): void {
    this.visitEvent(name, [], 0, maxDepth);
  }

  result(root: ExplainGraph["root"]): ExplainGraph {
    return {
      schema: 1,
      root,
      delivery: { provider: this.provider.name, mode: this.provider.mode },
      pipelines: [...this.reached].map((name) => this.pipeline(name)),
      events: [...this.events.values()],
      problems: [...this.input.problems],
      notChecked: [...this.input.notChecked],
    };
  }
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** Up to three names closest to `query`: containing it, or within a small edit distance. */
export function closeMatches(query: string, names: readonly string[]): string[] {
  const lower = query.toLowerCase();
  return names
    .map((name) => ({ name, score: name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase()) ? 0 : distance(lower, name.toLowerCase()) }))
    .filter((c) => c.score <= Math.max(2, Math.floor(query.length / 3)))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((c) => c.name);
}

export type GraphResult = { ok: true; graph: ExplainGraph } | { ok: false; message: string };

/** Builds the explain graph for one pipeline or one event, following listeners up to `depth` levels. */
export function buildGraph(input: GraphInput, root: ExplainGraph["root"], depth: number): GraphResult {
  const builder = new GraphBuilder(input);
  const known = root.kind === "pipeline" ? builder.pipelineNames() : builder.eventNames();
  if (!known.includes(root.name)) {
    const close = closeMatches(root.name, known);
    return { ok: false, message: `unknown ${root.kind} "${root.name}"${close.length === 0 ? "" : `; did you mean ${close.map((n) => `"${n}"`).join(", ")}?`}` };
  }
  if (root.kind === "pipeline") {
    builder.reach(root.name);
    builder.visitPipeline(root.name, [root.name], 0, depth);
  } else builder.startEvent(root.name, depth);
  return { ok: true, graph: builder.result(root) };
}
