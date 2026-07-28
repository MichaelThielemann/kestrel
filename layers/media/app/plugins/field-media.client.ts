// components are NOT auto-imported in a plugin's script context — pull FieldMedia from #components
import { FieldMedia } from '#components'

export default defineNuxtPlugin(() => {
  registerFieldComponent('media', FieldMedia)
})
