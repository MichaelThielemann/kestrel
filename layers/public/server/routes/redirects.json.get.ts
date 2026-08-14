import { eq } from 'drizzle-orm'
import { compilePublishableRedirects, serializeRedirects } from '../utils/publish/redirect-rules'
import { REDIRECTS_COLLECTION, REDIRECTS_FIELD } from '../utils/publish/redirects-artifact'

/**
 * The redirect artifact the edge polls. A save publishes it directly (see `plugins/03.redirects.ts`);
 * this route is what makes it survive everything else — it is prerendered into `.output/public`, so the
 * build-time deploy's reconcile keeps it instead of pruning a key it cannot account for, and a full
 * publish re-renders it from the live DB. Public and cheap: one row, no user input.
 *
 * Zero redirects is a supported state, and so is a collection a consumer toggled off — both serve `[]`,
 * never a 404, because an edge that cannot fetch the file has to keep its last good state and would
 * otherwise burn its cold-start budget retrying.
 */

/** A table that does not exist yet — the release adds one, so a consumer can generate before their
 *  `db:migrate`. `[]` is the truth there, not a degrade. */
function tableIsAbsent(error: unknown): boolean {
  return /no such table/i.test((error as Error)?.message ?? '')
}

/**
 * Render the artifact, or fail loudly. The distinction is deliberate and narrow: only a missing table
 * yields `[]`, because only then is "no redirects" a FACT. Any other read failure (a drifted column, an
 * I/O error) throws — at build time an errored route costs the deploy its reconcile, which is the
 * conservative direction, and at runtime `publishMeta` writes nothing on a non-200, where an empty body
 * would instead overwrite a good live artifact with "no redirects". A failed read must never be an
 * authoritative empty result.
 */
export function renderRedirects(readRows: () => unknown): string {
  let rows: unknown
  try {
    rows = readRows()
  } catch (error) {
    if (!tableIsAbsent(error)) throw error
    console.warn('[kestrel] redirects.json: the redirects table does not exist yet — serving an empty list. Run `db:migrate`.')
    return serializeRedirects([])
  }
  const { rules, skipped } = compilePublishableRedirects(rows)
  for (const message of skipped) {
    console.error(`[kestrel] redirects.json: skipped an unpublishable rule — ${message}`)
  }
  return serializeRedirects(rules)
}

export default defineEventHandler((event) => {
  setHeader(event, 'content-type', 'application/json; charset=utf-8')
  const collection = getCollection(REDIRECTS_COLLECTION)
  if (!collection) return serializeRedirects([])

  const cols = collection.table as unknown as Record<string, never>
  return renderRedirects(() => {
    const row = useDb().select().from(collection.table).where(eq(cols.singletonKey, REDIRECTS_COLLECTION)).get() as
      | Record<string, unknown>
      | undefined
    return row?.[REDIRECTS_FIELD]
  })
})
