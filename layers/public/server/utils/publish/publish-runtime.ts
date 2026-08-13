import type { PublishQueue } from './queue'
import type { DepsStore } from './deps'

/**
 * The process-wide handle on the running publish machinery. The `zz.publish` Nitro plugin owns the queue
 * and the deps index (it builds the output driver and does the logging), but the explicit publish action —
 * `POST /api/publish` — has to reach both from inside a request: the queue to enqueue the run, the deps
 * index to find the routes this record was baked into. Mirrors core's `write-events` registry: module
 * state, set once at boot.
 *
 * `null` wherever the runtime publisher does not run at all (dev, or `output.auto` off). That is not an
 * error — it is what the endpoint reports back so the editor can say "nothing is generated here" instead
 * of pretending a publish happened.
 */
export interface PublishRuntime {
  queue: PublishQueue
  deps: DepsStore
}

let runtime: PublishRuntime | null = null

export function setPublishRuntime(next: PublishRuntime | null): void {
  runtime = next
}

export function usePublishRuntime(): PublishRuntime | null {
  return runtime
}
