import { isStepFactory, type Step, type StepFactory, type StepMap } from "./context.ts";
import type { StepDescription, StepDescriptions } from "./defineModule.ts";
import { KestrelBootError } from "./errors.ts";

export interface ResolvedStep {
  name: string;
  fn: Step;
  description: StepDescription;
}

export interface RegisteredStep {
  name: string;
  owner: string;
  factory: boolean;
  describe: StepDescriptions[string];
}

const CONTEXT_PATH = /^[a-zA-Z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)*\??$/;

/** The argument a factory step's describe() sees when no pipeline supplies one. */
export const PLACEHOLDER_ARG = "<arg>";

// Walks the prototype chain (like `missingMethods` in defineContract.ts, via
// property access) so a class-instance step map registers its inherited methods too.
function stepKeys(steps: StepMap): string[] {
  const keys = new Set<string>();
  let obj: object | null = steps;
  while (obj && obj !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      if (key !== "constructor") keys.add(key);
    }
    obj = Reflect.getPrototypeOf(obj);
  }
  return [...keys];
}

function validPath(path: string): boolean {
  return CONTEXT_PATH.test(path.split(PLACEHOLDER_ARG).join("arg"));
}

function checkPaths(owner: string, name: string, description: StepDescription): StepDescription {
  for (const path of description.reads) {
    if (path.endsWith("?")) throw new KestrelBootError(owner, `step "${name}" reads "${path}"; the trailing "?" is allowed in writes only`);
    if (!validPath(path)) throw new KestrelBootError(owner, `step "${name}" declares an invalid read path "${path}"`);
  }
  for (const path of description.writes) {
    if (!validPath(path)) throw new KestrelBootError(owner, `step "${name}" declares an invalid write path "${path}"`);
  }
  return description;
}

type Entry =
  | { owner: string; factory: false; fn: Step; describe: StepDescription }
  | { owner: string; factory: true; fn: StepFactory; describe: StepDescriptions[string] };

export class StepRegistry {
  private readonly entries = new Map<string, Entry>();

  register(owner: string, prefix: string, steps: StepMap, descriptions: StepDescriptions = {}): void {
    for (const key of stepKeys(steps)) {
      const fn = steps[key];
      const name = `${prefix}.${key}`;
      if (typeof fn !== "function") throw new KestrelBootError(owner, `step "${name}" is not a function`);
      const existing = this.entries.get(name);
      if (existing) throw new KestrelBootError(owner, `step "${name}" is already registered by ${existing.owner}`);
      const describe = descriptions[key];
      if (describe === undefined) throw new KestrelBootError(owner, `step "${name}" has no describe() entry`);
      if (typeof describe === "function") {
        if (!isStepFactory(fn)) throw new KestrelBootError(owner, `step "${name}" takes no argument but its describe() entry is a function`);
        let placeholder: StepDescription;
        try {
          placeholder = describe(PLACEHOLDER_ARG);
        } catch (err) {
          throw new KestrelBootError(owner, `step "${name}" describe() threw for the placeholder argument "${PLACEHOLDER_ARG}": ${err instanceof Error ? err.message : String(err)}`);
        }
        checkPaths(owner, name, placeholder);
        this.entries.set(name, { owner, factory: true, fn, describe });
      } else {
        checkPaths(owner, name, describe);
        this.entries.set(name, isStepFactory(fn) ? { owner, factory: true, fn, describe } : { owner, factory: false, fn, describe });
      }
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

  owner(name: string): string | undefined {
    return this.entries.get(name)?.owner;
  }

  list(): RegisteredStep[] {
    return [...this.entries].map(([name, e]) => ({ name, owner: e.owner, factory: e.factory, describe: e.describe }));
  }

  resolve(spec: string, owner = "pipeline"): ResolvedStep {
    const colon = spec.indexOf(":");
    const name = colon === -1 ? spec : spec.slice(0, colon);
    const arg = colon === -1 ? undefined : spec.slice(colon + 1);
    const entry = this.entries.get(name);
    if (!entry) throw new KestrelBootError(owner, `unknown step "${name}"`);
    if (arg === undefined) {
      if (entry.factory) throw new KestrelBootError(owner, `step "${name}" requires an argument`);
      return { name: spec, fn: entry.fn, description: entry.describe };
    }
    if (arg === "") throw new KestrelBootError(owner, `step "${name}" has an empty argument`);
    if (!entry.factory) throw new KestrelBootError(owner, `step "${name}" does not accept an argument`);
    const built = entry.fn(arg);
    if (typeof built !== "function") throw new KestrelBootError(owner, `step "${name}" returned ${typeof built} instead of a step`);
    const description = typeof entry.describe === "function" ? checkPaths(entry.owner, spec, entry.describe(arg)) : entry.describe;
    return { name: spec, fn: built, description };
  }
}
