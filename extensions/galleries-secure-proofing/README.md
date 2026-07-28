# kestrel-galleries-secure-proofing

An **opt-in** Kestrel extension that adds a **client proofing** workflow on top of
[`kestrel-galleries-secure`](../galleries-secure): the customer opens a secure gallery and marks photos
Lightroom-style (colour flags + comments); the photographer reviews those marks, read-only, in the backend.

Compose it **after** the core and the base:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  extends: ['@thielemann/kestrel', '@thielemann/kestrel-galleries-secure', '@thielemann/kestrel-galleries-secure-proofing'],
})
```

## Zero-knowledge is preserved
The customer is anonymous to the server (the gallery password never reaches it). Marks/comments are
**encrypted client-side** under the gallery key (via the base's `useSecureGallery().seal`) and POSTed as
**ciphertext** to a public back-channel; the server stores only opaque bytes; the photographer decrypts
them in the backend (`open`). The server never sees plaintext.

## Deployment — needs a running server (NOT pure-static)
Unlike the base (which can deploy as a 100%-static site), this extension ships a **public write route**
(`/api/galleries-secure-proofing/submit`) + a `galleryProofing` table, so it requires a running Node
server. Keep it OUT of any deployment that must stay fully static (e.g. an enterprise pilot) — simply don't
compose this layer there; the base + the core `access` grant seam stay inert without it.

## What it ships (primitives)
| Primitive | Role |
|-----------|------|
| `galleryProofing` collection | persistence — one (encrypted) submission per (gallery, customer) |
| `POST /api/galleries-secure-proofing/submit` | public back-channel — same-site + rate-limited + size-capped; stores ciphertext only |
| access grant (server plugin) | registers `anonymous → write → galleries-secure-proofing` via the core grant seam |
| `app/utils/proofing.ts` | pure marks model (`emptyDoc`/`setMark`/validate) — node-tested |
| `useProofing(...)` | customer: hold marks + debounced encrypted submit (opaque `customerId` in localStorage) |
| `<SecureGalleryProofingView>` | customer view: base gallery + per-photo colour/comment overlay |
| `useProofingReview(...)` | photographer review logic: load submissions → decrypt → aggregate marks per photo |
| editor override (`registerFieldComponent('secureGallery', …)`) | augments the BASE gallery editor in-place: colour flags on photos + comments in the lightbox + a colour filter, shown when the photographer unlocks the gallery in the record editor (no separate page) |

The customer's identity (name/avatar/personalisation) is **consumer territory** — this layer keeps only an
opaque `customerId`; a consumer project can carry a display name inside the sealed payload or build its own UI.

## Recipe — wire it into your own block + admin page

**Customer view** — in your gallery block's display, use `<SecureGalleryProofingView>` instead of the base
`<SecureGalleryView>`, and pass the gallery **record's `slug`** as the submission key:
```vue
<!-- app/blocks/MyGallery.vue (schema + display in one SFC) -->
<script setup>
// `slug` MUST be the gallery RECORD's `slug` field value — the exact key the photographer's editor reads
// (it derives the review key from the record's `slug`). Do NOT use `$route.path`: it carries a leading slash
// and any locale prefix, so it would never match the editor's key and the photographer's review would be
// silently empty. Source the slug from your page's record (e.g. as block data) and pass it through.
defineProps(['heading', 'gallery', 'slug'])
</script>
<template>
  <h2 v-if="heading">{{ heading }}</h2>
  <SecureGalleryProofingView :gallery="gallery" :gallery-slug="slug" />
</template>
```

**Photographer review** — nothing to wire. Just compose this extension (`extends: ['@thielemann/kestrel',
'@thielemann/kestrel-galleries-secure', '@thielemann/kestrel-galleries-secure-proofing']`): it overrides the `secureGallery` editor
widget, so in the normal record editor the photographer enters the gallery password (the same unlock that
shows folders/files), and then sees each customer's colour flags on the photos, the comments in the
lightbox, and a colour filter — all read-only, in the same place they manage the gallery. The gallery key is
already in memory from the unlock; reads are admin-gated; the customer write went through the public
back-channel. (The proofing submission key is the gallery record's `slug` field by default; set the
secureGallery field's `options.keyField` to use a different sibling field — the customer view must submit the
same value.)

> Status: feature-complete (slices 0–3). The pure marks/submission/rate-limit logic is node-tested; the
> route, collection, grant plugin, composables and views are browser-/build-verified (a running server +
> WebCrypto, not the headless suite). Photographer's OWN marks (a write path for the editor, not just
> read-only review) is a noted follow-up. See `2026-06-28-galleries-secure-proofing-slice-plan.md` (outer dir).
