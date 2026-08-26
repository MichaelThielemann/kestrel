import { createError, getQuery, getRequestHeader, readRawBody } from 'h3'
import { Effect } from 'effect'
import { assertBodyLimit, definePipeline, eventOf } from '@michaelthielemann/kestrel-core'
import type { StepDef } from '@michaelthielemann/kestrel-core'
import { mediaRuntimeConfig, useStorageDriver } from '@michaelthielemann/kestrel-media'
import { galleryNamespace } from '../utils/namespace'

// Store one CIPHERTEXT image blob in a gallery's namespace. The editor encrypted it client-side, so the
// server NEVER sees the plaintext, the password, or the key — it just persists opaque bytes via Kestrel's
// storage driver under `galleries-secure/<galleryId>/<uuid>.bin` and returns the blob filename + its public
// URL. The blob is served STATICALLY as opaque ciphertext; the viewer decrypts it client-side.
const uploadBlob: StepDef = {
  name: 'uploadBlob',
  fn: (ctx) => Effect.gen(function* () {
    const event = eventOf(ctx)
    const ns = galleryNamespace(getQuery(event).galleryId)
    // Bound the ciphertext size (parity with the media upload); re-asserted on the buffered bytes below.
    const max = mediaRuntimeConfig().maxUploadBytes
    assertBodyLimit(getRequestHeader(event, 'content-length'), max)
    const body = yield* Effect.promise(() => readRawBody(event, false))
    const bytes = body instanceof Buffer ? new Uint8Array(body) : null
    if (!bytes?.length) throw createError({ statusCode: 400, statusMessage: 'empty ciphertext body' })
    if (bytes.length > max) throw createError({ statusCode: 413, statusMessage: 'Payload too large' })

    const driver = useStorageDriver()
    const blobId = `${crypto.randomUUID()}.bin`
    const key = `${ns}/${blobId}`
    yield* Effect.promise(() => driver.put(key, bytes, 'application/octet-stream'))
    ctx.output = { blobId, url: driver.publicUrl(key) }
  }),
}

export const secureGalleryUploadPipeline = definePipeline({
  name: 'secureGalleryUpload',
  access: { role: 'admin' },
  rawBody: true,
  steps: [uploadBlob],
})
