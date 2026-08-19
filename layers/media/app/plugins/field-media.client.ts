// components are NOT auto-imported in a plugin's script context — pull KestrelFieldMedia from #components
import { KestrelFieldMedia } from '#components'

export default defineNuxtPlugin(() => {
  registerFieldComponent('media', KestrelFieldMedia)
})
