import type { ZodTypeAny, output } from "zod";
import type { StepFactory, StepMap } from "./context.ts";
import type { Contract } from "./defineContract.ts";
import type { Manifest } from "./describe.ts";
import type { Logger } from "./logger.ts";
import type { RunObserver, Unobserve } from "./observer.ts";
import type { Runner } from "./runner.ts";

export interface Deps {
  get<T>(contract: Contract<T>): T;
  find<T>(contract: Contract<T>): T | undefined;
  logger: Logger;
  root: string;
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
  /** Like extendsOutput, but merges into `properties.items.items` of the active output when it is a list result; falls back to a root merge otherwise. */
  extendsItems?: JsonSchema;
  query?: Record<string, JsonSchema>;
  errors?: Record<number, string>;
  security?: "required" | "optional";
  multipart?: boolean;
  binary?: boolean;
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

/** The read-only view of the booted instance a module's `attach` hook receives: the static manifest and the run observer registration. */
export interface Introspection {
  describe: () => Manifest;
  observe: (observer: RunObserver) => Unobserve;
}

export type Detach = () => void;

export interface ModuleDefinition<N extends string = string, T extends StepMap = StepMap> {
  name: N;
  provides: readonly Contract<unknown>[];
  requires: readonly Contract<unknown>[];
  optional?: readonly Contract<unknown>[];
  configSchema: ZodTypeAny;
  setup(config: unknown, deps: Deps): Promise<unknown>;
  steps?(instance: unknown): T;
  describe?(instance: unknown): StepDescriptions<T>;
  emits?: readonly string[];
  triggers?: ModuleTriggers<unknown>;
  /** Runs once at the end of boot, after every module is set up and every pipeline resolved; a returned function runs on `stop()`. */
  attach?(instance: unknown, kestrel: Introspection): Detach | void;
  teardown?(instance: unknown): void | Promise<void>;
}

type WithSteps<P, T extends StepMap> = { steps(instance: P): T; describe(instance: P): StepDescriptions<T> };
type WithoutSteps = { steps?: never; describe?: never };

export type ModuleInput<N extends string, S extends ZodTypeAny, P, T extends StepMap> = {
  name: N;
  provides: readonly Contract<unknown>[];
  requires: readonly Contract<unknown>[];
  optional?: readonly Contract<unknown>[];
  configSchema: S;
  setup(config: output<S>, deps: Deps): Promise<P>;
  emits?: readonly string[];
  triggers?: ModuleTriggers<P>;
  attach?(instance: P, kestrel: Introspection): Detach | void;
  teardown?(instance: P): void | Promise<void>;
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
