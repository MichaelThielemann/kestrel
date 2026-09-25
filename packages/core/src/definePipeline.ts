/** A run of steps the runner executes inside one atomic scope: either every write commits, or none does. */
export interface AtomicGroup<S extends string = string> {
  readonly atomic: readonly S[];
}

/** One entry of a pipeline's step list: a step spec, or a group of them. */
export type PipelineEntry<S extends string = string> = S | AtomicGroup<S>;

export interface PipelineDefinition<S extends string = string> {
  name: string;
  steps: readonly PipelineEntry<S>[];
}

/** Narrows a {@link PipelineEntry} to an {@link AtomicGroup}, as opposed to a plain step name. */
export function isAtomicGroup<S extends string>(entry: PipelineEntry<S>): entry is AtomicGroup<S> {
  return typeof entry !== "string";
}

export function pipelineSteps<S extends string>(entries: readonly PipelineEntry<S>[]): S[] {
  return entries.flatMap((entry) => (isAtomicGroup(entry) ? [...entry.atomic] : [entry]));
}

export function definePipeline<S extends string = string>(def: PipelineDefinition<S>): PipelineDefinition<S> {
  if (def.name.trim() === "") throw new Error("definePipeline: name must not be empty");
  def.steps.forEach((entry, i) => {
    if (typeof entry === "string") return;
    if (entry === null || typeof entry !== "object" || !Array.isArray(entry.atomic)) {
      throw new Error(`definePipeline: pipeline "${def.name}" entry ${i} is neither a step name nor { atomic: [...] }`);
    }
    if (entry.atomic.length === 0) {
      throw new Error(`definePipeline: pipeline "${def.name}" has an empty atomic group`);
    }
    if (entry.atomic.some((step) => step !== null && typeof step === "object")) {
      throw new Error(`definePipeline: pipeline "${def.name}" has an atomic group inside an atomic group`);
    }
  });
  if (pipelineSteps(def.steps).length === 0) {
    throw new Error(`definePipeline: pipeline "${def.name}" has no steps`);
  }
  return def;
}

/** Binds `definePipeline` to a catalogue so pipeline files need no generic argument. */
export function pipelineDefiner<S extends string>(): (def: PipelineDefinition<S>) => PipelineDefinition<S> {
  return definePipeline;
}
