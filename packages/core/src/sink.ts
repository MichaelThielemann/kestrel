import type { BootErrorCode } from "./errors.ts";
import { KestrelBootError } from "./errors.ts";

const CORE = "kestrel";

/** One boot problem, structured for the caller instead of an exception. */
export interface BootProblem {
  code: BootErrorCode;
  owner: string;
  reason: string;
  module?: string;
  pipeline?: string;
  step?: string;
  path?: string;
}

/**
 * Where a boot problem goes: `boot()` reports through a sink that throws immediately, so its
 * behaviour, order and messages are unchanged; `checkBoot()` reports through a sink that records
 * and lets the caller keep going. One engine, two sinks — the checks themselves never differ.
 */
export interface Sink {
  readonly collecting: boolean;
  fail(code: BootErrorCode, owner: string, reason: string, extra?: Partial<Pick<BootProblem, "step" | "path" | "module">>): void;
}

function ownerFields(owner: string): Pick<BootProblem, "module" | "pipeline"> {
  if (owner.startsWith("pipelines/")) return { pipeline: owner.slice("pipelines/".length) };
  if (owner === CORE) return {};
  return { module: owner };
}

export function throwSink(): Sink {
  return {
    collecting: false,
    fail(code, owner, reason) {
      throw new KestrelBootError(owner, reason, code);
    },
  };
}

export function collectSink(errors: BootProblem[]): Sink {
  return {
    collecting: true,
    fail(code, owner, reason, extra = {}) {
      errors.push({ code, owner, reason, ...ownerFields(owner), ...extra });
    },
  };
}
