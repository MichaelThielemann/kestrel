# kestrel-galleries-secure

An **opt-in** Kestrel extension layer: the **technical foundation for zero-knowledge encrypted galleries**.
Images *and* folder/file names are encrypted **client-side** with a password before upload — the server only
ever stores ciphertext, and anyone with the password (and the URL) can view the gallery. The password is
never stored and never sent to the server.

This is **not** part of the core `kestrel` package. A consumer opts in by composing it *after* the core:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  extends: ['@michaelthielemann/kestrel', '@michaelthielemann/galleries-secure'], // core first, then the extension
})
```

- In this monorepo it is a workspace package (the `playground` links it via `workspace:*`).
- An external project installs it: `pnpm add @michaelthielemann/kestrel kestrel-galleries-secure`.

## Primitives-only — you assemble the collection & block

This layer ships **building blocks**, not finished content types. You compose your own collection and block
from them (declarative config + a 3-line display wrapper) — and get the full encrypt/upload/decrypt flow
**without writing any crypto code**:

| Primitive | What it is |
|-----------|-----------|
| `secureGallery` **field type** | the admin input widget (set/enter password → pick → encrypt → upload ciphertext → manifest, with decrypted previews) + its storage/validation |
| `useSecureGallery()` **composable** | the headless core: password in → decrypted folder/file `tree` (or an error) out; plus `key`/`seal`/`open` |
| `<SecureGalleryView>` **component** | a ready-to-use public display built on the composable (default password form + folder/grid) |
| ciphertext **upload pipeline** | `POST /api/secureGalleryUpload` — admin-only; stores one opaque blob via `useStorageDriver()` |
| pure **utils** | `crypto`, `manifest`, `gallery` (seal/open), `tree` (folder build), `share-link` (`#key=` parsing) — node-tested |

### Recipe — a secure-gallery collection reachable by slug

```ts
// server/field-types — nothing to do; `secureGallery` is provided by this layer.

// server/collections/galleries.ts  — multi, slug (pageLike), "Public/Not public" (status)
export default defineCollection({
  name: 'galleries', mode: 'multi', pageLike: true, status: true,
  blocks: { enabled: true, allowed: ['myGallery'] },
  fields: { title: { type: 'text' } },
})
```
```vue
<!-- app/blocks/MyGallery.vue — one file: schema + display. `field('secureGallery')` is the generic
     escape hatch for a custom (defineFieldType) type; the block name comes from the filename. -->
<script setup>
defineProps({
  heading: textField(),
  gallery: field('secureGallery'),
})
defineBlock({ label: 'Gallery' })
</script>
<template>
  <h2 v-if="heading">{{ heading }}</h2>
  <SecureGalleryView :gallery="gallery" />
</template>
```

That's it: the collection gives you a slug-reachable page + a Public/Not-public toggle (Kestrel's
`pageLike`/`status`); the field gives you the encrypting editor; `<SecureGalleryView>` decrypts client-side.

**Localizing the view.** `<SecureGalleryView>`'s built-in strings are English (a public component has no
admin-i18n catalog). Override any of them with `:labels` — `empty`, `locked`, `password`, `decrypting`,
`view`, `decryptingStatus`:

```vue
<SecureGalleryView :gallery="gallery" :labels="{ locked: 'Passwort eingeben, um die Galerie zu sehen.', view: 'Ansehen' }" />
```

### Fully custom UI (own password field + own grid)

Skip `<SecureGalleryView>` and build on the composable directly:
```vue
<script setup>
const props = defineProps(['gallery'])
const { state, error, tree, unlock } = useSecureGallery(() => props.gallery)
const pw = ref('')
</script>
<template>
  <form v-if="state !== 'unlocked'" @submit.prevent="unlock(pw)">
    <input v-model="pw" type="password" /><button :disabled="state==='unlocking'">Open</button>
    <p v-if="error">{{ error }}</p>
  </form>
  <MyOwnGrid v-else :tree="tree" />
</template>
```

## How it stays zero-knowledge
Password + derived key live ONLY in the browser for the session — never persisted, never sent. The field
value itself is fully public and tiny: `{ galleryId, saltB64, verify, iterations, authIndex }` — a per-gallery
storage namespace id, the PBKDF2 salt, a sealed verify-token (to check the password), and the work factor the
key was derived at. The actual tree lives separately, in an encrypted **index** file in storage
(`galleries-secure/<galleryId>/index.json`): per item a ciphertext blob id + IV + sealed name/dir, cleartext
mime/size. AES-256-GCM, fresh IV per item; PBKDF2-SHA256 at 600,000 iterations for new galleries (the count is
recorded per-gallery so it can rise over time — pre-existing galleries were derived at 310,000 and keep
re-deriving at that count). The upload route only ever sees opaque bytes; the published static page ships
ciphertext blob ids/URLs + the decrypt JS, nothing else.

## Layout
```
nuxt.config.ts   # layer entry (main) — empty; the consumer owns the layer order
server/          # the secureGallery field-type + the ciphertext upload route
app/             # the editor widget, the useSecureGallery composable, <SecureGalleryView>, the utils
```

> **Deployment note.** The viewer `fetch()`es each ciphertext blob and reads its bytes — for a same-origin
> store (the local driver's `/uploads/…`) this just works. If the blobs live on a different origin (e.g. an
> S3/CDN base URL), that origin must send permissive CORS headers, since cross-origin `fetch()` of the bytes
> requires it (a plain `<img>` would not, but decryption needs the raw bytes).

> Status: feature-complete. The crypto + manifest + `gallery`/`tree`/`share-link`/`passphrase` utils are
> node-tested (incl. encrypted folders, the word-pattern passphrase, and verify-sentinel backward-compat);
> the field widget (folder input + passphrase suggestion), the `useSecureGallery` composable and
> `<SecureGalleryView>` are browser-verified (WebCrypto + uploads need a real browser), not in the headless
> suite. Run a real `nuxt build` of a consumer (e.g. the playground) as the bundle guard before publishing.
