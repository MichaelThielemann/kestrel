import { and, desc, eq, getTableColumns } from 'drizzle-orm'

// Public read of ONE proofing submission, so the customer view can restore its marks after a page reload.
// Scoped to a single (gallerySlug, customerId) row and returns ONLY that row's client-encrypted `sealed`
// ciphertext — no listing, no other fields.
//
// THREAT MODEL (honest): this read is *id-scoped*, NOT authenticated. The customerId is a client-chosen opaque
// id, so anyone who learns another customer's (slug, customerId) can fetch this ciphertext — and since all
// customers of a gallery share the one gallery key, they could also decrypt it. So zero-knowledge holds
// against the SERVER (useless without the gallery password), but this is NOT per-customer confidentiality
// among people who already hold that password — adequate for the intended small, trusted proofing audience.
// Anonymous READ is granted narrowly for this resource (see ../plugins/proofing-grant). getCollection / useDb /
// getQuery / createError are auto-imported; drizzle helpers are imported.
export default defineEventHandler((event) => {
  // Rate-limit per IP, symmetric with submit.post on the same anonymous resource: without this an
  // attacker could enumerate/scrape ciphertext blobs (or just flood the DB) at line rate. Keyed on IP
  // only — the gallerySlug is attacker-controlled, so it must not grant a fresh budget per slug.
  if (!rateLimit(`proofing-mine:${clientIp(event)}`, Date.now())) {
    throw createError({ statusCode: 429, statusMessage: 'too many proofing reads' })
  }
  const q = getQuery(event)
  const gallerySlug = q.gallerySlug
  const customerId = q.customerId
  if (typeof gallerySlug !== 'string' || !gallerySlug || typeof customerId !== 'string' || !customerId) {
    throw createError({ statusCode: 400, statusMessage: 'gallerySlug and customerId required' })
  }

  const c = getCollection('galleryProofing')
  if (!c) throw createError({ statusCode: 500, statusMessage: 'galleryProofing collection is not registered' })

  const cols = getTableColumns(c.table) as Record<string, never>
  const row = useDb().select().from(c.table)
    .where(and(eq(cols.gallerySlug, gallerySlug), eq(cols.customerId, customerId)))
    .orderBy(desc(cols.createdAt)) // read the LATEST row (matches submit's upsert target + the review dedup)
    .get() as { sealed: unknown } | undefined
  return { sealed: row?.sealed ?? null } // ciphertext only — the client decrypts with the gallery password
})
