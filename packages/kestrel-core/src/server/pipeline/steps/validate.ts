import { Effect, Exit } from 'effect'
import { createError } from 'h3'
import { ValidationFailed } from '@michaelthielemann/kestrel-contracts'
import { canTransition } from '@michaelthielemann/kestrel-core'
import type { BuiltCollection, GuardName, Status } from '@michaelthielemann/kestrel-core'
import { checkConditions, decodeInput, stripGuardedPatchKeys } from '../core/validate.js'
import { asValidated, assertNotSingleton, collectionOf, isSingletonWrite, unitsOf, type Row } from './shared.js'
import { syncStep, type StepDef } from '../types.js'
/** Parse the payload against the collection's insert schema and re-check the cross-field conditions.
 * @public
 *  `many` reads the input as a list of records; each becomes its own write unit. */
export function validateCreateStep(many: boolean): StepDef {
  return syncStep('validate', (ctx) => Effect.gen(function* () {
    const c = collectionOf(ctx)
    assertNotSingleton(c)
    if (many && !Array.isArray(ctx.input)) {
      return yield* Effect.fail(new ValidationFailed({ issues: [{ path: [], message: 'Expected an array of records' }] }))
    }
    const bodies = many ? (ctx.input as unknown[]) : [ctx.input]
    const units = unitsOf(ctx)
    for (const body of bodies) {
      const data = (yield* decodeInput(c.insert, body)) as Row
      yield* checkConditions(c.applyConditions, data)
      units.push({ values: asValidated({ ...data }), before: null })
    }
  }), { sealed: true })
}

/**
 * Parse a single-record change. Two shapes share this step:
 *  - a regular PATCH validates against the partial `update` schema and re-checks the conditions on the
 *    MERGED record (existing ⊕ patch), skipped when the row is missing — the update 404s at `persist`
 *    rather than reporting a misleading 400;
 *  - a singleton PUT replaces the record, so a FIRST save validates with the full insert schema (a missing
 *    hard-required field is a clean 400 instead of a NOT NULL 500 at the column) while an overwrite is a
 *    partial, and the conditions always run on the merged record.
 * @public
 */
export function validateUpdateStep(): StepDef {
  return syncStep('validate', (ctx) => Effect.gen(function* () {
    const c = collectionOf(ctx)
    const unit = unitsOf(ctx)[0]!
    const singleton = isSingletonWrite(ctx)
    if (singleton) {
      if (c.def.mode !== 'single') throw createError({ statusCode: 405, statusMessage: 'PUT is only for singletons' })
    } else {
      assertNotSingleton(c)
    }

    const schema = singleton ? (unit.before ? c.insert.partial() : c.insert) : c.update
    const data = (yield* decodeInput(schema, ctx.input)) as Row

    if (singleton) {
      unit.values = asValidated({ ...data, singletonKey: c.name })
      const merged = { ...(unit.before ?? {}), ...data }
      if (unit.before) yield* assertStatusTransition(c, unit.before, data.status, merged)
      yield* checkConditions(c.applyConditions, merged)
      return
    }
    unit.values = asValidated({ ...data, updatedAt: new Date(ctx.facts.now) })
    if (unit.before) {
      const merged = { ...unit.before, ...data }
      yield* assertStatusTransition(c, unit.before, data.status, merged)
      yield* checkConditions(c.applyConditions, merged)
    }
  }), { sealed: true })
}

/** A status column only ever carries a `Status`; a bulk patch's zod schema already restricts it to the
 *  two literals, so this narrows rather than validates. `null` (no row at all — the rollback pipeline
 *  restoring a currently-deleted record) is modeled as transitioning FROM `'draft'`: the same free,
 *  unguarded starting point every other path effectively has for a record that does not yet exist, so
 *  reaching `'published'` from there still runs the same `conditionsValid` guard as any other publish —
 *  never a bespoke "restore always wins" carve-out. */
function statusOf(row: Row | null): Status {
  return (row?.status as Status | undefined) ?? 'draft'
}

/**
 * The single gate every status-mutating write path (`updateOne`, `updateMany`, and — since both are
 * `updateMany` under the hood — the admin publish/unpublish actions) runs through: `workflow.ts`'s
 * `transitions` table. A no-op call (`to` absent, or the collection's status not among the patch keys) is
 * not a transition and is left alone. `conditionsValid` is evaluated once here and fed to `canTransition`
 * as data — the table decides legality, this function only supplies the one fact it needs.
 *
 * Exported for its own test: with two statuses and a full 2x2 `transitions` table, every `from` a
 * registered collection can actually hand this (its own `status` column, DB-enforced to the closed
 * union) always matches a row, so the final generic failure below is unreachable through any real
 * pipeline run — it only fires for a `from` outside the union, which can't arise from real data but is
 * exercised directly against this export as a defensive check against a corrupted row.
 * @public
 */
export function assertStatusTransition(c: BuiltCollection, from: Row | null, to: unknown, merged: Row): Effect.Effect<void, ValidationFailed> {
  if (to !== 'draft' && to !== 'published') return Effect.void
  return Effect.gen(function* () {
    const conditionsValid = to !== 'published'
      || Exit.isSuccess(Effect.runSyncExit(checkConditions(c.applyConditions, merged)))
    const guardResults: Partial<Record<GuardName, boolean>> = { conditionsValid }
    if (!canTransition(statusOf(from), to, guardResults)) {
      // Reproduces the real field-level issues when the guard is what failed; a defensive fallback
      // otherwise, for a `from` outside the closed Status union (see the doc comment above).
      if (!conditionsValid) yield* checkConditions(c.applyConditions, merged)
      return yield* Effect.fail(new ValidationFailed({ issues: [{ path: ['status'], message: `illegal transition from '${statusOf(from)}' to '${to}'` }] }))
    }
  })
}

/** Validate a bulk patch against the rows it will be applied to, gated by `workflow.ts`'s transition
 *  table. `status` is re-validated on PUBLISH only (including a re-publish of an already-published row) —
 * @public
 *  taking a broken page offline must never be blockable. */
export function validatePatchStep(): StepDef {
  return syncStep('validate', (ctx) => Effect.gen(function* () {
    const c = collectionOf(ctx)
    const data = (yield* decodeInput(c.update, patchOf(ctx.input))) as Row
    // Same guarded columns the single-record update strips in `persist`: one bulk statement must not
    // rewrite primary keys, creation times, or the translation-group/singleton identity of every row.
    const patch = stripGuardedPatchKeys(data)
    for (const unit of unitsOf(ctx)) yield* assertStatusTransition(c, unit.before!, patch.status, { ...unit.before, ...patch })
    // One `updatedAt` for the whole batch: `persist` writes the rows in ONE statement.
    const values = asValidated({ ...patch, updatedAt: new Date(ctx.facts.now) })
    ctx.work.patchValues = values
    for (const unit of unitsOf(ctx)) unit.values = values
  }), { sealed: true })
}

/** @public */
export interface BulkPatchInput {
  ids: number[]
  patch: Row
}

/** @public */
export function patchOf(input: unknown): Row {
  return (input as BulkPatchInput).patch
}
