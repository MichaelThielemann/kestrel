import { Effect } from 'effect'
import { definePipeline } from '@kestrel/core'
import type { StepDef } from '@kestrel/core'
import { useStorageDriver } from '@kestrel/media'
import { galleryNamespace } from '../utils/namespace'

// Recursively delete a whole gallery namespace (`galleries-secure/<galleryId>/` — all blobs + the index).
// Used by the editor's discard-cleanup for a gallery created in a draft that's abandoned without saving;
// the record-delete write-listener covers saved records.
const deleteNamespace: StepDef = {
  name: 'deleteNamespace',
  fn: (ctx) => Effect.gen(function* () {
    const body = ctx.input as { galleryId?: unknown } | undefined
    const ns = galleryNamespace(body?.galleryId)
    const driver = useStorageDriver()
    const removeDir = driver.removeDir
    if (typeof removeDir !== 'function') {
      // Don't report success for a delete that didn't happen — the whole namespace would orphan silently.
      console.warn(`[kestrel] galleries-secure: storage driver has no removeDir(); namespace "${ns}" was NOT deleted`)
      ctx.output = { ok: false, removed: false }
      return
    }
    yield* Effect.promise(() => removeDir(ns))
    ctx.output = { ok: true, removed: true }
  }),
}

export const secureGalleryNamespaceDeletePipeline = definePipeline({
  name: 'secureGalleryNamespaceDelete',
  access: { role: 'admin' },
  steps: [deleteNamespace],
})
