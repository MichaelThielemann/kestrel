import type { Trigger } from "./context.ts";
import type { Logger, StepLog } from "./logger.ts";

export interface RunStartEvent {
  runId: string;
  parentRunId?: string;
  requestId?: string;
  pipeline: string;
  trigger: Trigger;
  at: number;
}

export interface RunEndEvent extends RunStartEvent {
  ms: number;
  status: number;
  outcome: "ok" | "fail" | "error";
  code?: string;
  step?: string;
}

export interface StepStartEvent {
  runId: string;
  pipeline: string;
  step: string;
  at: number;
}

export interface StepEndEvent extends StepStartEvent {
  ms: number;
  status: number;
  outcome: StepLog["outcome"];
}

/** Every method is optional and synchronous; a throwing observer is logged and never touches the run. */
export interface RunObserver {
  runStart?(event: RunStartEvent): void;
  runEnd?(event: RunEndEvent): void;
  stepStart?(event: StepStartEvent): void;
  stepEnd?(event: StepEndEvent): void;
}

export type Unobserve = () => void;

export interface ObserverHub {
  observer: RunObserver;
  observe: (observer: RunObserver) => Unobserve;
}

export function createObserverHub(logger: Logger): ObserverHub {
  const observers = new Set<RunObserver>();
  const fanout = <K extends keyof RunObserver>(method: K, event: Parameters<NonNullable<RunObserver[K]>>[0]): void => {
    for (const observer of observers) {
      try {
        (observer[method] as ((e: typeof event) => void) | undefined)?.call(observer, event);
      } catch (err) {
        logger.error(`run observer ${method} threw`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  return {
    observer: {
      runStart: (e) => fanout("runStart", e),
      runEnd: (e) => fanout("runEnd", e),
      stepStart: (e) => fanout("stepStart", e),
      stepEnd: (e) => fanout("stepEnd", e),
    },
    observe: (observer) => {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
  };
}
