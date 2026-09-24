import { isStepFactory, type Step, type StepFactory, type StepMap } from "./context.ts";
import type { StepDescription, StepDescriptions } from "./defineModule.ts";
import { KestrelBootError } from "./errors.ts";
import { throwSink, type Sink } from "./sink.ts";

export interface ResolvedStep {
  name: string;
  fn: Step;
  description: StepDescription;
  /** The 1-based ordinal of the atomic group this step belongs to; absent outside a group. Steps of one group are consecutive. */
  atomic?: number;
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

function checkPaths(sink: Sink, owner: string, name: string, description: StepDescription): boolean {
  let ok = true;
  for (const path of description.reads) {
    if (validPath(path)) continue;
    sink.fail("invalid-read-path", owner, `step "${name}" declares an invalid read path "${path}"`, { step: name, path });
    ok = false;
  }
  for (const path of description.writes) {
    if (validPath(path)) continue;
    sink.fail("invalid-write-path", owner, `step "${name}" declares an invalid write path "${path}"`, { step: name, path });
    ok = false;
  }
  return ok;
}

type Entry =
  | { owner: string; factory: false; fn: Step; describe: StepDescription }
  | { owner: string; factory: true; fn: StepFactory; describe: StepDescriptions[string] };

export class StepRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly unregistered = new Set<string>();

  /**
   * Registers every step of one module. Given a collecting sink, a problem with one step (not a
   * function, a duplicate name, a missing or malformed `describe()` entry, an invalid path) skips
   * only that step and keeps registering the others; the default sink throws on the first one.
   */
  register(owner: string, prefix: string, steps: StepMap, descriptions: StepDescriptions = {}, sink: Sink = throwSink()): void {
    for (const key of stepKeys(steps)) {
      const fn = steps[key];
      const name = `${prefix}.${key}`;
      if (typeof fn !== "function") {
        sink.fail("step-not-function", owner, `step "${name}" is not a function`, { step: name });
        this.unregistered.add(name);
        continue;
      }
      const existing = this.entries.get(name);
      if (existing) {
        sink.fail("step-registered-twice", owner, `step "${name}" is already registered by ${existing.owner}`, { step: name });
        continue;
      }
      const describe = descriptions[key];
      if (describe === undefined) {
        sink.fail("step-undescribed", owner, `step "${name}" has no describe() entry`, { step: name });
        this.unregistered.add(name);
        continue;
      }
      if (typeof describe === "function") {
        if (!isStepFactory(fn)) {
          sink.fail("describe-shape", owner, `step "${name}" takes no argument but its describe() entry is a function`, { step: name });
          this.unregistered.add(name);
          continue;
        }
        let placeholder: StepDescription;
        try {
          placeholder = describe(PLACEHOLDER_ARG);
        } catch (err) {
          sink.fail("describe-threw", owner, `step "${name}" describe() threw for the placeholder argument "${PLACEHOLDER_ARG}": ${err instanceof Error ? err.message : String(err)}`, { step: name });
          this.unregistered.add(name);
          continue;
        }
        if (!checkPaths(sink, owner, name, placeholder)) {
          this.unregistered.add(name);
          continue;
        }
        this.entries.set(name, { owner, factory: true, fn, describe });
      } else {
        if (!checkPaths(sink, owner, name, describe)) {
          this.unregistered.add(name);
          continue;
        }
        this.entries.set(name, isStepFactory(fn) ? { owner, factory: true, fn, describe } : { owner, factory: false, fn, describe });
      }
    }
    for (const key of Object.keys(descriptions)) {
      if (!(key in steps)) sink.fail("describe-unknown-step", owner, `describe() names step "${prefix}.${key}" which does not exist`, { step: `${prefix}.${key}` });
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Every step name a `register()` call tried and failed to register, and so never resolves -- a pipeline referencing one fails with `unknown-step` for a reason already reported once, at registration. */
  failedToRegister(name: string): boolean {
    return this.unregistered.has(name);
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
    if (!entry) throw new KestrelBootError(owner, `unknown step "${name}"`, "unknown-step");
    if (arg === undefined) {
      if (entry.factory) throw new KestrelBootError(owner, `step "${name}" requires an argument`, "step-argument");
      return { name: spec, fn: entry.fn, description: entry.describe };
    }
    if (arg === "") throw new KestrelBootError(owner, `step "${name}" has an empty argument`, "step-argument");
    if (!entry.factory) throw new KestrelBootError(owner, `step "${name}" does not accept an argument`, "step-argument");
    const built = entry.fn(arg);
    if (typeof built !== "function") throw new KestrelBootError(owner, `step "${name}" returned ${typeof built} instead of a step`, "step-not-function");
    const description = typeof entry.describe === "function" ? checkPathsOrThrow(entry.owner, spec, entry.describe(arg)) : entry.describe;
    return { name: spec, fn: built, description };
  }
}

function checkPathsOrThrow(owner: string, name: string, description: StepDescription): StepDescription {
  checkPaths(throwSink(), owner, name, description);
  return description;
}
