import { Effect } from 'effect'
import { definePipeline } from '@kestrel/core'
import type { StepDef } from '@kestrel/core'
import { useStorageDriver } from '@kestrel/media'
import { blobName, galleryNamespace } from '../utils/namespace'

// Delete one ciphertext blob from a gallery's namespace (so removing an image leaves no orphan — storage
// stays 1:1 with the index). The driver delete is idempotent.
const deleteBlob: StepDef = {
  name: 'deleteBlob',
  fn: (ctx) => Effect.gen(function* () {
    const body = ctx.input as { galleryId?: unknown; blobId?: unknown } | undefined
    const ns = galleryNamespace(body?.galleryId)
    const blob = blobName(body?.blobId)
    yield* Effect.promise(() => useStorageDriver().delete(`${ns}/${blob}`))
    ctx.output = { ok: true }
  }),
}

export const secureGalleryBlobDeletePipeline = definePipeline({
  name: 'secureGalleryBlobDelete',
  access: { role: 'admin' },
  steps: [deleteBlob],
})
