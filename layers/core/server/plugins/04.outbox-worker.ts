import { buildOutboxPipelines, makeTicker, registerPipeline, useDb } from '@kestrel/core'
/** Hard-coded to `content` — the only module with an outbox table today; extend alongside
 *  `pipelines/outbox.ts` if a second module gets one. */
const OUTBOX_MODULE = 'content'
const POLL_INTERVAL_MS = 1000

/**
 * The outbox worker: NOT a Nitro `scheduledTask` (those run per-request-worker in a way that doesn't suit
 * an always-on background loop here) — a plain `setInterval` loop started at plugin init, `unref`'d so it
 * never keeps the process alive on its own (a test/dev server can still exit while it's running).
 *
 * Polls every tick, unconditionally — no `PRAGMA data_version` short-circuit: `useDb()` is the process-
 * wide singleton connection every write also goes through, and a connection never observes its OWN writes
 * bumping `data_version` (only a write from a DIFFERENT connection does), so gating on it here would go
 * permanently blind after the first write this same connection ever made. The poll query itself is a
 * covered index search (see `outbox.ts`'s `readPendingOutbox`), cheap enough at a 1s interval to not need
 * a short-circuit at all.
 */
export default defineNitroPlugin(() => {
  // `makeTicker` takes `useDb` itself (a thunk), not its result — nothing here calls it, so the db is
  // still untouched at plugin-init time; the interval callback is the first thing that ever does.
  const tick = makeTicker(useDb, OUTBOX_MODULE)

  // Registration only — nothing here resolves a pipeline or reads the collection registry at init.
  for (const def of buildOutboxPipelines()) registerPipeline(def)

  const timer = setInterval(() => {
    tick().catch((error: unknown) => console.error('[kestrel] outbox worker tick failed', error))
  }, POLL_INTERVAL_MS)
  timer.unref?.()
})
