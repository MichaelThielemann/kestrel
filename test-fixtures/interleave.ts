import { AsyncLocalStorage } from "node:async_hooks";

const tracker = new AsyncLocalStorage<true>();
let handler: (() => Promise<void>) | null = null;

function asTarget<T>(fn: () => Promise<T>): Promise<T> {
  return tracker.run(true, fn);
}

/** Wraps the named methods of `target` in place: a call made from inside `asTarget(...)` awaits the active handler; every other call passes straight through. */
export function patchGate<T extends object>(target: T, methods: ReadonlyArray<keyof T>): void {
  const mutable = target as Record<string | symbol, unknown>;
  for (const method of methods) {
    const original = (mutable[method as string] as (...args: unknown[]) => unknown).bind(target);
    mutable[method as string] = async (...args: unknown[]) => {
      if (tracker.getStore() === true && handler !== null) await handler();
      return original(...args);
    };
  }
}

/** Counts how many gated calls one operation makes when run alone. */
export async function countGateCalls(run: () => Promise<void>): Promise<number> {
  let n = 0;
  handler = async () => {
    n += 1;
  };
  try {
    await asTarget(run);
  } finally {
    handler = null;
  }
  return n;
}

/** Pauses `target` right before its `index`-th gated call (0-based), runs `between` to completion ungated, then lets `target` finish; a target that makes fewer calls simply finishes before `between` runs. */
export async function runWithGapAt(index: number, target: () => Promise<void>, between: () => Promise<void>): Promise<void> {
  let seen = -1;
  let resolveArmed: () => void = () => {};
  const armed = new Promise<void>((resolve) => {
    resolveArmed = resolve;
  });
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  handler = async () => {
    seen += 1;
    if (seen === index) {
      resolveArmed();
      await gate;
    }
  };
  const targetDone = asTarget(target);
  await Promise.race([armed, targetDone]);
  await between();
  releaseGate();
  await targetDone;
  handler = null;
}

/** Runs `first` to completion, then `second` to completion: the baseline with no overlap at all. */
export async function runSequential(first: () => Promise<void>, second: () => Promise<void>): Promise<void> {
  await first();
  await second();
}
