import { registerMediaCleanup } from '@michaelthielemann/kestrel-media'

export default defineNitroPlugin(() => {
  registerMediaCleanup()
})
