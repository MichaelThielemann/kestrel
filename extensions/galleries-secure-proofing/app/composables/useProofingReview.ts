// Photographer-side review: load the (admin-gated) proofing submissions for a gallery, decrypt each with the
// gallery key (the base's `open`, from the same useSecureGallery instance the review unlocked), and aggregate
// the customers' marks per photo. Browser-only ($fetch + WebCrypto); the marks shape is validated by the
// node-tested pure `validateDoc`. The admin list read is authorized by the normal admin session (the
// galleryProofing collection is admin-only); the customer write went through the public back-channel.
import { ref, computed } from 'vue'
import { validateDoc, proofingAad, type ProofingDoc } from '../utils/proofing'

export interface UseProofingReviewOptions {
  gallerySlug: string
  /** Decrypt a sealed value under the gallery key (with optional AAD) — pass `useSecureGallery().open`. */
  open: (sealed: { iv: string; data: string }, aad?: Uint8Array) => Promise<Uint8Array>
}

interface Submission { customerId: string; doc: ProofingDoc }
export interface AggregatedMark { customerId: string; color?: string; comment?: string }

/** Pull the row array out of whatever envelope the generic list API returns. */
function rowsOf(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[]
  const r = res as Record<string, unknown>
  for (const k of ['rows', 'items', 'data', 'records']) if (Array.isArray(r?.[k])) return r[k] as Record<string, unknown>[]
  return []
}

export function useProofingReview(options: UseProofingReviewOptions) {
  const submissions = ref<Submission[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function load() {
    if (!import.meta.client) return
    loading.value = true
    error.value = null
    try {
      // Server-side filter (the generic list honours `filter[<field>]`, NOT a bare param) + page through
      // (perPage is capped at 100 server-side) so a busy/multi-gallery deployment never silently drops rows.
      const rows: Record<string, unknown>[] = []
      for (let page = 1; page <= 50; page++) {
        const res = await $fetch('/api/galleryProofing/readMany', { query: { 'filter[gallerySlug]': options.gallerySlug, perPage: 100, page } })
        const batch = rowsOf(res)
        rows.push(...batch)
        if (batch.length < 100) break
      }
      // Rows are newest-first (createdAt desc) → keep only the LATEST submission per customer (a non-atomic
      // upsert can leave an older duplicate row; dedup here so the review shows one current mark-set each).
      const out: Submission[] = []
      const seen = new Set<string>()
      for (const row of rows) {
        if (row.gallerySlug !== options.gallerySlug) continue // belt-and-suspenders
        const customerId = String(row.customerId)
        if (seen.has(customerId)) continue
        try {
          const sealed = row.sealed as { iv: string; data: string }
          if (!sealed?.iv || !sealed?.data) continue
          // Open with the same (gallerySlug, customerId) AAD the customer sealed under — a submission relabelled
          // under a different customerId fails the auth check and is skipped (caught below), not attributed.
          const bytes = await options.open(sealed, proofingAad(options.gallerySlug, customerId))
          const doc = validateDoc(JSON.parse(new TextDecoder().decode(bytes)))
          if (doc) { out.push({ customerId, doc }); seen.add(customerId) }
        } catch { /* skip a submission we can't decrypt/parse */ }
      }
      submissions.value = out
    } catch {
      error.value = 'Could not load proofing submissions.'
    } finally {
      loading.value = false
    }
  }

  /** marks per photo (blobKey) across all customers. */
  const marksByImage = computed(() => {
    const map: Record<string, AggregatedMark[]> = {}
    for (const s of submissions.value) {
      for (const [blobKey, mark] of Object.entries(s.doc.marks)) {
        (map[blobKey] ??= []).push({ customerId: s.customerId, ...mark })
      }
    }
    return map
  })

  return { submissions, marksByImage, loading, error, load }
}
