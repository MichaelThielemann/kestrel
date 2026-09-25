import type { ZodTypeAny, output } from "zod";
import type { AtomicOutcome, AtomicScopeInfo, AtomicVerdict } from "./atomic.ts";
import type { StepFactory, StepMap } from "./context.ts";
import type { Contract } from "./defineContract.ts";
import type { Manifest } from "./describe.ts";
import type { Logger } from "./logger.ts";
import type { RunObserver, Unobserve } from "./observer.ts";
import type { Runner } from "./runner.ts";

/** Looking a contract up, plus the two ambient values every module needs. */
export interface ContractLookup {
  get<T>(contract: Contract<T>): T;
  find<T>(contract: Contract<T>): T | undefined;
  logger: Logger;
  root: string;
  /**
   * Epoch ms captured once at the very start of `boot()`, before any module's `setup()` runs, and
   * shared by every module's `setup()` call in this boot. Optional so a `Deps` built outside
   * `boot()` (a test double, an embedding host) still type-checks; code that needs a definite
   * instant falls back to `Date.now()`.
   */
  bootStartedAt?: number;
}

/** What a module's `setup()` receives. */
export interface Deps extends ContractLookup {
  /**
   * The event triggers from `kestrel.config`, in configuration order. Available during `setup()`, i.e.
   * before the pipelines are resolved, so a `pipeline` named here is not yet known to exist; boot rejects an
   * unknown one afterwards.
   */
  eventTriggers: readonly EventEntry[];
}

export type JsonSchema = Record<string, unknown>;

/** A context key optionally followed by dotted sub-keys; a trailing "?" marks a conditional write. */
export type ContextPath = string;

export interface StepDescription {
  summary: string;
  reads: readonly ContextPath[];
  writes: readonly ContextPath[];
  input?: JsonSchema;
  output?: JsonSchema;
  /** Merges into the currently active output schema (properties + required union) instead of replacing it; becomes the output if there was none yet. */
  extendsOutput?: JsonSchema;
  /** Like extendsOutput, but merges into `properties.items.items` of the active output when it is a list result; falls back to a root merge otherwise. Never applies to a step's `terminalOutput`. */
  extendsItems?: JsonSchema;
  /**
   * The complete shape of `result` when this step ends the run with `ctx.done()`. Not folded: no other
   * step's `output`, `extendsOutput` or `extendsItems` applies to it, and it does not apply to a run that
   * continues past this step. Required on every step that calls `ctx.done()`; boot cannot see that call,
   * so a missing declaration surfaces only at run time under `validateOutput`.
   */
  terminalOutput?: JsonSchema;
  query?: Record<string, JsonSchema>;
  errors?: Record<number, string>;
  security?: "required" | "optional";
  multipart?: boolean;
  binary?: boolean;
  /**
   * The step may run inside an atomic group: it writes only through the scoped `persistence@1` and has no
   * effect outside it, so a rollback undoes everything it did. It reaches nothing else, issues those calls
   * from its own async flow, starts no work it does not await and never runs another pipeline. It says
   * nothing about how long the step runs; a group holds the store's write lock for its whole duration.
   * Default: false.
   */
  atomicSafe?: boolean;
  /**
   * The data this step returns is also published where no access check applies, so every pipeline that runs
   * the step must let an anonymous caller through. `authz-roles` checks this when the instance is attached
   * and fails boot otherwise. Boot itself does not evaluate grants, and `authz@1` has no anonymous verdict:
   * another `authz@1` provider must perform the same check itself, or the flag goes unchecked.
   */
  anonymous?: "required";
}

type DescriptionOf<F> = F extends StepFactory ? (arg: string) => StepDescription : StepDescription;

export type StepDescriptions<T extends StepMap = StepMap> = {
  [K in keyof T & string]: DescriptionOf<T[K]>;
};

export interface EventEntry {
  event: string;
  pipeline: string;
}

/** `event` subscribes the module's own bus to the configured entries and returns the stop function the core calls on `stop()`. */
export interface ModuleTriggers<P> {
  event?(instance: P, entries: readonly EventEntry[], run: Runner, logger: Logger): () => void;
}

/**
 * A module's own read of its instance state, synchronous and with no I/O: never the outcome of a
 * call, since a readiness probe must never depend on lock contention or an in-flight request.
 *
 * `ok: true` may carry an informational `note` (e.g. a pending action that does not affect
 * service). `ok: false` names the `reason` and whether the process needs a restart before the
 * module can serve again; a module never reports transient contention (a busy lock, a retryable
 * timeout) through this hook.
 *
 * A count of failed work (a dead letter, a failed delivery) is never health: it does not stop this
 * instance from serving.
 */
