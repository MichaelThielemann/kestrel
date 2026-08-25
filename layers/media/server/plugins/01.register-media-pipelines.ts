import { registerPipeline } from '@kestrel/core'
import { buildMediaPipelines } from '@kestrel/media'

// Registration only — nothing resolves a pipeline here; the registry is read on the first request.
export default defineNitroPlugin(() => {
  for (const def of buildMediaPipelines()) registerPipeline(def)
})
