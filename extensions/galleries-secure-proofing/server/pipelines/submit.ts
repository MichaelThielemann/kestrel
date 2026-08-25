import { and, desc, eq, sql, getTableColumns } from 'drizzle-orm'
import { createError, getRequestHeader } from 'h3'
import { createHash, timingSafeEqual } from 'node:crypto'
import { Effect } from 'effect'
import { clientIp, throttleKey } from '@kestrel/auth'
import { create, definePipeline, eventOf, fromThrowing, requireRegisteredCollection, update, useDb } from '@kestrel/core'
import type { StepDef } from '@kestrel/core'
import { readCappedBody } from '../utils/read-capped-body'
import {
  exceedsGalleryQuota, exceedsGlobalQuota, MAX_NEW_CUSTOMERS_PER_IP_PER_SLUG, MAX_TOTAL_ROWS,
  newCustomerRateKey, NEW_CUSTOMER_WINDOW_MS, parseSubmission,
} from '../utils/proofing-submission'
import { rateLimit } from '../utils/rate-limit'

// Fires once per process, the first time the global backstop is actually hit — an operator signal that the
// table needs attention, without flooding the log on every rejected request while it stays full.
let warnedGlobalQuota = false

/** sha256 hex of the client's write secret — stored on first write, compared (timing-safe) on overwrite. */
function hashWriteSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}
function writeSecretMatches(secret: string, storedHash: unknown): boolean {
  if (typeof storedHash !== 'string' || storedHash.length !== 64) return false // legacy/absent hash → refuse overwrite
  const a = Buffer.from(hashWriteSecret(secret), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

// Public PROOFING back-channel. Anonymous-writable via the pipeline's own `access` declaration, but hardened
// in depth: the CSRF gate runs FIRST, then this step rate-limits per IP, caps the buffered payload size, and —
// for a NEW row — enforces a per-gallery cap, a GLOBAL row backstop (the slug is attacker-controlled, so a
// rotating slug must not grow storage without limit), and a per-IP-per-slug NEW-identity budget (so one IP
// can't fill a real gallery's cap to lock out legitimate customers). Every bound REJECTS the write; nothing
// on this anonymous path ever deletes a stored row. It stores ONLY the customer's client-encrypted ciphertext
// — the server never sees the marks (zero-knowledge). Upserts one row per (gallerySlug, customerId) into the
// `galleryProofing` collection.

/** Hard cap on the buffered body (~96KB covers the 64KB ciphertext cap + JSON overhead). */
const MAX_BODY_BYTES = 96 * 1024

const submitProofing: StepDef = {
  name: 'submitProofing',
  fn: (ctx) => Effect.gen(function* () {
    const event = eventOf(ctx)
    // Same key derivation as the login throttle: `clientIp` resolves the real client behind a declared
    // trusted-proxy depth (KESTREL_TRUST_PROXY — an operator running this extension behind nginx/Cloudflare
    // must set it, or every customer collapses into the proxy's single bucket), and `throttleKey` coarsens a
    // real IPv6 address to its /64 so an attacker on a routed prefix can't mint a fresh budget per request.
    const key = throttleKey(clientIp(event))
    const now = Date.parse(ctx.facts.now)
    // Cheap ingress guard for HONEST clients that declare a length. Not authoritative — a chunked request can
    // omit/forge content-length — so the real bound is the streaming cap below.
    if (Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BODY_BYTES) {
      throw createError({ statusCode: 413, statusMessage: 'proofing payload too large' })
    }
    // Volume limit, keyed ONLY on the client — the gallerySlug is attacker-controlled, so it must NOT be part
    // of the key (else rotating slugs yields a fresh budget), and neither may the customerId (the client mints
    // it and can rotate it freely). Checked before reading the body so garbage floods are throttled too.
    if (!rateLimit(key, now)) {
      throw createError({ statusCode: 429, statusMessage: 'too many proofing submissions' })
    }

    // Authoritative size bound: read the actual stream with a running cap (a forged/absent content-length can't
    // get past this), then JSON-parse ourselves instead of the uncapped readBody().
    const raw = yield* Effect.promise(() => readCappedBody(event.node.req, MAX_BODY_BYTES))
    if (raw === null) {
      event.node.req.destroy()
      throw createError({ statusCode: 413, statusMessage: 'proofing payload too large' })
    }
    let parsed: unknown
    try { parsed = raw.length ? JSON.parse(raw.toString('utf8')) : undefined }
    catch { throw createError({ statusCode: 400, statusMessage: 'invalid proofing submission' }) }

    const sub = parseSubmission(parsed)
    if (!sub) throw createError({ statusCode: 400, statusMessage: 'invalid proofing submission' })

    const c = requireRegisteredCollection('galleryProofing')

    const db = useDb()
    const cols = getTableColumns(c.table) as Record<string, never>
    // One submission per (gallery, customer): upsert. The find is a precise key lookup; create/update go
    // through the collection's validation + serialization (consistent with the admin CRUD path).
    // Target the LATEST row for this (gallery, customer), matching the review dedup (createdAt-desc, keep
    // first). A non-atomic upsert race can leave a duplicate; an unordered .get() would update the OLDEST
    // (by rowid) while the review shows the newest — so the photographer would see marks that never update.
    const existing = db.select().from(c.table)
      .where(and(eq(cols.gallerySlug, sub.gallerySlug), eq(cols.customerId, sub.customerId)))
      .orderBy(desc(cols.createdAt))
      .get() as { id: number; writeAuthHash: string | null } | undefined

    // Overwrite requires proof the submitter is the row's original creator: the per-customer write secret
    // must hash to the stored writeAuthHash. Knowing (slug, customerId) alone is not enough — so a third
    // party can't vandalise or roll back a customer's marks. (First write stores the hash below.)
    if (existing && !writeSecretMatches(sub.writeSecret, existing.writeAuthHash)) {
      throw createError({ statusCode: 403, statusMessage: 'proofing write not authorized for this identity' })
    }

    // A NEW customer (new row) must clear three bounds; an UPDATE to an existing customer's marks skips all of
    // them (it grows nothing). All are cheap COUNT(*)s / in-memory checks, not scans over the sealed blobs.
    if (!existing) {
      // (1) Per-gallery cap — bounds junk rows within ONE gallery.
      const { n } = db.select({ n: sql<number>`count(*)` }).from(c.table)
        .where(eq(cols.gallerySlug, sub.gallerySlug)).get() as { n: number }
      if (exceedsGalleryQuota(n, true)) {
        throw createError({ statusCode: 429, statusMessage: 'gallery proofing limit reached' })
      }
      // (2) Global backstop — `gallerySlug` is attacker-controlled and never validated against a real gallery,
      // so a fresh slug per request sidesteps the per-gallery cap; this bounds the WHOLE table so rotating the
      // slug can't grow storage without limit.
      const { total } = db.select({ total: sql<number>`count(*)` }).from(c.table).get() as { total: number }
      if (exceedsGlobalQuota(total)) {
        if (!warnedGlobalQuota) {
          warnedGlobalQuota = true
          console.error(`[kestrel] galleryProofing: global row backstop (${MAX_TOTAL_ROWS}) reached — new proofing identities are being rejected until an operator prunes the table`)
        }
        throw createError({ statusCode: 429, statusMessage: 'proofing storage limit reached' })
      }
      // (3) Per-IP-per-slug NEW-identity budget — stops one IP from minting the ~200 junk customers that would
      // fill a real gallery's per-gallery cap and lock out every genuinely-new customer. Only new rows consume it.
      if (!rateLimit(newCustomerRateKey(key, sub.gallerySlug), now, MAX_NEW_CUSTOMERS_PER_IP_PER_SLUG, NEW_CUSTOMER_WINDOW_MS)) {
        throw createError({ statusCode: 429, statusMessage: 'too many new proofing identities for this gallery' })
      }
    }

    // First write records the write-secret hash (the possession credential for later overwrites); an
    // overwrite keeps the original hash (already verified above), never re-binding to a caller-supplied one.
    const body = existing
      ? { gallerySlug: sub.gallerySlug, customerId: sub.customerId, sealed: sub.sealed }
      : { gallerySlug: sub.gallerySlug, customerId: sub.customerId, sealed: sub.sealed, writeAuthHash: hashWriteSecret(sub.writeSecret) }
    const row = (yield* fromThrowing(() => existing ? update(db, c, existing.id, body) : create(db, c, body))) as { id: number }
    ctx.output = { ok: true, id: row.id }
  }),
}

export const proofingSubmitPipeline = definePipeline({
  name: 'proofingSubmit',
  access: { public: true },
  rawBody: true,
  steps: [submitProofing],
})
