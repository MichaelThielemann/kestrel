// Register the editor widget for the `secureGallery` field type. Client-only: the widget is browser-only
// (WebCrypto + file uploads), and `registerFieldComponent` mutates the client-side widget registry. The
// component isn't auto-imported in a plugin's script scope, so it's pulled from `#components` (the
// generated barrel) — same pattern as Kestrel's own `field-media.client.ts`. `defineNuxtPlugin` and
// `registerFieldComponent` are auto-imported from Nuxt + Kestrel.
import { FieldSecureGallery } from '#components'

export default defineNuxtPlugin(() => {
  registerFieldComponent('secureGallery', FieldSecureGallery)
})
