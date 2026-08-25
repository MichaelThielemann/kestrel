import { Effect } from 'effect'
import { collectionOf, type Row } from './shared.js'
import type { ListResult } from './read-shared.js'
import type { BuiltCollection } from '@kestrel/core'
import { syncStep, type StepDef } from '../types.js'

/** Replace a row that no longer matches its collection's select schema with the quarantine shape. The
 *  schema itself is compiled once at `buildCollection` time (`c.select`), so this is a plain `safeParse`
 *  per row, not a per-row schema build. Sidecar `$`-prefixed fields (from `populate`/`attachMeta`) are
 *  outside the schema's shape and stripped-not-rejected by Zod's default object mode, so they never trip
 *  a false quarantine. */
function quarantineIfInvalid(c: BuiltCollection, row: Row): Row {
  return c.select.safeParse(row).success ? row : { id: row.id, $quarantined: true }
}

/** SEALED — the last defense between a corrupted stored row (written valid, drifted since) and the
 * @public
 *  response: no patch may widen what a caller can see past this check without `unsafeReplace: true`. */
export function validateOutOneStep(): StepDef {
  return syncStep('validateOut', (ctx) => Effect.sync(() => {
    const c = collectionOf(ctx)
    const row = ctx.output as Row | null
    if (row == null) return
    ctx.output = quarantineIfInvalid(c, row)
  }), { sealed: true })
}

/** @public */
export function validateOutManyStep(): StepDef {
  return syncStep('validateOut', (ctx) => Effect.sync(() => {
    const c = collectionOf(ctx)
    const result = ctx.output as ListResult
    let quarantinedCount = 0
    result.data = result.data.map((row) => {
      const out = quarantineIfInvalid(c, row)
      if (out !== row) quarantinedCount++
      return out
    })
    result.quarantinedCount = quarantinedCount
  }), { sealed: true })
}
