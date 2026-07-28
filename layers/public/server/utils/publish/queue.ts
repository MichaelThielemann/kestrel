import type { Invalidation } from './invalidation'
import { coalesce } from './coalesce'

export interface PublishQueueOptions {
  /** Dispatch a coalesced invalidation (full or tags). Rejections are caught + re-queued. */
  run: (inv: Invalidation) => Promise<void>
  /** Quiet window before a pending batch fires (default 3000ms). */
  debounceMs?: number
  /** Cap on how long a steady stream of writes can defer the flush (default 60000ms). */
  maxWaitMs?: number
  onError?: (error: unknown) => void
}

export interface PublishQueue {
  /** Record an invalidation; a coalesced run fires after the quiet window. noop is ignored. */
  enqueue: (inv: Invalidation) => void
}

/**
 * Debounce + coalesce + single-flight queue for publish invalidations. A burst of content writes
 * collapses to ONE run after a quiet window (capped by maxWait); only one run is in flight at a time,
 * and anything enqueued mid-run defers to the next pass — so a publish always reflects the CURRENT DB
 * state and converges (idempotent). A failed run re-queues its batch (never silently drops writes).
 */
export function createPublishQueue(opts: PublishQueueOptions): PublishQueue {
  const debounceMs = opts.debounceMs ?? 3000
  const maxWaitMs = opts.maxWaitMs ?? 60000
  let pending: Invalidation[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0
  let running = false

  function arm() {
    if (timer) clearTimeout(timer)
    const now = Date.now()
    if (!firstAt) firstAt = now
    const wait = Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now))
    timer = setTimeout(flush, wait)
  }

  function flush() {
    timer = null
    firstAt = 0
    if (running || pending.length === 0) return // a run is in flight; its finally() re-arms
    const inv = coalesce(pending)
    pending = []
    if (inv.type === 'noop') return
    running = true
    void opts.run(inv)
      .catch((error) => {
        opts.onError?.(error)
        pending.unshift(inv) // never drop a batch on failure — retry on the next pass
      })
      .finally(() => {
        running = false
        if (pending.length) arm()
      })
  }

  function enqueue(inv: Invalidation) {
    if (inv.type === 'noop') return
    pending.push(inv)
    if (!running) arm() // mid-run enqueues are collected; finally() re-arms once the run settles
  }

  return { enqueue }
}
