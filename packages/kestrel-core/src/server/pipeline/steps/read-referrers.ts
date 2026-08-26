import { Effect } from 'effect'
import { ValidationFailed } from '@michaelthielemann/kestrel-contracts'
import { MAX_BULK_IDS } from '../../../app/utils/list-limits.js'
import { parseIdList } from '../../utils/http.js'
import { findReferrers, findReferrersForMany } from '../../utils/record-ref-index.js'
import { useContentDbFor } from '../../db/content-db.js'
import { collectionOf, dbOf } from './shared.js'
import { syncStep, type StepDef } from '../types.js'

type Query = Record<string, unknown>

/** The reverse "what links here" lookup for the collection in the path. Two arms:
 *   ?id=1        -\> FieldRef[]                                   (single target; the editor's warning)
 *   ?ids=1,2,3   -\> \{ counts: Record\<id, count\>, checked: boolean \} (a selection; the bulk-delete warning)
 *  `checked` is false when the lookup itself failed (e.g. record_refs not migrated yet) — an empty `counts`
 *  then means "could not check", NOT "no referrers", so a caller must not read it as a green light to delete.
 * @public */
export function referrersStep(): StepDef {
  return syncStep('referrers', (ctx) => Effect.gen(function* () {
    const c = collectionOf(ctx)
    // findReferrers/findReferrersForMany only ever touch record_refs, not `c`'s own table — `[c]` is
    // unioned in anyway for consistency with the other record-ref-index call sites.
    const db = useContentDbFor(dbOf(ctx), c).db
    const query = (ctx.input ?? {}) as Query
    if (query.ids != null) {
      const ids = parseIdList(query.ids, MAX_BULK_IDS)
      const counts = findReferrersForMany(db, c.name, ids)
      ctx.output = { counts: counts ?? {}, checked: counts !== null }
      return
    }
    const id = Number(query.id)
    if (!Number.isInteger(id) || id <= 0) {
      return yield* Effect.fail(new ValidationFailed({ issues: [{ path: ['id'], message: 'id query param is required' }] }))
    }
    ctx.output = findReferrers(db, c.name, id) ?? []
  }))
}
