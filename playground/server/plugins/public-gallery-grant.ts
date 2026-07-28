// Open the scoped public-gallery endpoint to anonymous READ, via the core access grant seam. Narrow on
// purpose: a SPECIFIC resource (`public-gallery`, not the whole `galleries` collection → no enumeration) and
// `scope: 'published'` (never drafts). The grant seam refuses over-broad anonymous grants, so this is the
// only shape it would accept anyway. defineNitroPlugin + registerAccessGrant are auto-imported.
export default defineNitroPlugin(() => {
  registerAccessGrant('anonymous', { action: 'read', resource: 'public-gallery', scope: 'published' })
})
