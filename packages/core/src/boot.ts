import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AtomicScope } from "./atomic.ts";
import { boundaryCast } from "./cast.ts";
import type { ContextInput, StepMap } from "./context.ts";
import { missingMethods, type Contract } from "./defineContract.ts";
import { checkDataflow, checkDataflowCollecting } from "./dataflow.ts";
import { configSchema, type KestrelConfig, type KestrelConfigInput } from "./defineConfig.ts";
import { stepPrefix, type ContractLookup, type Deps, type EventEntry, type InstanceHealth, type Introspection, type ModuleDefinition, type ModuleHealth, type StepDescription, type StepDescriptions } from "./defineModule.ts";
import { buildManifest, type Manifest } from "./describe.ts";
import { pipelineSteps, type PipelineDefinition } from "./definePipeline.ts";
import { resolveEntries } from "./resolveEntries.ts";
import { KestrelBootError } from "./errors.ts";
import { consoleLogger, logWarn, type Logger } from "./logger.ts";
import { createObserverHub } from "./observer.ts";
import { PLACEHOLDER_ARG, StepRegistry, type ResolvedStep, type Steps } from "./registry.ts";
import { findMissingRequired, resolveOutputSchema } from "./schema.ts";
import { ok } from "./result.ts";
import { createRunTracker, runPipeline, type ResolvedPipeline, type RunResult } from "./runner.ts";
import { collectSink, throwSink, type BootProblem, type Sink } from "./sink.ts";
import { CONTEXT_KEYS, satisfied, stripOptional, writeRoot } from "./writes.ts";
import { effectiveModuleConfig, type ConfigDefaults } from "./zodSchema.ts";
import { sortModules } from "./sort.ts";
import { createCronEntry, startCron, type CronEntry } from "./triggers/cron.ts";
import { createAllowlist } from "./triggers/allowlist.ts";
import { createHttpServer, listen, parseRoute, routePattern, type Route } from "./triggers/http.ts";

export type { BootProblem } from "./sink.ts";

export interface BootInput {
  config: KestrelConfigInput;
  modules: readonly ModuleDefinition[];
  pipelines: readonly PipelineDefinition[];
  logger?: Logger;
  root?: string;
  /** Dev/test only: after every step that writes to `result`, validates it against the pipeline's `describe().output` folded up to that step; a mismatch fails the run like a `writes` mismatch does. Off by default, so production pays nothing for it. */
  validateOutput?: boolean;
}

export interface Triggers {
  http: readonly Route[];
  events: readonly EventEntry[];
  crons: readonly CronEntry[];
}

export interface StopOptions {
  timeoutMs?: number;
}

export interface StopResult {
  drained: boolean;
}

/**
 * A condition boot detects but does not treat as fatal.
 *
 * A discriminated union on `code`; today's members are {@link UnemittedEventWarning} and
 * {@link UnwrittenOptionalReadWarning}. A minor release may add further codes, so code reading
 * `kestrel.warnings` must handle a `code` it does not recognize instead of assuming the shape of
 * this union's current members.
 *
 * Every field besides `code` and `message` names the context of the condition and is a string.
 */
export type BootWarning = UnemittedEventWarning | UnwrittenOptionalReadWarning;

/** An event trigger's event that no pipeline emits via `events.emit` and no module declares in `emits`. */
export interface UnemittedEventWarning {
  code: "unemitted-event";
  message: string;
  pipeline: string;
  event: string;
}

/**
 * An optional read (`"key?"`) whose key no registered step writes, optional or not, and no
 * trigger provides — almost always a typo in the key rather than a genuinely absent value.
 */
export interface UnwrittenOptionalReadWarning {
  code: "unwritten-optional-read";
  message: string;
  pipeline: string;
  step: string;
  key: string;
}

export interface Kestrel extends Introspection {
  config: KestrelConfig;
  contracts: ContractLookup & { names(): string[] };
  steps: Steps;
  pipelines: ReadonlyMap<string, ResolvedPipeline>;
  triggers: Triggers;
  warnings: readonly BootWarning[];
  run(pipeline: string, input: ContextInput): Promise<RunResult>;
  start(): Promise<{ http?: AddressInfo }>;
  stop(options?: StopOptions): Promise<StopResult>;
}

/** What `checkBoot()` selects to actually run: `setup()`, `attach()` and `teardown()` reach whatever storage the module's config names, so this has no default. */
export interface CheckBootOptions {
  setup: "none" | "all" | { only: readonly string[] };
}

/** A module, pipeline or the `attach` phase left unchecked because a problem it depends on made it impossible to check safely. */
export interface NotChecked {
  kind: "module" | "pipeline" | "attach";
  name: string;
  because: string;
}

