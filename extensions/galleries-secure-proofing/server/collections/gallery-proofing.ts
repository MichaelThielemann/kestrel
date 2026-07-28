// Storage for proofing submissions: one row per (gallerySlug, customerId) holding the customer's
// CLIENT-ENCRYPTED marks (`sealed`, a json SealedB64). The schema engine creates + migrates the table. It is
// WRITTEN by the public back-channel route (server-side upsert, bypassing the admin CRUD) and READ admin-gated
// by the photographer's review. Not pageLike, no status — internal storage, not public content.
// `defineCollection` is auto-imported.
export default defineCollection({
  name: 'galleryProofing',
  mode: 'multi',
  fields: {
    // Indexed: every anonymous submit/read is a `WHERE gallerySlug = ? AND customerId = ?` lookup or a
    // per-slug count(*) — without this the table has only the id PK and every request full-scans it.
    gallerySlug: { type: 'text', required: true, index: true },
    customerId: { type: 'text', required: true },
    sealed: { type: 'json' },
    // sha256 of the customer's per-browser write secret, set on the FIRST submission. A later overwrite
    // must present the matching secret — so knowing only (slug, customerId) does not let a third party
    // vandalise/rollback the row (all gallery viewers share the one gallery key, so key-possession can't
    // distinguish customers; a per-customer secret can).
    writeAuthHash: { type: 'text' },
  },
  label: { singular: 'Proofing submission', plural: 'Proofing', new: 'Proofing submission' },
  icon: 'message-square',
})
