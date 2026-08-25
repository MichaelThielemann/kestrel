<script setup>
// CONSUMER public gallery page (Pruvious-style: the consumer owns the front-end route). Fetches ONE published
// gallery's manifest by slug from the scoped public endpoint, then renders the marking-capable proofing viewer
// (<SecureGalleryProofingView>, from kestrel-galleries-secure-proofing) so customers can flag/comment photos.
// `gallery-slug` MUST be the gallery RECORD's slug (the API returns it as `data.slug`) — the same key the
// photographer's editor reads — NOT `route.params.slug`/`$route.path`. Proofing needs a running server (the
// back-channel); for the pure-static enterprise base (no marking), drop 'kestrel-galleries-secure-proofing'
// from nuxt.config `extends` and render <SecureGalleryView :gallery="data.gallery" /> instead.
const route = useRoute()
const { data, error } = await useFetch('/api/publicGallery', { query: { slug: route.params.slug } })
</script>

<template>
  <main style="max-width: 60rem; margin: 1.5rem auto; padding: 0 1rem;">
    <SecureGalleryProofingView v-if="data?.gallery" :gallery="data.gallery" :gallery-slug="data.slug" />
    <p v-else>{{ error ? 'Gallery not found.' : 'This gallery has no photos yet.' }}</p>
  </main>
</template>
