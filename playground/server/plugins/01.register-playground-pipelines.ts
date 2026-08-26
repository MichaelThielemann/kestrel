import { registerPipeline } from '@michaelthielemann/kestrel-core'
import { publicGalleryPipeline } from '../pipelines/public-gallery'

// Registration only — nothing resolves a pipeline here; the registry is read on the first request. This is
// the reference example of a consuming project registering its own pipeline, exactly the way a built-in
// layer does.
export default defineNitroPlugin(() => {
  registerPipeline(publicGalleryPipeline)
})
