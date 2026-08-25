/**
 * The producer/delivery seam for the ONE genuinely Nuxt-runtime primitive the publisher needs:
 * `useNitroApp().localFetch`. That call can only be made from inside a Nitro layer (nitropack's own
 * `#imports`/build graph) — a package has no access to it and must not try. The layer's own
 * `render-live.ts` (still `layers/public/server/utils/publish/render-live.ts`) exports the real
 * implementation; each real entry point that can trigger a publish (`zz.publish.ts`'s plugin body,
 * `tasks/publish/run.ts`'s task body) calls {@link setRenderRouteLive} explicitly, synchronously, right
 * before the only call that needs it — NOT as a module-load side effect: Nitro dev can re-evaluate a
 * task's module graph independently of a plugin's, so a boot-time-only wiring call would not reliably
 * reach the specific `@kestrel/publishing` instance a later task invocation resolves against. Mirrors the
 * config-provider seam's own set/get/clear shape.
 * @public
 */
export type RenderRouteLive = (route: string) => Promise<{ body: Buffer | null; status: number }>

let impl: RenderRouteLive | undefined

/** Call explicitly, synchronously, at the point of use — see this module's own TSDoc for why a module-load
 *  side effect is NOT safe here. Idempotent: harmless to call on every publish.
 * @public
 */
export function setRenderRouteLive(fn: RenderRouteLive): void {
  impl = fn
}

/** Render a public route via the seam's wired implementation. Throws loudly if no real entry point has
 *  called {@link setRenderRouteLive} yet — a silent no-op would mask a missing wiring call as some other
 *  failure downstream.
 * @public
 */
export function renderRouteLive(route: string): Promise<{ body: Buffer | null; status: number }> {
  if (!impl) {
    throw new Error(
      '[kestrel] renderRouteLive() called before setRenderRouteLive() — the caller (zz.publish.ts\'s plugin '
      + 'body, or tasks/publish/run.ts\'s task body) must call setRenderRouteLive(renderRouteLive) itself, '
      + 'synchronously, immediately before this call.',
    )
  }
  return impl(route)
}

/** Test-only reset, mirroring the config-provider seam's own `clearResolvedKestrelConfig()`.
 * @public
 */
export function clearRenderRouteLive(): void {
  impl = undefined
}
