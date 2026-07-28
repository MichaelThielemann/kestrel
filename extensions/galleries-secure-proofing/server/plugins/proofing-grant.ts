// Register the single access grant the public back-channel needs: anonymous customers may WRITE to the
// `galleries-secure-proofing` resource (the /api/galleries-secure-proofing/* route) — and nothing else. It
// goes through the core `access` grant seam; that seam refuses over-broad anonymous grants (wildcard /
// draft-read), so this is necessarily narrow. Because the grant + the route live ONLY in this opt-in layer,
// a deployment that doesn't compose it has no anonymous-write surface at all. `defineNitroPlugin` and
// `registerAccessGrant` are auto-imported.
// GUARDRAIL: this authorizes anonymous writes to ANY /api/galleries-secure-proofing/* write route (the
// resource is the path's first segment). Today only `submit` exists; keep it the ONLY write route under this
// prefix, or scope new routes elsewhere — don't add an admin-only write here under the same segment.
export default defineNitroPlugin(() => {
  registerAccessGrant('anonymous', { action: 'write', resource: 'galleries-secure-proofing' })
  // Anonymous READ of the same resource — the customer fetching their OWN submission (GET .../mine, which
  // self-scopes to one gallerySlug+customerId and returns only ciphertext). `scope: 'published'` keeps it
  // non-draft (the seam refuses draft-read anonymous grants anyway).
  // GUARDRAIL: authorizes anonymous GET on ANY /api/galleries-secure-proofing/* route — today only `mine`.
  // Keep read routes under this prefix self-scoped + ciphertext-only.
  registerAccessGrant('anonymous', { action: 'read', resource: 'galleries-secure-proofing', scope: 'published' })
})
