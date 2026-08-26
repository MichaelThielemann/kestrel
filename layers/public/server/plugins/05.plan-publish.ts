import { registerPlanPublish } from '@michaelthielemann/kestrel-publishing'

export default defineNitroPlugin(() => {
  registerPlanPublish()
})
