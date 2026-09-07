import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ContextInput } from "./context.ts";
import { missingMethods, type Contract } from "./defineContract.ts";
import { checkDataflow } from "./dataflow.ts";
import { configSchema, type KestrelConfig, type KestrelConfigInput } from "./defineConfig.ts";
import { stepPrefix, type Deps, type EventEntry, type ModuleDefinition } from "./defineModule.ts";
import type { PipelineDefinition } from "./definePipeline.ts";
import { KestrelBootError } from "./errors.ts";
import { consoleLogger, type Logger } from "./logger.ts";
import { StepRegistry } from "./registry.ts";
import { createRunTracker, runPipeline, type ResolvedPipeline, type RunResult } from "./runner.ts";
import { sortModules } from "./sort.ts";
import { createCronEntry, startCron, type CronEntry } from "./triggers/cron.ts";
import { createAllowlist } from "./triggers/allowlist.ts";
import { createHttpServer, listen, parseRoute, routePattern, type Route } from "./triggers/http.ts";

export interface BootInput {
  config: KestrelConfigInput;
  modules: readonly ModuleDefinition[];
  pipelines: readonly PipelineDefinition[];
  logger?: Logger;
  root?: string;
  /** Validates `ctx.payload` against `describe().input` before every step; defaults to `NODE_ENV !== "production"`. */
  dev?: boolean;
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

export interface Kestrel {
  config: KestrelConfig;
  contracts: Deps & { names(): string[] };
  steps: StepRegistry;
  pipelines: ReadonlyMap<string, ResolvedPipeline>;
  triggers: Triggers;
  run(pipeline: string, input: ContextInput): Promise<RunResult>;
  start(): Promise<{ http?: AddressInfo }>;
  stop(options?: StopOptions): Promise<StopResult>;
}

const CORE = "kestrel";
const SVG = "image/svg+xml";
const SANITIZE_SVG = "sanitize.svg";
const BARREL = new Set(["module", "index", "src", "dist"]);

/** `use` is a package name or a path and never equals `mod.name`; both "@scope/kestrel-authn-multi" and "./modules/authn/multi/module.ts" reduce to ["authn", "multi"]. */
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
  if (tokens.length === 0) return false;
  const wanted = moduleName.split("/");
  // Too few tokens to spell out "<module>/<submodule>": accept a hit on either half, which still
  // separates any two modules whose names differ in that half.
  if (tokens.length < wanted.length) return wanted.includes(tokens[tokens.length - 1] as string);
  return wanted.every((w, i) => tokens[tokens.length - wanted.length + i] === w);
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

/** A connection that goes idle after close() would otherwise hold the server until keepAliveTimeout. */
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

export async function boot(input: BootInput): Promise<Kestrel> {
  const logger = input.logger ?? consoleLogger;
  const root = input.root ?? process.cwd();
  const dev = input.dev ?? process.env.NODE_ENV !== "production";

  const parsed = configSchema.safeParse(input.config);
  if (!parsed.success) throw new KestrelBootError(CORE, `invalid kestrel.config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const config = parsed.data;
  if (input.modules.length !== config.modules.length) throw new KestrelBootError(CORE, `config lists ${config.modules.length} modules but ${input.modules.length} were loaded`);

  const configByModule = new Map<ModuleDefinition, unknown>();
  const seen = new Set<string>();
  input.modules.forEach((mod, i) => {
    const entry = config.modules[i] as KestrelConfig["modules"][number];
    if (seen.has(mod.name)) throw new KestrelBootError(mod.name, `listed twice in kestrel.config (${entry.use})`);
    seen.add(mod.name);
    if (!entryNamesModule(entry.use, mod.name)) {
      // A `use` that names no loaded module at all is not evidence of anything — third-party
      // packages need not be named after their module. Only a hit on a different one is.
      const other = input.modules.find((m) => m !== mod && entryNamesModule(entry.use, m.name));
      if (other) throw new KestrelBootError(CORE, `config.modules[${i}] "${entry.use}" names module "${other.name}", not "${mod.name}"; config entries and loaded modules must be in the same order`);
    }
    configByModule.set(mod, entry.config ?? {});
  });
  const ordered = sortModules(input.modules);
  for (const mod of ordered) {
    if (mod.provides.length === 0) continue;
    const prefix = stepPrefix(mod.name);
    if (mod.provides.some((c) => c.name.split("@")[0] === prefix)) continue;
    throw new KestrelBootError(mod.name, `provides ${mod.provides.map((c) => `"${c.name}"`).join(", ")} but registers steps under "${prefix}."; a module must be named after a contract it provides`);
  }

  const registered = new Map<string, unknown>();
  const contracts: Kestrel["contracts"] = {
    get<T>(contract: Contract<T>): T {
      if (!registered.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return registered.get(contract.name) as T;
    },
    find<T>(contract: Contract<T>): T | undefined {
      return registered.get(contract.name) as T | undefined;
    },
    names: () => [...registered.keys()],
    logger,
    root,
  };
  const instances = new Map<ModuleDefinition, unknown>();
  try {
    for (const mod of ordered) {
      const cfg = mod.configSchema.safeParse(configByModule.get(mod));
      if (!cfg.success) throw new KestrelBootError(mod.name, `invalid config: ${cfg.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
      let instance: unknown;
      try {
        instance = await mod.setup(cfg.data, contracts);
      } catch (err) {
        throw new KestrelBootError(mod.name, `setup() threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      instances.set(mod, instance);
      for (const contract of mod.provides) {
        const missing = missingMethods(contract, instance);
        if (missing.length > 0) throw new KestrelBootError(mod.name, `setup() result lacks ${contract.name} method(s): ${missing.join(", ")}`);
        registered.set(contract.name, instance);
      }
    }

    const steps = new StepRegistry();
    for (const mod of ordered) {
      if (!mod.steps) continue;
      steps.register(mod.name, stepPrefix(mod.name), mod.steps(instances.get(mod)), mod.describe?.(instances.get(mod)) ?? {});
    }

    if (config.http?.inlineTypes.includes(SVG) && !steps.has(SANITIZE_SVG)) {
      throw new KestrelBootError(CORE, `http.inlineTypes contains "${SVG}" but no module registers the step "${SANITIZE_SVG}"`);
    }
    if (config.http !== null) {
      try {
        createAllowlist(config.http.allow);
      } catch (err) {
        throw new KestrelBootError(CORE, `http.allow: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const definitions = new Map<string, PipelineDefinition>();
    for (const p of input.pipelines) {
      if (definitions.has(p.name)) throw new KestrelBootError(`pipelines/${p.name}`, "defined twice");
      definitions.set(p.name, p);
    }
    const pipelines = new Map<string, ResolvedPipeline>();
    for (const def of definitions.values()) {
      if (def.steps.length === 0) throw new KestrelBootError(`pipelines/${def.name}`, "has no steps");
      pipelines.set(def.name, { name: def.name, steps: def.steps.map((s) => steps.resolve(s, `pipelines/${def.name}`)) });
    }

    const routes: Route[] = [];
    const events: EventEntry[] = [];
    const crons: CronEntry[] = [];
    const byPattern = new Map<string, string>();
    for (const t of config.triggers) {
      if (!pipelines.has(t.pipeline)) throw new KestrelBootError(CORE, `trigger references unknown pipeline "${t.pipeline}"`);
      let route: Route | undefined;
      try {
        if ("http" in t) route = parseRoute(t.http, t.pipeline);
        else if ("event" in t) events.push({ event: t.event, pipeline: t.pipeline });
        else crons.push(createCronEntry(t.cron, t.pipeline));
      } catch (err) {
        throw new KestrelBootError(CORE, `invalid trigger for "${t.pipeline}": ${err instanceof Error ? err.message : String(err)}`);
      }
      if (route === undefined) continue;
      const pattern = routePattern(route);
      const other = byPattern.get(pattern);
      if (other !== undefined) throw new KestrelBootError(CORE, `http triggers for pipelines "${other}" and "${t.pipeline}" both resolve to "${pattern}"`);
      byPattern.set(pattern, t.pipeline);
      routes.push(route);
    }

    for (const [name, pipeline] of pipelines) {
      checkDataflow(
        pipeline,
        routes.filter((r) => r.pipeline === name),
        crons.some((c) => c.pipeline === name),
        events.some((e) => e.pipeline === name),
      );
    }

    const eventHooks = ordered.filter((mod) => mod.triggers?.event !== undefined);
    if (eventHooks.length > 1) throw new KestrelBootError(CORE, `modules "${eventHooks[0]?.name ?? ""}" and "${eventHooks[1]?.name ?? ""}" both provide an event trigger hook`);
    if (events.length > 0 && eventHooks.length === 0) throw new KestrelBootError(CORE, "event triggers need a module that provides an event trigger hook");
    const eventHook = eventHooks[0];

    const runs = createRunTracker();
    const run = (name: string, ctxInput: ContextInput): Promise<RunResult> => {
      const pipeline = pipelines.get(name);
      if (!pipeline) throw new Error(`unknown pipeline "${name}"`);
      return runs.track(() => runPipeline(pipeline, ctxInput, logger, { validateInput: dev }));
    };

    let server: Server | undefined;
    const stoppers: Array<() => void> = [];
    let torndown = false;

    return {
      config,
      contracts,
      steps,
      pipelines,
      triggers: { http: routes, events, crons },
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
  } catch (err) {
    await teardownAll(ordered, instances, logger);
    throw err;
  }
}
