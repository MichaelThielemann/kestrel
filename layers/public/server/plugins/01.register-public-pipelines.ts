import { registerPipeline } from '@kestrel/core'
import { buildPublicPipelines } from '../pipelines'

// Registration only — nothing resolves a pipeline here; the registry is read on the first request.
export default defineNitroPlugin(() => {
  for (const def of buildPublicPipelines()) registerPipeline(def)
})
