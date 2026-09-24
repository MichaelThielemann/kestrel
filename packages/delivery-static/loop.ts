import { AsyncResource } from "node:async_hooks";
import type { Logger } from "@michaelthielemann/kestrel/logger";

/** What one pass of the loop reports: `busy` runs the next pass at once; otherwise the loop sleeps `sleepMs`, or until the next wake when `null`. */
export interface PassOutcome {
  busy: boolean;
  sleepMs: number | null;
}

export interface BackgroundLoop {
  /** Schedules a pass. Cheap and synchronous: it never runs the pass in the caller's async context, and the caller never waits for it. */
  wake(): void;
  /** Stops the loop and waits for the pass in progress. */
  stop(): Promise<void>;
  /** Whether a pass is running or scheduled. */
  active(): boolean;
}

export const ERROR_RETRY_MS = 5000;

/**
 * A single-flight background loop. Its driver is bound to the async context the loop was created in, so a wake from
 * inside a request carries no request, read or atomic scope into it. A wake while a pass runs only asks for one more.
 */
export function createBackgroundLoop(pass: () => Promise<PassOutcome>, logger: Logger, name: string): BackgroundLoop {
  let active = false;
  let again = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> | undefined;

  const run = async (): Promise<void> => {
    let sleepMs: number | null = null;
    try {
      while (!stopped) {
        again = false;
        const outcome = await pass();
        if (outcome.busy || again) continue;
        sleepMs = outcome.sleepMs;
        break;
      }
    } catch (error) {
      logger.error(`${name}: background pass failed, retrying`, { error: error instanceof Error ? error.message : String(error), retryInMs: ERROR_RETRY_MS });
      sleepMs = ERROR_RETRY_MS;
    } finally {
      active = false;
      if (!stopped) {
        if (again) wake();
        else if (sleepMs !== null) {
          timer = setTimeout(() => {
            timer = undefined;
            wake();
          }, sleepMs);
          timer.unref();
        }
      }
    }
  };

  const drive = AsyncResource.bind(() => {
    current = run();
  });

  function wake(): void {
    if (stopped) return;
    again = true;
    if (active) return;
    active = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    setImmediate(drive);
  }

  return {
    wake,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await current;
    },
    active: () => active,
  };
}
