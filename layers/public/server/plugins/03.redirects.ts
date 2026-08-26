import { Effect } from 'effect'
import { collectionOf, registerAfterStep } from '@michaelthielemann/kestrel-core'
import type { StepDef } from '@michaelthielemann/kestrel-core'
import { outputDriver, REDIRECTS_COLLECTION, REDIRECTS_FIELD, writeRedirectsArtifact } from '@michaelthielemann/kestrel-publishing'
import { invalidateLiveRedirects } from '@michaelthielemann/kestrel-delivery-live'

/**
 * Publish `redirects.json` on every save of the redirects singleton — deliberately decoupled from the
 * publish cycle, so a redirect goes live without a full republish (and without an editor pressing
 * Publish, which after ADR-0008 they otherwise would have to).
 *
 * A CRITICAL after-step, not a non-critical one: a save that reports success while the edge still serves
 * the old rules is exactly the failure this feature cannot have — its failure becomes the save's response.
 * Registered in every environment, unlike the publish plugin — that one is dev-gated because a dev publish
 * would write Vite-dev HTML with no hashed `_nuxt`, a CONTENT problem this artifact does not have (it is
 * `JSON.stringify` of DB rows, byte-identical either way).
 *
 * Where it lands is `output.dir` / the S3 prefix — the same target the publisher uses. With the classic
 * `output.auto: false` + `driver: 'local'` build model that is NOT the deployed tree, so there a
 * redirect goes live with the next `nuxt generate` instead; documented under Redirects in
 * `docs/guide/redirects.md`.
 */
export default defineNitroPlugin(() => {
  const writeRedirectsStep: StepDef = {
    name: 'writeRedirects',
    when: (ctx) => collectionOf(ctx).def.name === REDIRECTS_COLLECTION,
    whenLabel: `collection is "${REDIRECTS_COLLECTION}"`,
    fn: (ctx) => Effect.gen(function* () {
      const row = ctx.output as Record<string, unknown>
      // The row is already committed regardless of what the static artifact write below does (see its
      // own comment) — the live catch-all reads straight from the row, so its cache drops unconditionally,
      // in lockstep with every save.
      invalidateLiveRedirects()
      // A JS try/catch does NOT observe an Effect failure crossing a `yield*` — only Effect's own
      // combinators do — so the survivor rewrap has to be Effect.catchAll, not a wrapping try/catch.
      yield* Effect.tryPromise({ try: () => writeRedirectsArtifact(row[REDIRECTS_FIELD], outputDriver()), catch: (error) => error }).pipe(
        Effect.catchAll((error) => Effect.sync(() => {
          // The row is already committed (CRUD holds no transaction), so the only honest message is
          // "saved, but not live". Short and ASCII on purpose: h3 truncates nothing but the reason phrase is
          // the wire's, and the cause goes in `data` where nothing can strip it. `savedUpdatedAt` lets the
          // editor rebaseline on this failure the same way it would on success — it only rebaselines then.
          throw createError({
            statusCode: 500,
            statusMessage: 'Redirects saved, but publishing redirects.json failed. Save again to retry.',
            data: {
              cause: (error as Error)?.message ?? String(error),
              savedUpdatedAt: new Date(row.updatedAt as string | number).getTime(),
            },
          })
        })),
      )
    }),
  }
  registerAfterStep({ step: writeRedirectsStep, critical: true, ops: ['updateOne'] })
})
