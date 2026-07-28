// Kestrel extension layer — client PROOFING on top of kestrel-galleries-secure. OPT-IN, composed AFTER the
// base (and core):
//
//   extends: ['@thielemann/kestrel', '@thielemann/kestrel-galleries-secure', '@thielemann/kestrel-galleries-secure-proofing']
//
// Adds the photographer/customer proofing workflow: a public back-channel (`/api/galleries-secure-proofing`)
// where the customer POSTs CLIENT-ENCRYPTED colour/comment marks (server stores only ciphertext), a
// `galleryProofing` collection for persistence, and the customer/photographer views. It registers a single
// explicit access grant (anonymous → write → galleries-secure-proofing) via the core `access` grant seam.
// Unlike the base, this REQUIRES a running Node server (the back-channel) — NOT the pure-static deployment.
export default defineNuxtConfig({
  // Compose the base gallery layer underneath, so this layer's editor-widget override + the useSecureGallery
  // seam are always present regardless of how the consumer orders `extends`. Nuxt dedupes layers by resolved
  // path, so a consumer that also lists '@thielemann/kestrel-galleries-secure' is harmless.
  extends: ['@thielemann/kestrel-galleries-secure'],
})
