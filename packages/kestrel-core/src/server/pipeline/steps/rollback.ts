import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Quarantined, ValidationFailed } from '@michaelthielemann/kestrel-contracts'
import { applyRevisionUpcast, readRevisions } from '../../db/revisions.js'
import { decodeInput } from '../core/validate.js'
import { asValidated, collectionOf, columns, dbOf, requireRecordId, table, unitsOf, type Row } from './shared.js'
import { assertStatusTransition } from './validate.js'
import { syncStep, type StepDef } from '../types.js'

/**
 * Validates the `{ revision: number }` body against the record's own revision history, loads the current
 * row (`null` if the record is currently deleted) as the write unit's `before`, and rejects a target
 * snapshot rollback would otherwise write raw:
 *
 * - An unknown revision number, or a revision that is itself a tombstone, both answer `ValidationFailed` on
 *   the `revision` path rather than `NotFound`: `NotFound`'s shape names a collection/id pair, and `id`
 *   here is the RECORD id, not the missing/tombstoned revision number, so it cannot honestly carry either
 *   failure.
 * - The snapshot is upcast (`applyRevisionUpcast`, `revisions.ts`) BEFORE anything else — a history row
 *   recorded under an older `schemaVersion` is walked forward by `registerRevisionUpcast`'s dedicated,
 *   per-collection registry (local to `revisions.ts`, NOT `@michaelthielemann/kestrel-contracts`' `registerUpcast` — that
 *   walker assumes sequential author-assigned versions, which a def-hash is not; see
 *   `applyRevisionUpcast`'s TSDoc for why the two can't share a mechanism).
 * - Only THEN is the (possibly-upcast) snapshot decoded against the collection's CURRENT `select` schema.
 *   Decoding here is go/no-go only, and deliberately COLUMN-SHAPE-ONLY: it validates that every column
 *   exists and roughly type-checks, not full field-level refinements (a `unique`/cross-field/custom
 *   `validate` rule) — those apply again for real once the restored row round-trips through an ordinary
 *   write. `persistRollbackStep` still writes the upcast-but-otherwise-raw snapshot (`readRevisions`
 *   already revived its timestamps), not this call's parsed/coerced output, so the written row stays
 *   byte-identical to what the upcast chain (or history, unchanged) actually produced.
 * - An UNRESOLVED version mismatch (`applyRevisionUpcast` found no chain that bridges it) is not itself an
 *   immediate failure — a mismatch whose raw, un-upcast snapshot happens to decode fine anyway is let
 *   through unescalated, WITH A LOGGED WARNING (this is a real residual risk, not a clean case: "decodes
 *   fine" is column-shape-only, so a def change that alters MEANING without altering column shape restores
 *   stale semantics unescalated — decode passing is not proof the restored row is actually current). It is
 *   escalated to the tagged `Quarantined`, replacing the ordinary `ValidationFailed`, ONLY when that decode
 *   actually then fails: the version drift is what makes an otherwise-inexplicable failure explicable, not
 *   the mere existence of a hash difference. Quarantined means the record stays untouched, nothing
 *   downstream of this step runs.
 * - The status move the restore would make runs through the same `assertStatusTransition` gate every other
 *   status mutation runs through, evaluated against TODAY's conditions — a snapshot that fails them now
 *   (even if it validly passed them when it was recorded) is refused, exactly as an equivalent `updateOne`
 *   would refuse it.
 * @public
 */
export function loadRollbackTargetStep(): StepDef {
  return syncStep('loadRollbackTarget', (ctx) => Effect.gen(function* () {
    const c = collectionOf(ctx)
    const db = dbOf(ctx)
    const recordId = yield* requireRecordId(ctx)
    const input = ctx.input as { revision?: unknown } | null | undefined
    const wanted = input?.revision
    if (typeof wanted !== 'number' || !Number.isInteger(wanted)) {
      return yield* Effect.fail(new ValidationFailed({ issues: [{ path: ['revision'], message: 'revision must be an integer' }] }))
    }
    const target = readRevisions(db, c.name, recordId).find((r) => r.revision === wanted)
    if (!target) {
      return yield* Effect.fail(new ValidationFailed({
        issues: [{ path: ['revision'], message: `no revision ${wanted} for "${c.name}#${recordId}"` }],
      }))
    }
    if (target.tombstone) {
      return yield* Effect.fail(new ValidationFailed({
        issues: [{ path: ['revision'], message: `revision ${wanted} is a tombstone — nothing to roll back to` }],
      }))
    }
    const outcome = applyRevisionUpcast(c.def, target)
    const snapshot = outcome.snapshot
    yield* decodeInput(c.select, snapshot).pipe(
      Effect.mapError((error) => (outcome.resolved ? error : new Quarantined({ id: recordId }))),
    )
    if (!outcome.resolved) {
      // Decode above didn't throw, so this mismatch is going through unescalated — see this step's TSDoc
      // for why that's a real residual risk (column-shape-only decode), not a clean pass.
      console.warn(
        `[kestrel] rollback: "${c.name}#${recordId}" restored from schema_version ${target.schemaVersion} with no upcast chain reaching the current version — decoded anyway (column-shape match only, semantics may be stale)`,
      )
    }

    const cols = columns(c)
    const current = db.select().from(table(c)).where(eq(cols.id, recordId)).get() as Row | undefined
    const before = current ?? null
    yield* assertStatusTransition(c, before, snapshot.status, { ...(before ?? {}), ...snapshot })

    ctx.work.rollbackSnapshot = snapshot
    unitsOf(ctx).push({ values: asValidated({}), before })
  }), { sealed: true })
}
