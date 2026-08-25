import { registerPlanPublish } from '@kestrel/publishing'

export default defineNitroPlugin(() => {
  registerPlanPublish()
})
