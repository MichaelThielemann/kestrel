import { registerPipeline } from '@kestrel/core'
import { buildAuthPipelines } from '@kestrel/auth'

// Registration only — nothing resolves a pipeline here; the registry is read on the first request.
export default defineNitroPlugin(() => {
  for (const def of buildAuthPipelines()) registerPipeline(def)
})
