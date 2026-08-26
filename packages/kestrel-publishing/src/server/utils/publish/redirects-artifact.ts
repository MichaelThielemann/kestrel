import type { StorageDriver } from '@michaelthielemann/kestrel-core'
import { contentTypeFor, cacheControlFor } from '@michaelthielemann/kestrel-core'
import { compileRedirects, serializeRedirects } from './redirect-rules.js'

/** The collection and the repeater field the artifact is compiled from, named once. */
/** @public */
export const REDIRECTS_COLLECTION = 'redirects'
/** @public */
export const REDIRECTS_FIELD = 'rules'

/** Literal key at the output root — a sibling of `index.html`, not a child of it. The driver's root IS
 *  the output root (local `output.dir`, or the S3 prefix), so a key can never sit *beside* that tree. */
/** @public */
export const REDIRECTS_KEY = 'redirects.json'

/**
 * Compile the editor's rows and publish them. Compilation runs first so an unpublishable rule fails
 * before the driver is touched, and the writer never swallows: a rejection is the caller's to surface.
 * @public
 */
export async function writeRedirectsArtifact(rows: unknown, driver: StorageDriver): Promise<void> {
  const body = Buffer.from(serializeRedirects(compileRedirects(rows)))
  await driver.put(REDIRECTS_KEY, body, contentTypeFor(REDIRECTS_KEY), { cacheControl: cacheControlFor(REDIRECTS_KEY) })
}
