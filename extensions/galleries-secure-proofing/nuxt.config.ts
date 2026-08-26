// Kestrel extension layer — client PROOFING on top of kestrel-galleries-secure. OPT-IN, composed AFTER the
// base (and core):
//
//   extends: ['@michaelthielemann/kestrel', '@michaelthielemann/galleries-secure', '@michaelthielemann/galleries-secure-proofing']
//
// Adds the photographer/customer proofing workflow: a public back-channel (`/api/proofingSubmit`, plus the
// `/api/proofingSubmission` read-back) where the customer POSTs CLIENT-ENCRYPTED colour/comment marks (server
// stores only ciphertext), a `galleryProofing` collection for persistence, and the customer/photographer
// views. The two pipelines carry their own `access: { public: true }` declaration — narrower than a
// prefix-wide grant, since each authorizes exactly the one operation it declares.
// Unlike the base, this REQUIRES a running Node server (the back-channel) — NOT the pure-static deployment.
export default defineNuxtConfig({
  // Compose the base gallery layer underneath, so this layer's editor-widget override + the useSecureGallery
  // seam are always present regardless of how the consumer orders `extends`. Nuxt dedupes layers by resolved
  // path, so a consumer that also lists '@michaelthielemann/galleries-secure' is harmless.
  extends: ['@michaelthielemann/galleries-secure'],
})
