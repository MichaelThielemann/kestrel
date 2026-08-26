import { registerPipeline } from '@michaelthielemann/kestrel-core'
import { proofingSubmissionPipeline } from '../pipelines/mine'
import { proofingSubmitPipeline } from '../pipelines/submit'

// Registration only — nothing resolves a pipeline here; the registry is read on the first request.
export default defineNitroPlugin(() => {
  registerPipeline(proofingSubmissionPipeline)
  registerPipeline(proofingSubmitPipeline)
})
