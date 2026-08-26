import { registerReindexRefs } from '@michaelthielemann/kestrel-core'

export default defineNitroPlugin(() => {
  registerReindexRefs()
})
