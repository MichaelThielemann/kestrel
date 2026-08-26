import { registerPipeline } from '@michaelthielemann/kestrel-core'
import { buildBlocksPipelines } from '@michaelthielemann/kestrel-fields'

// Registration only — nothing resolves a pipeline here; the registry is read on the first request.
export default defineNitroPlugin(() => {
  for (const def of buildBlocksPipelines()) registerPipeline(def)
})
