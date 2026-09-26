import type { StepSet } from "../stepSet.ts";

const ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const PREFIX = /^[a-z][a-z0-9-]*$/;

/** Validates and freezes a {@link StepSet}: `id` and `prefix` shape, non-empty unique `steps` all under `prefix`. */
export function defineStepSet(input: StepSet): StepSet {
  if (!ID.test(input.id)) throw new Error(`defineStepSet: id "${input.id}" must look like "authn" or "events.delivery"`);
  if (!PREFIX.test(input.prefix)) throw new Error(`defineStepSet: prefix "${input.prefix}" must look like "authn"`);
  if (input.steps.length === 0) throw new Error(`defineStepSet: "${input.id}" declares no steps`);
  const seen = new Set<string>();
  for (const step of input.steps) {
    if (!step.startsWith(`${input.prefix}.`)) throw new Error(`defineStepSet: "${input.id}" step "${step}" does not start with "${input.prefix}."`);
    if (seen.has(step)) throw new Error(`defineStepSet: "${input.id}" declares "${step}" twice`);
    seen.add(step);
  }
  return { id: input.id, prefix: input.prefix, steps: [...input.steps] };
}

/** Collects step sets into one list, rejecting two sets that govern the same prefix. */
export function stepSets(sets: readonly StepSet[]): readonly StepSet[] {
  const byPrefix = new Map<string, string>();
  for (const set of sets) {
    const other = byPrefix.get(set.prefix);
    if (other) throw new Error(`stepSets: "${set.id}" and "${other}" both govern prefix "${set.prefix}"`);
    byPrefix.set(set.prefix, set.id);
  }
  return [...sets];
}
