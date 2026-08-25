// Validation of the (untrusted, PUBLIC) proofing submission body the back-channel route receives. Pure +
// node-tested — the load-bearing guard of the anonymous-writable endpoint. The customer encrypts their marks
// client-side and POSTs only the ciphertext envelope; this never sees plaintext marks. Size caps keep the
// public route from being abused to store large blobs.
//
// NOTE (attribution): the marks are sealed CLIENT-SIDE with AES-GCM under the gallery key AND bound to
// (gallerySlug, customerId) as additionalData (see `proofingAad`), and the review opens with the same AAD — so
// a sealed mark-set CANNOT be replayed or relabelled under a different customerId (decryption fails the auth
// check and that row is skipped). A key holder can still author fresh marks under any id (inherent: they have
// the key), but they can't steal/re-attribute another customer's submission.

/** A base64 sealed value (matches the base extension's manifest SealedB64 shape). */
export interface SealedB64 { iv: string; data: string }
/** The public submission envelope: which gallery, which (opaque) customer, the sealed marks ciphertext, and
 *  the per-customer WRITE SECRET that proves the submitter is the row's original creator (see submit.post). */
export interface ProofingSubmission { gallerySlug: string; customerId: string; sealed: SealedB64; writeSecret: string }

/** Max length of the client-generated write secret (a random token; a UUID is 36 chars — allow a little more). */
export const MAX_WRITE_SECRET = 128

const MAX_SLUG = 300
const MAX_CUSTOMER_ID = 100
/** Cap the ciphertext envelope (base64 chars) so the public route can't store large blobs. */
export const MAX_SEALED_B64 = 64 * 1024

/** Max distinct customers (rows) stored per gallery. Bounds junk-row flooding of one gallery's proofing table
 *  via the anonymous endpoint: an attacker minting fresh `customerId`s for a slug is capped here (and
 *  rate-limited per IP). Generous vs any real proofing audience (a handful of customers), so legitimate use is
 *  never blocked. This bounds PER-gallery growth only; because `gallerySlug` is attacker-controlled and not
 *  validated against a real gallery, a rotating slug sidesteps it — so `exceedsGlobalQuota` bounds the whole
 *  table, and `newCustomerRateKey` bounds one IP's contribution to any single gallery's cap. (Validating the
 *  slug against a real gallery record would need host-collection knowledge this generic layer doesn't have.) */
export const MAX_CUSTOMERS_PER_GALLERY = 200

/** Should a submission be rejected because the gallery already holds the max distinct customers? Only a NEW
 *  customer (a new row) counts against the cap; an UPDATE to an existing customer's marks is always allowed. */
export function exceedsGalleryQuota(existingRowsForSlug: number, isNewCustomer: boolean): boolean {
  return isNewCustomer && existingRowsForSlug >= MAX_CUSTOMERS_PER_GALLERY
}

/** Absolute backstop on the WHOLE proofing table. The per-gallery cap only bounds one slug, but `gallerySlug`
 *  is attacker-controlled and never validated against a real gallery, so a fresh slug per request sidesteps it
 *  entirely — unbounded rows → disk exhaustion. This global ceiling can't be sidestepped by rotating the slug.
 *  Generous vs any real multi-gallery deployment; it is a runaway-abuse guard, not a normal-use limit. */
export const MAX_TOTAL_ROWS = 50_000
export function exceedsGlobalQuota(totalRows: number): boolean {
  return totalRows >= MAX_TOTAL_ROWS
}

/** Blunt a TARGETED lockout: an attacker who knows a real gallery's (semi-public) slug could otherwise mint
 *  ~200 junk `customerId`s from ONE IP to fill that gallery's per-gallery cap, after which every genuinely-new
 *  customer is rejected forever. Cap how many NEW identities a single IP may register for a given slug within a
 *  window, so filling a real gallery's cap needs many distinct IPs, not one. A legitimate customer registers
 *  exactly one identity per (their IP, their gallery), so this never blocks real use. Reuses the generic
 *  `rateLimit(key, now, limit, windowMs)` limiter with a namespaced key. Only NEW customers consume the budget. */
export const MAX_NEW_CUSTOMERS_PER_IP_PER_SLUG = 5
export const NEW_CUSTOMER_WINDOW_MS = 10 * 60_000
export function newCustomerRateKey(ip: string, gallerySlug: string): string {
  return `newcust:${ip}:${gallerySlug}`
}

/** Validate + narrow an untrusted body to a ProofingSubmission, or return null. */
export function parseSubmission(body: unknown): ProofingSubmission | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const { gallerySlug, customerId } = b
  const sealed = b.sealed as Record<string, unknown> | undefined
  const writeSecret = b.writeSecret
  if (typeof gallerySlug !== 'string' || !gallerySlug || gallerySlug.length > MAX_SLUG) return null
  if (typeof customerId !== 'string' || !customerId || customerId.length > MAX_CUSTOMER_ID) return null
  if (typeof writeSecret !== 'string' || !writeSecret || writeSecret.length > MAX_WRITE_SECRET) return null
  if (!sealed || typeof sealed !== 'object') return null
  if (typeof sealed.iv !== 'string' || typeof sealed.data !== 'string') return null
  if (sealed.iv.length + sealed.data.length > MAX_SEALED_B64) return null
  return { gallerySlug, customerId, sealed: { iv: sealed.iv, data: sealed.data }, writeSecret }
}
