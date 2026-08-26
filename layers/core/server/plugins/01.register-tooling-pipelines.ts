import { buildToolingPipelines, registerPipeline } from '@michaelthielemann/kestrel-core'
// Registration only — nothing resolves a pipeline here; the registry is read on the first request.
export default defineNitroPlugin(() => {
  for (const def of buildToolingPipelines()) registerPipeline(def)
})
