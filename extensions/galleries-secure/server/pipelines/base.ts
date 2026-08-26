import { getQuery } from 'h3'
import { Effect } from 'effect'
import { definePipeline, eventOf } from '@michaelthielemann/kestrel-core'
import type { StepDef } from '@michaelthielemann/kestrel-core'
import { useStorageDriver } from '@michaelthielemann/kestrel-media'
import { galleryNamespace } from '../utils/namespace'

// Return the public `base` URL of a gallery's namespace so the editor knows where to fetch the encrypted
// index (`<base>/index.json`) + decrypt blobs (`<base>/<blobId>`). The id is in the field value, but the
// public URL depends on the driver (local `/uploads` vs S3 CDN), so the server resolves it.
const resolveBase: StepDef = {
  name: 'resolveBase',
  fn: (ctx) => Effect.sync(() => {
    const ns = galleryNamespace(getQuery(eventOf(ctx)).galleryId)
    ctx.output = { base: useStorageDriver().publicUrl(ns) }
  }),
}

export const secureGalleryBasePipeline = definePipeline({
  name: 'secureGalleryBase',
  read: true,
  access: { role: 'admin', scope: 'all' },
  steps: [resolveBase],
})
