import { text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import { GALLERY_ID_RE } from '../utils/namespace'

// A `secureGallery` field type. The field value is just a tiny PUBLIC ref (v2): the per-gallery storage
// namespace id, the PBKDF2 salt, and a sealed verify-token. The actual tree (files + folders) lives in an
// encrypted INDEX file in storage (`galleries-secure/<galleryId>/index.json`) alongside the ciphertext
// blobs — so the editor mirrors storage 1:1. Zero-knowledge: without the password the ref reveals nothing.
// `defineFieldType` / `constrain` / `opt` are auto-imported from Kestrel (the consumer composes kestrel +
// this layer). The editor widget + the public display are client-side.
const sealedB64 = z.object({ iv: z.string(), data: z.string() })

export default defineFieldType({
  name: 'secureGallery',
  column: (n, f) => constrain(text(n, { mode: 'json' }), f),
  validator: (f) =>
    opt(
      z.object({
        v: z.literal(2),
        galleryId: z.string().regex(GALLERY_ID_RE),
        saltB64: z.string(),
        verify: sealedB64,
        // PBKDF2 work factor recorded at creation (absent on legacy galleries). Kept so it isn't stripped on save.
        iterations: z.number().int().positive().optional(),
        // Whether the encrypted index carries an enforced integrity tag (see index-auth). Kept so a save can't
        // strip it and downgrade integrity.
        authIndex: z.boolean().optional(),
      }),
      f,
    ),
})
