import type { StepFactory, StepMap } from "./context.ts";
import type { ModuleDefinition } from "./defineModule.ts";

type Prefix<N extends string> = N extends `${infer P}/${string}` ? P : never;

type StepNamesOf<P extends string, T extends StepMap> = {
  [K in keyof T & string]: T[K] extends StepFactory ? `${P}.${K}:${string}` : `${P}.${K}`;
}[keyof T & string];

/** Every step name a module registers, factories with their `:arg` tail. */
export type StepsOf<M> = M extends ModuleDefinition<infer N, infer T> ? StepNamesOf<Prefix<N>, T> : never;

/** The union for a loaded module list — the `modules` array a consumer hands to `boot()`. */
export type StepCatalogue<Ms extends readonly ModuleDefinition[]> = StepsOf<Ms[number]>;
