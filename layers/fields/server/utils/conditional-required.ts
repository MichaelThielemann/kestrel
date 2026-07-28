import { z } from 'zod'
import type { FieldDef } from '../../../core/server/utils/defineCollection'
import { evaluateCondition, isEmptyValue } from '../../app/utils/condition'

/**
 * Re-enforce `required` for conditional sub-fields whose condition is met, at the object level where their
 * sibling values are visible (a block's props, a repeater entry). The per-field validator relaxed a
 * `required + condition` field to optional (it can't see siblings), and the collection-level applyConditions
 * hook only walks TOP-LEVEL fields — so without this, a conditional-required prop inside a block or repeater
 * is a silent server no-op. Adds a superRefine that checks each such field against the parsed object; a no-op
 * (returns the schema unchanged) when the shape has no conditional-required fields.
 */
export function refineConditionalRequired<T extends z.ZodTypeAny>(schema: T, fields: Record<string, FieldDef>): z.ZodTypeAny {
  const conditional = Object.entries(fields).filter(([, f]) => f.condition && f.required)
  if (!conditional.length) return schema
  return schema.superRefine((val, ctx) => {
    if (!val || typeof val !== 'object') return
    const scope = val as Record<string, unknown>
    for (const [key, field] of conditional) {
      if (evaluateCondition(field.condition!, scope) && isEmptyValue(scope[key])) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'This field is required.' })
      }
    }
  })
}
