import { isAtomicGroup, type PipelineEntry } from "./definePipeline.ts";

/** Flattens a pipeline's entries, resolving each step with `resolve` and stamping the 1-based ordinal of the atomic group it came from, if any. */
export function resolveEntries<S extends string, R extends { atomic?: number }>(
  entries: readonly PipelineEntry<S>[],
  resolve: (step: S) => R,
): R[] {
  let ordinal = 0;
  return entries.flatMap((entry): R[] => {
    if (!isAtomicGroup(entry)) return [resolve(entry)];
    ordinal += 1;
    const group = ordinal;
    return entry.atomic.map((step) => ({ ...resolve(step), atomic: group }));
  });
}
