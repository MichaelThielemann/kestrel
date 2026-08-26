import { runAsRenderer } from '@michaelthielemann/kestrel-access'

/** Render a public route via the in-process server, returning its HTML buffer (200) or a null body with the
 *  HTTP status, so the caller can tell a broken page (5xx — a server-error RESPONSE, not a throw) from an
 *  expected non-200 (a draft / unpublish race → 404 / redirect). The PRODUCER's own render primitive — the
 *  delivery-static side never calls this; see `@michaelthielemann/kestrel-delivery-static`'s `render-route.ts`. `@michaelthielemann/kestrel-publishing`
 *  never imports this directly (a package cannot reach `useNitroApp`) — each real
 *  entry point (`zz.publish.ts`, `tasks/publish/run.ts`) instead calls `setRenderRouteLive(renderRouteLive)`
 *  itself, right before the call that needs it (see either file's own comment for why NOT a module-load
 *  side effect: Nitro dev can re-evaluate a task's module graph per invocation). */
export async function renderRouteLive(route: string): Promise<{ body: Buffer | null; status: number }> {
  // Run as the renderer principal so the nested $fetch('/api/route') passes the access guard (it is not a
  // public endpoint). The ALS context propagates through localFetch → the page render → the nested fetch.
  // useNitroApp is imported LAZILY (not via the Nitro auto-import) on purpose: a static import gives this
  // module an edge to nitropack's app.mjs, which both defines useNitroApp AND loads the plugin registry
  // that reaches this file (via zz.publish) — a build-time circular dependency. A dynamic import is a chunk
  // boundary, so that cycle disappears from the build graph; it's the same nitroApp singleton either way
  // (Rollup bundles the literal specifier; useNitroApp is only CALLED here at publish time, long after boot).
  const { useNitroApp } = await import('nitropack/runtime')
  // Every consumer that needs to know "is this OUR OWN in-process render" (delivery-live's catch-all,
  // media's variant-capture scan) reads `isRendererContext()`/`import.meta.prerender` instead of a header —
  // both are set by `runAsRenderer` below and an external request can't forge either.
  const res = await runAsRenderer(() => useNitroApp().localFetch(route, { method: 'GET' }))
  if (res.status !== 200) return { body: null, status: res.status }
  return { body: Buffer.from(await res.arrayBuffer()), status: res.status }
}
