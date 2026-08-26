import { registerPipeline } from '@michaelthielemann/kestrel-core'
import { buildAuthPipelines } from '@michaelthielemann/kestrel-auth'

// Registration only — nothing resolves a pipeline here; the registry is read on the first request.
export default defineNitroPlugin(() => {
  for (const def of buildAuthPipelines()) registerPipeline(def)
})
