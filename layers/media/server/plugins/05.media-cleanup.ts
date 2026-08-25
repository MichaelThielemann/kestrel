import { registerMediaCleanup } from '@kestrel/media'

export default defineNitroPlugin(() => {
  registerMediaCleanup()
})