/** What `checkBoot()` returns: every problem, warning and unchecked item it found, instead of throwing at the first. */
export interface BootCheck {
  /** Every problem that would have made `boot()` throw; `errors[0]` is the one it does throw. */
  errors: BootProblem[];
  /** What `boot()` would carry as `kestrel.warnings`. */
  warnings: BootWarning[];
  /** Every module, pipeline or `attach` phase `checkBoot()` could not check safely, and why. */
  notChecked: NotChecked[];
}

const CORE = "kestrel";
const SVG = "image/svg+xml";
const SANITIZE_SVG = "sanitize.svg";
const EVENTS_EMIT = "events.emit";
const BARREL = new Set(["module", "index", "src", "dist"]);

const DUMMY_STEP: ResolvedStep = { name: "", fn: async (ctx) => ok(ctx), description: { summary: "", reads: [], writes: [] } };

function useTokens(use: string): string[] {
  const parts = (use.split(/[?#]/)[0] ?? use).split("/").filter((p) => p !== "" && p !== "." && p !== "..");
  if (parts[0]?.startsWith("@")) parts.shift();
  const tokens = parts.flatMap((p) => p.replace(/\.[cm]?[jt]sx?$/, "").toLowerCase().split("-")).filter((t) => t !== "");
  while (BARREL.has(tokens.at(-1) ?? "")) tokens.pop();
  if (tokens[0] === "kestrel") tokens.shift();
  return tokens;
}

function entryNamesModule(use: string, moduleName: string): boolean {
  const tokens = useTokens(use);
  const last = tokens.at(-1);
  if (last === undefined) return false;
  const wanted = moduleName.split("/");
  if (tokens.length < wanted.length) return wanted.includes(last);
  return wanted.every((w, i) => tokens[tokens.length - wanted.length + i] === w);
}

function emittedEvent(spec: string): string | undefined {
  if (!spec.startsWith(`${EVENTS_EMIT}:`)) return undefined;
  const arg = spec.slice(EVENTS_EMIT.length + 1);
  const query = arg.indexOf("?");
  return query === -1 ? arg : arg.slice(0, query);
}

function warnUnemittedEvents(modules: readonly ModuleDefinition[], definitions: ReadonlyMap<string, PipelineDefinition>, events: readonly EventEntry[], logger: Logger): UnemittedEventWarning[] {
  const emitted = new Set<string>();
  for (const def of definitions.values()) {
    for (const step of pipelineSteps(def.steps)) {
      const event = emittedEvent(step);
      if (event !== undefined) emitted.add(event);
    }
  }
  for (const mod of modules) for (const event of mod.emits ?? []) emitted.add(event);
  const warnings: UnemittedEventWarning[] = [];
  for (const entry of events) {
    if (emitted.has(entry.event)) continue;
    const message = "event trigger listens to an event no pipeline emits via events.emit and no module declares in emits";
    logWarn(logger, message, { event: entry.event, pipeline: entry.pipeline });
    warnings.push({ code: "unemitted-event", message, pipeline: entry.pipeline, event: entry.event });
  }
  return warnings;
}

function solelyOptionalResultWrite(description: StepDescription): boolean {
  const resultWrites = description.writes.filter((path) => writeRoot(path) === "result");
  return resultWrites.length === 1 && resultWrites[0] === "result?";
}

function declaresOutput(description: StepDescription): boolean {
  if (description.output !== undefined || description.extendsOutput !== undefined || description.extendsItems !== undefined || description.binary === true || description.narrows !== undefined) return true;
  return description.terminalOutput !== undefined && solelyOptionalResultWrite(description);
}

function checkUndeclaredOutput(sink: Sink, pipelines: ReadonlyMap<string, ResolvedPipeline>): void {
  for (const pipeline of pipelines.values()) {
    for (const step of pipeline.steps) {
      if (!step.description.writes.some((path) => writeRoot(path) === "result") || declaresOutput(step.description)) continue;
      sink.fail("undeclared-output", `pipelines/${pipeline.name}`, `step "${step.name}" writes result without declaring output, extendsOutput, extendsItems, narrows or binary: true (terminalOutput alone only covers an optional "result?" write)`, { step: step.name });
    }
  }
}

function declaredOutputSchemas(description: StepDescription): Array<{ key: string; schema: NonNullable<StepDescription["output"]> }> {
  const schemas: Array<{ key: string; schema: NonNullable<StepDescription["output"]> }> = [];
  if (description.output !== undefined) schemas.push({ key: "output", schema: description.output });
  if (description.extendsOutput !== undefined) schemas.push({ key: "extendsOutput", schema: description.extendsOutput });
  if (description.extendsItems !== undefined) schemas.push({ key: "extendsItems", schema: description.extendsItems });
  if (description.terminalOutput !== undefined) schemas.push({ key: "terminalOutput", schema: description.terminalOutput });
  return schemas;
}

function checkUndeclaredRequired(sink: Sink, pipelines: ReadonlyMap<string, ResolvedPipeline>): void {
  for (const pipeline of pipelines.values()) {
    for (const step of pipeline.steps) {
      for (const { key, schema } of declaredOutputSchemas(step.description)) {
        for (const path of findMissingRequired(schema, `$.${key}`)) {
          sink.fail("undeclared-required", `pipelines/${pipeline.name}`, `step "${step.name}"'s output schema at ${path} declares properties without declaring required`, { step: step.name, path });
        }
      }
    }
  }
}

function checkOutputFold(sink: Sink, pipelines: ReadonlyMap<string, ResolvedPipeline>): void {
  for (const pipeline of pipelines.values()) {
    resolveOutputSchema(
      pipeline.steps.map((s) => s.description),
      (index, keyword, reason, sourceIndex) => {
        const step = pipeline.steps[index]!;
        const earlier = sourceIndex === undefined ? undefined : pipeline.steps[sourceIndex];
        const detail = earlier === undefined ? reason : `${reason} (set by step "${earlier.name}")`;
        sink.fail("output-fold-contradiction", `pipelines/${pipeline.name}`, `step "${step.name}"'s ${keyword} cannot fold onto the active output schema: ${detail}`, { step: step.name });
      },
    );
  }
}

function checkTerminalOutputPlacement(sink: Sink, pipelines: ReadonlyMap<string, ResolvedPipeline>): void {
  for (const pipeline of pipelines.values()) {
    const hasBinary = pipeline.steps.some((s) => s.description.binary === true);
    for (const step of pipeline.steps) {
      if (step.description.terminalOutput === undefined) continue;
      if (!step.description.writes.some((path) => writeRoot(path) === "result")) {
        sink.fail("terminal-output-misplaced", `pipelines/${pipeline.name}`, `step "${step.name}" declares terminalOutput without a write to result`, { step: step.name });
      }
      if (hasBinary) {
        sink.fail("terminal-output-misplaced", `pipelines/${pipeline.name}`, `step "${step.name}" declares terminalOutput in a pipeline with a binary step`, { step: step.name });
      }
    }
  }
}

function allDeclaredWrites(steps: StepRegistry): Set<string> {
  const keys = new Set<string>();
  for (const step of steps.list()) {
    const description = typeof step.describe === "function" ? step.describe(PLACEHOLDER_ARG) : step.describe;
    for (const write of description.writes) keys.add(stripOptional(write));
  }
  return keys;
}

function warnUnwrittenOptionalReads(pipelines: ReadonlyMap<string, ResolvedPipeline>, steps: StepRegistry, logger: Logger): UnwrittenOptionalReadWarning[] {
  const written = allDeclaredWrites(steps);
  const triggerProvided = new Set<string>(CONTEXT_KEYS);
  const warnings: UnwrittenOptionalReadWarning[] = [];
  for (const pipeline of pipelines.values()) {
    for (const step of pipeline.steps) {
      for (const read of step.description.reads) {
        if (!read.endsWith("?")) continue;
        const key = stripOptional(read);
        if (satisfied(key, triggerProvided) || satisfied(key, written)) continue;
        const message = `step optionally reads "${key}" but no registered step writes it and no trigger provides it`;
        logWarn(logger, message, { pipeline: pipeline.name, step: step.name, key });
        warnings.push({ code: "unwritten-optional-read", message, pipeline: pipeline.name, step: step.name, key });
      }
    }
  }
  return warnings;
}

function registerModuleSteps(steps: StepRegistry, mod: ModuleDefinition, instance: unknown, sink: Sink): string | undefined {
  if (!mod.steps) return undefined;
  let stepMap: StepMap;
  try {
    stepMap = mod.steps(instance);
  } catch (err) {
    sink.fail("steps-threw", mod.name, `steps() threw: ${err instanceof Error ? err.message : String(err)}`);
    return "steps() threw";
  }
  let descriptions: StepDescriptions;
  try {
    descriptions = mod.describe?.(instance) ?? {};
  } catch (err) {
    sink.fail("describe-threw", mod.name, `describe() threw: ${err instanceof Error ? err.message : String(err)}`);
    return "describe() threw";
  }
  steps.register(mod.name, stepPrefix(mod.name), stepMap, descriptions, sink);
  return undefined;
}

function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function drainConnections(server: Server, closing: Promise<void>, deadline: number): Promise<boolean> {
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  while (!closed && Date.now() < deadline) {
    server.closeIdleConnections();
    await settledWithin(closing, Math.min(50, deadline - Date.now()));
  }
  return closed;
}

async function teardownAll(ordered: readonly ModuleDefinition[], instances: ReadonlyMap<ModuleDefinition, unknown>, logger: Logger): Promise<void> {
  for (const mod of [...ordered].reverse()) {
    if (!mod.teardown || !instances.has(mod)) continue;
    try {
      await mod.teardown(instances.get(mod));
    } catch (err) {
      logger.error(`teardown failed for module "${mod.name}"`, { module: mod.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

type SetupSelector = "all" | "none" | ReadonlySet<string>;

interface EngineState {
  ordered: ModuleDefinition[];
  instances: Map<ModuleDefinition, unknown>;
  notChecked: NotChecked[];
}

interface EngineCore {
  introspection: Introspection;
  contracts: Kestrel["contracts"];
  steps: StepRegistry;
  pipelines: Map<string, ResolvedPipeline>;
  routes: Route[];
  crons: CronEntry[];
  events: readonly EventEntry[];
  eventHook: ModuleDefinition | undefined;
  atomicScope: AtomicScope | undefined;
  warnings: BootWarning[];
  config: KestrelConfig;
  root: string;
  hub: ReturnType<typeof createObserverHub>;
  stoppers: Array<() => void>;
}

function isSelected(setup: SetupSelector, use: string): boolean {
  if (setup === "all") return true;
  if (setup === "none") return false;
  return setup.has(use);
}

async function runEngine(input: BootInput, sink: Sink, setup: SetupSelector, errors: readonly BootProblem[], state: EngineState): Promise<EngineCore | undefined> {
  const bootStartedAt = Date.now();
  const logger = input.logger ?? consoleLogger;
  const root = input.root ?? process.cwd();
  const notChecked = state.notChecked;

  const markNotSetUp = (notSetUp: Map<ModuleDefinition, string>, mod: ModuleDefinition, because: string): void => {
    if (notSetUp.has(mod)) return;
    notSetUp.set(mod, because);
    notChecked.push({ kind: "module", name: mod.name, because });
  };

  const parsed = configSchema.safeParse(input.config);
  if (!parsed.success) {
    sink.fail("invalid-config", CORE, `invalid kestrel.config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    for (const mod of input.modules) notChecked.push({ kind: "module", name: mod.name, because: "kestrel.config is invalid" });
    for (const p of input.pipelines) notChecked.push({ kind: "pipeline", name: p.name, because: "kestrel.config is invalid" });
    return undefined;
  }
  const config = parsed.data;
  const eventTriggers: readonly EventEntry[] = config.triggers.flatMap((t) => ("event" in t ? [{ event: t.event, pipeline: t.pipeline }] : []));
  if (input.modules.length !== config.modules.length) {
    sink.fail("module-count", CORE, `config lists ${config.modules.length} modules but ${input.modules.length} were loaded`);
    for (const mod of input.modules) notChecked.push({ kind: "module", name: mod.name, because: "config.modules does not pair with the loaded modules" });
    for (const p of input.pipelines) notChecked.push({ kind: "pipeline", name: p.name, because: "config.modules does not pair with the loaded modules" });
    return undefined;
  }

  const configByModule = new Map<ModuleDefinition, unknown>();
  const defaultsByModule = new Map<ModuleDefinition, ConfigDefaults>();
  const useByModule = new Map<ModuleDefinition, string>();
  const seen = new Set<string>();
  let entryProblem = false;
  for (const [i, mod] of input.modules.entries()) {
    const entry = config.modules[i];
    if (entry === undefined) {
      sink.fail("module-entry-mismatch", CORE, `config.modules[${i}] is missing for module "${mod.name}"`);
      entryProblem = true;
      continue;
    }
    if (seen.has(mod.name)) {
      sink.fail("module-listed-twice", mod.name, `listed twice in kestrel.config (${entry.use})`);
      entryProblem = true;
    }
    seen.add(mod.name);
    if (!entryNamesModule(entry.use, mod.name)) {
      const other = input.modules.find((m) => m !== mod && entryNamesModule(entry.use, m.name));
      if (other) {
        sink.fail("module-entry-mismatch", CORE, `config.modules[${i}] "${entry.use}" names module "${other.name}", not "${mod.name}"; config entries and loaded modules must be in the same order`);
        entryProblem = true;
      }
    }
    configByModule.set(mod, entry.config ?? {});
    if (entry.defaults !== undefined) defaultsByModule.set(mod, entry.defaults);
    useByModule.set(mod, entry.use);
  }
  if (entryProblem) {
    for (const mod of input.modules) notChecked.push({ kind: "module", name: mod.name, because: "kestrel.config's module list does not pair reliably with the loaded modules" });
    for (const p of input.pipelines) notChecked.push({ kind: "pipeline", name: p.name, because: "kestrel.config's module list does not pair reliably with the loaded modules" });
    return undefined;
  }

  const { ordered, excluded } = sortModules(input.modules, sink);
  state.ordered = ordered;
  const notSetUp = new Map<ModuleDefinition, string>();
  for (const [mod, reason] of excluded) markNotSetUp(notSetUp, mod, reason);

  for (const mod of ordered) {
    if (mod.provides.length === 0) continue;
    const prefix = stepPrefix(mod.name);
    if (mod.provides.some((c) => c.name.split("@")[0] === prefix)) continue;
    sink.fail("module-name-contract", mod.name, `provides ${mod.provides.map((c) => `"${c.name}"`).join(", ")} but registers steps under "${prefix}."; a module must be named after a contract it provides`);
    markNotSetUp(notSetUp, mod, "provides a contract but is not named after it");
  }

  const prefixToModule = new Map<string, ModuleDefinition>();
  for (const mod of input.modules) prefixToModule.set(stepPrefix(mod.name), mod);

  const registered = new Map<string, unknown>();
  const contracts: Kestrel["contracts"] = {
    get<T>(contract: Contract<T>): T {
      if (!registered.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(registered.get(contract.name), "host");
    },
    find<T>(contract: Contract<T>): T | undefined {
      return boundaryCast<T | undefined>(registered.get(contract.name), "host");
    },
    names: () => [...registered.keys()],
    logger,
    root,
    bootStartedAt,
  };
  const deps: Deps = { ...contracts, eventTriggers };
  const instances = state.instances;
  const parsedByModule = new Map<ModuleDefinition, unknown>();

  for (const mod of ordered) {
    if (notSetUp.has(mod)) continue;
    const defaults = defaultsByModule.get(mod);
    const cfg = mod.configSchema.safeParse(effectiveModuleConfig({ config: configByModule.get(mod), defaults }));
    if (!cfg.success) {
      const origin = defaults === undefined ? "" : ` (with defaults from "${defaults.from}")`;
      sink.fail("invalid-module-config", mod.name, `invalid config${origin}: ${cfg.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
      markNotSetUp(notSetUp, mod, "invalid config");
      continue;
    }
    parsedByModule.set(mod, cfg.data);

    const unmetRequire = mod.requires.find((c) => {
      const provider = ordered.find((candidate) => candidate.provides.some((p) => p.name === c.name));
      return provider !== undefined && notSetUp.has(provider);
    });
    if (unmetRequire) {
      markNotSetUp(notSetUp, mod, `depends on "${unmetRequire.name}" whose provider was not set up`);
      continue;
    }

    const use = useByModule.get(mod) ?? mod.name;
    if (!isSelected(setup, use)) {
      markNotSetUp(notSetUp, mod, "not selected to run setup()");
      continue;
    }

    let instance: unknown;
    try {
      instance = await mod.setup(cfg.data, deps);
    } catch (err) {
      sink.fail("setup-failed", mod.name, `setup() threw: ${err instanceof Error ? err.message : String(err)}`);
      markNotSetUp(notSetUp, mod, "setup() threw");
      continue;
    }
    instances.set(mod, instance);
    const allMissing = mod.provides.flatMap((c) => {
      const missing = missingMethods(c, instance);
      return missing.length > 0 ? [{ contract: c, missing }] : [];
    });
    if (allMissing.length > 0) {
      const first = allMissing[0]!;
      sink.fail("missing-methods", mod.name, `setup() result lacks ${first.contract.name} method(s): ${first.missing.join(", ")}`);
      markNotSetUp(notSetUp, mod, "setup() result lacks required contract methods");
      continue;
    }
    for (const contract of mod.provides) registered.set(contract.name, instance);
  }

  const steps = new StepRegistry();
  for (const mod of ordered) {
    if (notSetUp.has(mod)) continue;
    const unregistered = registerModuleSteps(steps, mod, instances.get(mod), sink);
    if (unregistered !== undefined) markNotSetUp(notSetUp, mod, unregistered);
  }

  const svgSanitizerProvider = prefixToModule.get(SANITIZE_SVG.split(".")[0]!);
  const svgSanitizerUnchecked = svgSanitizerProvider !== undefined && notSetUp.has(svgSanitizerProvider);
  if (config.http?.inlineTypes.includes(SVG) && !steps.has(SANITIZE_SVG) && !svgSanitizerUnchecked) {
    sink.fail("svg-without-sanitizer", CORE, `http.inlineTypes contains "${SVG}" but no module registers the step "${SANITIZE_SVG}"`);
  }
  if (config.http !== null) {
    try {
      createAllowlist(config.http.allow);
    } catch (err) {
      sink.fail("invalid-allowlist", CORE, `http.allow: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const definitions = new Map<string, PipelineDefinition>();
  for (const p of input.pipelines) {
    if (definitions.has(p.name)) {
      sink.fail("pipeline-defined-twice", `pipelines/${p.name}`, "defined twice");
      continue;
    }
    definitions.set(p.name, p);
  }

  const pipelines = new Map<string, ResolvedPipeline>();
  const notCheckedPipelines = new Set<string>();
  for (const def of definitions.values()) {
    if (pipelineSteps(def.steps).length === 0) {
      sink.fail("pipeline-empty", `pipelines/${def.name}`, "has no steps");
      notCheckedPipelines.add(def.name);
      notChecked.push({ kind: "pipeline", name: def.name, because: "has no steps" });
      continue;
    }
    let cascadeModule: ModuleDefinition | undefined;
    let cascadeStep: string | undefined;
    let failed = false;
    const resolved = resolveEntries(def.steps, (s) => {
      if (failed) return DUMMY_STEP;
      const step = steps.tryResolve(s, `pipelines/${def.name}`);
      if (!(step instanceof KestrelBootError)) return step;
      if (!sink.collecting) throw step;
      const stepName = s.split(":")[0];
      const prefix = stepName?.split(".")[0];
      const owner = prefix === undefined ? undefined : prefixToModule.get(prefix);
      if (step.code === "unknown-step" && owner !== undefined && notSetUp.has(owner)) {
        cascadeModule = owner;
      } else if (step.code === "unknown-step" && stepName !== undefined && steps.failedToRegister(stepName)) {
        cascadeStep = stepName;
      } else {
        sink.fail(step.code, step.module, step.reason, { step: s });
      }
      failed = true;
      return DUMMY_STEP;
    });
    if (failed) {
      const because = cascadeModule
        ? `depends on module "${cascadeModule.name}" which is not set up`
        : cascadeStep
          ? `depends on step "${cascadeStep}" which failed to register`
          : "a step failed to resolve";
      notCheckedPipelines.add(def.name);
      notChecked.push({ kind: "pipeline", name: def.name, because });
      continue;
    }
    pipelines.set(def.name, { name: def.name, steps: resolved });
  }

  for (const [name, pipeline] of pipelines) {
    for (const step of pipeline.steps) {
      if (step.atomic === undefined || step.description.atomicSafe === true) continue;
      sink.fail("atomic-unsafe-step", `pipelines/${name}`, `step "${step.name}" is in an atomic group but does not declare atomicSafe`, { step: step.name });
    }
  }

  const routes: Route[] = [];
  const events = eventTriggers;
  const crons: CronEntry[] = [];
  const byPattern = new Map<string, string>();
  for (const t of config.triggers) {
    if (!pipelines.has(t.pipeline) && !notCheckedPipelines.has(t.pipeline)) {
      sink.fail("unknown-trigger-pipeline", CORE, `trigger references unknown pipeline "${t.pipeline}"`);
      continue;
    }
    let route: Route | undefined;
    try {
      if ("http" in t) route = parseRoute(t.http, t.pipeline);
      else if (!("event" in t)) crons.push(createCronEntry(t.cron, t.pipeline));
    } catch (err) {
      sink.fail("invalid-trigger", CORE, `invalid trigger for "${t.pipeline}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (route === undefined) continue;
    const pattern = routePattern(route);
    const other = byPattern.get(pattern);
    if (other !== undefined) {
      sink.fail("duplicate-route", CORE, `http triggers for pipelines "${other}" and "${t.pipeline}" both resolve to "${pattern}"`);
      continue;
    }
    byPattern.set(pattern, t.pipeline);
    routes.push(route);
  }

  for (const [name, pipeline] of pipelines) {
    const pipelineRoutes = routes.filter((r) => r.pipeline === name);
    const hasCron = crons.some((c) => c.pipeline === name);
    const hasEvent = events.some((e) => e.pipeline === name);
    if (sink.collecting) checkDataflowCollecting(sink, pipeline, pipelineRoutes, hasCron, hasEvent);
    else checkDataflow(pipeline, pipelineRoutes, hasCron, hasEvent);
  }

  const potentialEventHooks = ordered.filter((mod) => mod.triggers?.event !== undefined);
  const eventHooks = potentialEventHooks.filter((mod) => !notSetUp.has(mod));
  const eventHookUnchecked = potentialEventHooks.some((mod) => notSetUp.has(mod));
  if (eventHooks.length > 1) sink.fail("event-hooks-twice", CORE, `modules "${eventHooks[0]?.name ?? ""}" and "${eventHooks[1]?.name ?? ""}" both provide an event trigger hook`);
  if (events.length > 0 && eventHooks.length === 0 && !eventHookUnchecked) sink.fail("event-hook-missing", CORE, "event triggers need a module that provides an event trigger hook");
  const eventHook = eventHooks[0];

  const potentialScopeHooks = ordered.filter((mod) => mod.atomicScope !== undefined);
  const scopeHooks = potentialScopeHooks.filter((mod) => !notSetUp.has(mod));
  const scopeHookUnchecked = potentialScopeHooks.some((mod) => notSetUp.has(mod));
  if (scopeHooks.length > 1) sink.fail("atomic-scope-twice", CORE, `modules "${scopeHooks[0]?.name ?? ""}" and "${scopeHooks[1]?.name ?? ""}" both provide an atomic scope`);
  const grouped = [...pipelines.values()].filter((p) => p.steps.some((s) => s.atomic !== undefined));
  if (grouped.length > 0 && scopeHooks.length === 0 && !scopeHookUnchecked) {
    sink.fail("atomic-scope-missing", CORE, `pipeline "${grouped[0]?.name ?? ""}" has an atomic group but no module provides an atomic scope`);
  }
  const scopeHook = scopeHooks[0];
  const atomicScope: AtomicScope | undefined = scopeHook ? (info, body) => scopeHook.atomicScope!(instances.get(scopeHook), info, body) : undefined;

  checkUndeclaredOutput(sink, pipelines);
  checkUndeclaredRequired(sink, pipelines);
  checkOutputFold(sink, pipelines);
  checkTerminalOutputPlacement(sink, pipelines);
  const warnings = [...warnUnemittedEvents(ordered, definitions, events, logger), ...warnUnwrittenOptionalReads(pipelines, steps, logger)];

  const hub = createObserverHub(logger);
  let manifest: Manifest | undefined;
  const describe = (): Manifest => {
    manifest ??= buildManifest({ root, modules: input.modules, uses: config.modules.map((m) => m.use), rawConfigs: configByModule, parsedConfigs: parsedByModule, configDefaults: defaultsByModule, contracts: contracts.names(), steps, pipelines, triggers: { http: routes, events, crons }, warnings });
    return manifest;
  };
  const healthThrew = new Set<ModuleDefinition>();
  const moduleHealth = (mod: ModuleDefinition): ModuleHealth => {
    try {
      return mod.health?.(instances.get(mod)) ?? { ok: true };
    } catch (error) {
      if (!healthThrew.has(mod)) {
        healthThrew.add(mod);
        logger.error(`${mod.name}: health() threw`, { error: error instanceof Error ? error.stack : String(error) });
      }
      return { ok: false, reason: "health() threw", restartRequired: false };
    }
  };
  const health = (): InstanceHealth => {
    const modules = ordered.flatMap((mod) => (mod.health && !notSetUp.has(mod) ? [{ module: mod.name, ...moduleHealth(mod) }] : []));
    return { ok: modules.every((m) => m.ok), restartRequired: modules.some((m) => m.ok === false && m.restartRequired), modules };
  };
  const introspection: Introspection = { describe, observe: hub.observe, health };

  const shouldAttach = !sink.collecting || (errors.length === 0 && notSetUp.size === 0);
  const stoppers: Array<() => void> = [];
  if (shouldAttach) {
    for (const mod of ordered) {
      if (!mod.attach || notSetUp.has(mod)) continue;
      let detach: ReturnType<NonNullable<ModuleDefinition["attach"]>>;
      try {
        detach = mod.attach(instances.get(mod), introspection);
      } catch (err) {
        sink.fail("attach-failed", mod.name, `attach() threw: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (typeof detach === "function") stoppers.push(detach);
    }
  } else {
    for (const mod of ordered) {
      if (mod.attach) notChecked.push({ kind: "attach", name: mod.name, because: "a boot problem exists, or a module was not set up" });
    }
  }

  return { introspection, contracts, steps, pipelines, routes, crons, events, eventHook, atomicScope, warnings, config, root, hub, stoppers };
}

export async function boot(input: BootInput): Promise<Kestrel> {
  const logger = input.logger ?? consoleLogger;
  const state: EngineState = { ordered: [], instances: new Map(), notChecked: [] };
  let core: EngineCore | undefined;
  try {
    core = await runEngine(input, throwSink(), "all", [], state);
  } catch (err) {
    await teardownAll(state.ordered, state.instances, logger);
    throw err;
  }
  if (core === undefined) throw new Error("unreachable: boot() always either throws or fully resolves");

  const { introspection, contracts, steps, pipelines, routes, crons, events, eventHook, atomicScope, warnings, config, hub, stoppers } = core;
  const instances = state.instances;
  const ordered = state.ordered;
  const runs = createRunTracker();
  const validateOutput = input.validateOutput ?? false;
  const run = (name: string, ctxInput: ContextInput): Promise<RunResult> => {
    const pipeline = pipelines.get(name);
    if (!pipeline) throw new Error(`unknown pipeline "${name}"`);
    return runs.track(() => runPipeline(pipeline, ctxInput, logger, hub.observer, { validateOutput, ...(atomicScope === undefined ? {} : { atomicScope }) }));
  };
  const triggers: Triggers = { http: routes, events, crons };

  let server: Server | undefined;
  let torndown = false;

  const kestrel: Kestrel = {
    config,
    contracts,
    steps,
    pipelines,
    triggers,
    warnings,
    describe: introspection.describe,
    observe: introspection.observe,
    health: introspection.health,
    run,
    async start() {
      const started: { http?: AddressInfo } = {};
      if (events.length > 0 && eventHook?.triggers?.event) stoppers.push(eventHook.triggers.event(instances.get(eventHook), events, run, logger));
      if (crons.length > 0) stoppers.push(startCron(crons, run, logger));
      const http = config.http;
      if (http !== null) {
        server = createHttpServer(routes, run, logger, {
          maxBodyBytes: http.maxBodyBytes,
          trustProxy: http.trustProxy,
          proxyHops: http.proxyHops,
          ...(http.trustedHeader === undefined ? {} : { trustedHeader: http.trustedHeader }),
          allow: http.allow,
          healthPath: http.healthPath,
          health: introspection.health,
          inlineTypes: http.inlineTypes,
          timeouts: http.timeouts,
          ...(http.corsOrigin === undefined ? {} : { corsOrigin: http.corsOrigin }),
        });
        started.http = await listen(server, http.port, http.host);
        logger.info(`http listening on ${started.http.address}:${started.http.port}`, { routes: routes.length });
      }
      return started;
    },
    async stop(options: StopOptions = {}) {
      const deadline = Date.now() + (options.timeoutMs ?? config.shutdownTimeoutMs);
      let httpError: Error | undefined;
      const s = server;
      server = undefined;
      let closing: Promise<void> | undefined;
      if (s) {
        closing = new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve()))).catch((err: unknown) => {
          httpError = err instanceof Error ? err : new Error(String(err));
        });
      }
      let drained = await runs.drain(deadline - Date.now());
      if (s && closing) {
        drained = (await drainConnections(s, closing, deadline)) && drained;
        s.closeAllConnections();
        await closing;
      }
      for (const stop of stoppers.splice(0)) stop();
      if (!torndown) {
        torndown = true;
        await teardownAll(ordered, instances, logger);
      }
      if (httpError) throw httpError;
      return { drained };
    },
  };
  return kestrel;
}

/**
 * Runs every check `boot()` runs and returns every problem instead of throwing at the first;
 * shares its engine with `boot()`, so the two check the same things the same way. Never starts a
 * trigger.
 *
 * `setup` has no default because it decides which modules' `setup()`, `attach()` and `teardown()`
 * actually run, with whatever side effects their config names. `"none"` runs no module code
 * beyond `configSchema`; anything that needs an instance is reported in `notChecked`. `{ only }`
 * names the config `use` entries whose `setup()` may run; every other module counts as not set up.
 */
export async function checkBoot(input: BootInput, options: CheckBootOptions): Promise<BootCheck> {
  const logger = input.logger ?? consoleLogger;
  const selector: SetupSelector = options.setup === "all" || options.setup === "none" ? options.setup : new Set(options.setup.only);
  const errors: BootProblem[] = [];
  const sink = collectSink(errors);
  const state: EngineState = { ordered: [], instances: new Map(), notChecked: [] };
  let core: EngineCore | undefined;
  try {
    core = await runEngine(input, sink, selector, errors, state);
  } catch (err) {
    await teardownAll(state.ordered, state.instances, logger);
    throw err;
  }
  for (const stop of core?.stoppers ?? []) stop();
  await teardownAll(state.ordered, state.instances, logger);
  return { errors, warnings: core?.warnings ?? [], notChecked: state.notChecked };
}
