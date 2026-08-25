import { registerPipeline } from '@kestrel/core'
import { secureGalleryBasePipeline } from '../pipelines/base'
import { secureGalleryBlobDeletePipeline } from '../pipelines/blob-delete'
import { secureGalleryNamespaceDeletePipeline } from '../pipelines/namespace-delete'
import { secureGalleryTreePipeline } from '../pipelines/tree'
import { secureGalleryUploadPipeline } from '../pipelines/upload'

// Registration only — nothing resolves a pipeline here; the registry is read on the first request.
export default defineNitroPlugin(() => {
  registerPipeline(secureGalleryBasePipeline)
  registerPipeline(secureGalleryTreePipeline)
  registerPipeline(secureGalleryUploadPipeline)
  registerPipeline(secureGalleryBlobDeletePipeline)
  registerPipeline(secureGalleryNamespaceDeletePipeline)
})
