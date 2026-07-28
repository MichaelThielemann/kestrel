import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Marks an in-process request chain as the runtime publisher's render, so the access guard grants it the
 * same `renderer` principal that build-time prerender gets. The publisher's render does a nested
 * `$fetch('/api/route')`, which is NOT a public endpoint; without this it would 401 at runtime. Set via
 * AsyncLocalStorage — never a header — so an external HTTP request can't forge renderer access (and
 * resolvePage still enforces published-only, so drafts never reach the output regardless).
 */
const ctx = new AsyncLocalStorage<true>()

/** Run a publish render (and its nested API fetches) as the renderer principal. */
export function runAsRenderer<T>(fn: () => T): T {
  return ctx.run(true, fn)
}

/** True when executing inside a publisher render, so the access guard grants the renderer principal. */
export function isRendererContext(): boolean {
  return ctx.getStore() === true
}

const stageGate = new AsyncLocalStorage<true>()

/**
 * Marks the current request's async context as classified by the stage IP gate, so the in-process
 * sub-requests it spawns (the SSR page's own `$fetch`, the editor preview) are not gated again — they
 * reach the middleware stack on a mocked socket with no peer address and could never match a CIDR.
 *
 * `enterWith` rather than `run` because a middleware has no handle on the rest of its own request; the
 * mark is therefore reachable only from work descending from a request the gate already admitted, which
 * is what makes it unforgeable — unlike "this request has no socket peer", a property whole listeners
 * (unix domain sockets) have for every external client.
 */
export function markStageGatePassed(): void {
  stageGate.enterWith(true)
}

/** True inside a request whose originating request was already classified by the stage IP gate. */
export function isStageGatePassedContext(): boolean {
  return stageGate.getStore() === true
}
