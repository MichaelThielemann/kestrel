import { isStepFactory, type Step, type StepFactory, type StepMap } from "./context.ts";
import type { StepDescription, StepDescriptions } from "./defineModule.ts";
import { KestrelBootError } from "./errors.ts";

export interface ResolvedStep {
  name: string;
  fn: Step;
  description: StepDescription;
}

const CONTEXT_PATH = /^[a-zA-Z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)*\??$/;

// Walks the prototype chain (like `missingMethods` in defineContract.ts, via
// property access) so a class-instance step map registers its inherited methods too.
function stepKeys(steps: StepMap): string[] {
  const keys = new Set<string>();
  for (let obj: object | null = steps; obj && obj !== Object.prototype; obj = Object.getPrototypeOf(obj) as object | null) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      if (key !== "constructor") keys.add(key);
    }
  }
  return [...keys];
}

function checkPaths(owner: string, name: string, description: StepDescription): StepDescription {
  for (const path of description.reads) {
    if (path.endsWith("?")) throw new KestrelBootError(owner, `step "${name}" reads "${path}"; the trailing "?" is allowed in writes only`);
    if (!CONTEXT_PATH.test(path)) throw new KestrelBootError(owner, `step "${name}" declares an invalid read path "${path}"`);
  }
  for (const path of description.writes) {
    if (!CONTEXT_PATH.test(path)) throw new KestrelBootError(owner, `step "${name}" declares an invalid write path "${path}"`);
  }
  return description;
}

export class StepRegistry {
  private readonly entries = new Map<string, { owner: string; fn: Step | StepFactory; describe: StepDescriptions[string] }>();

  register(owner: string, prefix: string, steps: StepMap, descriptions: StepDescriptions = {}): void {
    for (const key of stepKeys(steps)) {
      const value = (steps as Record<string, unknown>)[key];
      const name = `${prefix}.${key}`;
      if (typeof value !== "function") throw new KestrelBootError(owner, `step "${name}" is not a function`);
      const fn = value as Step | StepFactory;
      const existing = this.entries.get(name);
      if (existing) throw new KestrelBootError(owner, `step "${name}" is already registered by ${existing.owner}`);
      const describe = descriptions[key];
      if (describe === undefined) throw new KestrelBootError(owner, `step "${name}" has no describe() entry`);
      if (typeof describe === "function") {
        if (!isStepFactory(fn)) throw new KestrelBootError(owner, `step "${name}" takes no argument but its describe() entry is a function`);
      } else {
        checkPaths(owner, name, describe);
      }
      this.entries.set(name, { owner, fn, describe });
    }
    for (const key of Object.keys(descriptions)) {
      if (!(key in steps)) throw new KestrelBootError(owner, `describe() names step "${prefix}.${key}" which does not exist`);
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  resolve(spec: string, owner = "pipeline"): ResolvedStep {
    const colon = spec.indexOf(":");
    const name = colon === -1 ? spec : spec.slice(0, colon);
    const arg = colon === -1 ? undefined : spec.slice(colon + 1);
    const entry = this.entries.get(name);
    if (!entry) throw new KestrelBootError(owner, `unknown step "${name}"`);
    const factory = isStepFactory(entry.fn);
    if (arg === undefined) {
      if (factory) throw new KestrelBootError(owner, `step "${name}" requires an argument`);
      return { name: spec, fn: entry.fn as Step, description: entry.describe as StepDescription };
    }
    if (arg === "") throw new KestrelBootError(owner, `step "${name}" has an empty argument`);
    if (!factory) throw new KestrelBootError(owner, `step "${name}" does not accept an argument`);
    const built: unknown = (entry.fn as StepFactory)(arg);
    if (typeof built !== "function") throw new KestrelBootError(owner, `step "${name}" returned ${typeof built} instead of a step`);
    const description = typeof entry.describe === "function" ? checkPaths(entry.owner, spec, entry.describe(arg)) : entry.describe;
    return { name: spec, fn: built as Step, description };
  }
}