export type ModuleHealth = { ok: true; note?: string } | { ok: false; reason: string; restartRequired: boolean };

/**
 * The aggregate health of a booted instance, over every module that declares `health()`; a module
 * without the hook is left out. `ok` is false if any listed module is not ok. `restartRequired` is
 * true if any listed module reports it. A hook that throws lists its module as
 * `{ ok: false, reason: "health() threw", restartRequired: false }`.
 */
export interface InstanceHealth {
  ok: boolean;
  restartRequired: boolean;
  modules: Array<{ module: string } & ModuleHealth>;
}

/** The read-only view of the booted instance a module's `attach` hook receives: the static manifest, the run observer registration and the aggregate health. */
export interface Introspection {
  describe: () => Manifest;
  observe: (observer: RunObserver) => Unobserve;
  /**
   * Aggregates every module's {@link ModuleHealth}, synchronously and with no I/O.
   *
   * A readiness probe should read `ok`: false means route no traffic here; this never depends on
   * lock contention or an in-flight call, because no module hook may report the outcome of one. A
   * liveness probe should read `restartRequired`: true means the process cannot recover on its own
   * and needs a restart, not a retry.
   */
  health: () => InstanceHealth;
}

export type Detach = () => void;

export interface ModuleDefinition<N extends string = string, T extends StepMap = StepMap> {
  name: N;
  provides: readonly Contract<unknown>[];
  requires: readonly Contract<unknown>[];
  optional?: readonly Contract<unknown>[];
  /** Contracts whose provider is set up after this module. A declarer whose target's provider depends on it, directly or transitively, fails boot as a dependency cycle. */
  before?: readonly Contract<unknown>[];
  configSchema: ZodTypeAny;
  setup(config: unknown, deps: Deps): Promise<unknown>;
  steps?(instance: unknown): T;
  describe?(instance: unknown): StepDescriptions<T>;
  emits?: readonly string[];
  triggers?: ModuleTriggers<unknown>;
  /** Runs once at the end of boot, after every module is set up and every pipeline resolved; a returned function runs on `stop()`. */
  attach?(instance: unknown, kestrel: Introspection): Detach | void;
  teardown?(instance: unknown): void | Promise<void>;
  /** Wraps an atomic group of a pipeline in one all-or-nothing scope of this module's store. At most one loaded module may declare it. */
  atomicScope?(instance: unknown, info: AtomicScopeInfo, body: () => Promise<AtomicVerdict>): Promise<AtomicOutcome>;
  /** Reads the instance's own state, synchronously and with no I/O, for {@link Kestrel.health}. A module without this hook is left out of the aggregate. */
  health?(instance: unknown): ModuleHealth;
}

type WithSteps<P, T extends StepMap> = { steps(instance: P): T; describe(instance: P): StepDescriptions<T> };
type WithoutSteps = { steps?: never; describe?: never };

export type ModuleInput<N extends string, S extends ZodTypeAny, P, T extends StepMap> = {
  name: N;
  provides: readonly Contract<unknown>[];
  requires: readonly Contract<unknown>[];
  optional?: readonly Contract<unknown>[];
  before?: readonly Contract<unknown>[];
  configSchema: S;
  setup(config: output<S>, deps: Deps): Promise<P>;
  emits?: readonly string[];
  triggers?: ModuleTriggers<P>;
  attach?(instance: P, kestrel: Introspection): Detach | void;
  teardown?(instance: P): void | Promise<void>;
  atomicScope?(instance: P, info: AtomicScopeInfo, body: () => Promise<AtomicVerdict>): Promise<AtomicOutcome>;
  health?(instance: P): ModuleHealth;
} & (WithSteps<P, T> | WithoutSteps);

export function defineModule<const N extends string, S extends ZodTypeAny, P, T extends StepMap = Record<never, never>>(def: ModuleInput<N, S, P, T>): ModuleDefinition<N, T> {
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(def.name)) {
    throw new Error(`defineModule: name "${def.name}" must look like "<module>/<submodule>"`);
  }
  return def;
}

export function stepPrefix(moduleName: string): string {
  return moduleName.split("/")[0] ?? moduleName;
}
