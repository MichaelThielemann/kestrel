export interface PipelineDefinition<S extends string = string> {
  name: string;
  steps: readonly S[];
}

export function definePipeline<S extends string = string>(def: PipelineDefinition<S>): PipelineDefinition<S> {
  if (def.name.trim() === "") throw new Error("definePipeline: name must not be empty");
  if (def.steps.length === 0) throw new Error(`definePipeline: pipeline "${def.name}" has no steps`);
  return def;
}

/** Binds `definePipeline` to a catalogue so pipeline files need no generic argument. */
export function pipelineDefiner<S extends string>(): (def: PipelineDefinition<S>) => PipelineDefinition<S> {
  return definePipeline;
}
