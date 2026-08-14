import { registerWriteEffect } from '../../../core/server/utils/write-effects'
import { outputDriver } from '../utils/publish/publisher'
import { REDIRECTS_COLLECTION, REDIRECTS_FIELD, writeRedirectsArtifact } from '../utils/publish/redirects-artifact'

/**
 * Publish `redirects.json` on every save of the redirects singleton — deliberately decoupled from the
 * publish cycle, so a redirect goes live without a full republish (and without an editor pressing
 * Publish, which after ADR-0008 they otherwise would have to).
 *
 * A write EFFECT, not a write listener: the bus swallows throws, and a save that reports success while
 * the edge still serves the old rules is exactly the failure this feature cannot have. Registered in
 * every environment, unlike the publish plugin — that one is dev-gated because a dev publish would write
 * Vite-dev HTML with no hashed `_nuxt`, a CONTENT problem this artifact does not have (it is
 * `JSON.stringify` of DB rows, byte-identical either way).
 *
 * Where it lands is `output.dir` / the S3 prefix — the same target the publisher uses. With the classic
 * `output.auto: false` + `driver: 'local'` build model that is NOT the deployed tree, so there a
 * redirect goes live with the next `nuxt generate` instead; documented under Redirects in
 * `docs/static-output.md`.
 */
export default defineNitroPlugin(() => {
  registerWriteEffect(async ({ def, row }) => {
    if (def.name !== REDIRECTS_COLLECTION) return
    try {
      await writeRedirectsArtifact(row[REDIRECTS_FIELD], outputDriver())
    } catch (error) {
      // The row is already committed (CRUD holds no transaction), so the only honest message is
      // "saved, but not live". Short and ASCII on purpose: h3 truncates nothing but the reason phrase is
      // the wire's, and the cause goes in `data` where nothing can strip it.
      throw createError({
        statusCode: 500,
        statusMessage: 'Redirects saved, but publishing redirects.json failed. Save again to retry.',
        data: { cause: (error as Error)?.message ?? String(error) },
      })
    }
  })
})
