import { registerPipeline } from '@michaelthielemann/kestrel-core'
import { buildMediaPipelines } from '@michaelthielemann/kestrel-media'

// Registration only — nothing resolves a pipeline here; the registry is read on the first request.
export default defineNitroPlugin(() => {
  for (const def of buildMediaPipelines()) registerPipeline(def)
})
