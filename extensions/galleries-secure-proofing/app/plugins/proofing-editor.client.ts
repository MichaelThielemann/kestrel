// Override the `secureGallery` editor widget with the proofing-aware wrapper, so the photographer sees the
// customers' colour marks + comments INSIDE the record editor (no separate /review route). Client-only (the
// widget is browser-only). Pulled from `#components` (not auto-imported in a plugin's script scope).
//
// `enforce: 'post'` is LOAD-BEARING: Nuxt loads later-extended layers' plugins FIRST, so without it the
// BASE extension's registration (`galleries-secure.client`) runs AFTER this one and the base widget wins
// (override silently lost → no marks in the editor). The post phase runs after all default-phase plugins
// (incl. the base's), so this registration is last → wins, regardless of cross-layer plugin order.
// `defineNuxtPlugin` / `registerFieldComponent` are auto-imported.
import { FieldSecureGalleryProofingEditor } from '#components'

export default defineNuxtPlugin({
  name: 'kestrel-galleries-secure-proofing:editor',
  enforce: 'post',
  setup() {
    registerFieldComponent('secureGallery', FieldSecureGalleryProofingEditor)
  },
})
