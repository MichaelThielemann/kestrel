import { createInsertSchema, createUpdateSchema, createSelectSchema } from 'drizzle-zod'
import { z } from 'zod'
import type { ZodType } from 'zod'
import type { CollectionDef } from '../../../core/server/utils/defineCollection'
import type { BuiltCollection, CollectionSchema } from '../../../core/server/utils/collection-types'
import { seoSchema } from '../../../core/server/utils/seo'
import { evaluateCondition, isEmptyValue } from '../../app/utils/condition'
import { buildTable } from './buildTable'
import { buildFieldSchema } from './buildFieldSchema'
import { resolveColumnName } from '../field-registry/naming'
import { allBlocks, buildBlocksSchema } from './defineBlock'

/** A page path is consumed verbatim at build time to derive prerender routes / output file paths,
 *  so it must be incapable of traversal: url-path-safe charset only, no `.`/`..` segments. */
export function isSafePagePath(p: string): boolean {
  if (!/^[A-Za-z0-9._~%/-]*$/.test(p)) return false
  return !p.split('/').some((seg) => seg === '.' || seg === '..')
}

export function systemRefinements(def: CollectionDef): Record<string, unknown> {
  const refine: Record<string, unknown> = {}
  if (def.translatable) refine.locale = z.string().optional()
  if (def.mode === 'single') refine.singletonKey = z.string().optional()
  else if (def.translatable) refine.translationGroup = z.string().optional()
  if (def.pageLike) refine.path = z.string().refine(isSafePagePath, 'Invalid path').nullable().optional()
  // The status column is a two-state enum; without this the schema accepts any string and a typo
  // ('publushed') stores verbatim and silently unpublishes the record (every gate matches only 'published').
  if (def.status) refine.status = z.enum(['draft', 'published']).optional()
  if (def.blocks?.enabled) refine.content = z.lazy(() => buildBlocksSchema(allBlocks(def.blocks?.allowed))).optional()
  if (def.seo) refine.seo = seoSchema.partial().optional()
  return refine
}

// Update is a partial PATCH: every field may be omitted, so the field refinements
// must be optional on update (a required validator would otherwise override
// drizzle-zod's partial column schema and force the field on every update).
function optionalize(refine: Record<string, ZodType>): Record<string, ZodType> {
  const out: Record<string, ZodType> = {}
  for (const [key, schema] of Object.entries(refine)) out[key] = schema.optional()
  return out
}

/**
 * Accept either a plain `CollectionDef` (the common consumer form: `export default defineCollection(…)`)
 * or an already-built collection (the advanced form, when a server route needs the drizzle table object
 * directly: `const built = buildCollection(…); export const t = built.table; export default built`).
 * The discriminator is the presence of `table`, which only a BuiltCollection has.
 */
export function ensureBuilt(c: CollectionDef | BuiltCollection): BuiltCollection {
  return 'table' in c ? c : buildCollection(c)
}

/**
 * Build the `applyConditions` hook for a collection with conditional required fields, or `undefined`
 * when it has none (so CRUD skips it). The per-field schema relaxed every conditional field to optional
 * (it can't see siblings); this re-enforces `required` for the ones whose condition is met against the
 * whole record. Issues are keyed by the field's def name (so they map to the editor's per-field errors),
 * resolving each value at its column key (`<name>Id` for single relation/media).
 */
function buildApplyConditions(def: CollectionDef): BuiltCollection['applyConditions'] {
  const required = Object.entries(def.fields).filter(([, f]) => f.condition && f.required)
  if (!required.length) return undefined
  return (record) => {
    const scope: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(def.fields)) scope[key] = record[resolveColumnName(key, field).jsKey]
    const issues = required
      .filter(([key, field]) => evaluateCondition(field.condition!, scope) && isEmptyValue(record[resolveColumnName(key, field).jsKey]))
      .map(([key]) => ({ path: [key], message: 'This field is required.' }))
    return { issues }
  }
}

export function buildCollection(def: CollectionDef): BuiltCollection {
  const table = buildTable(def)
  const fieldRefine = buildFieldSchema(def.fields)
  const system = systemRefinements(def)
  return {
    name: def.name,
    def,
    table,
    // Cast through the loose `CollectionSchema`: drizzle-zod's overloads otherwise infer mismatched (ZodEnum)
    // types that don't unify across the three builders (see CollectionSchema's note).
    insert: createInsertSchema(table, { ...fieldRefine, ...system } as never) as unknown as CollectionSchema,
    update: createUpdateSchema(table, { ...optionalize(fieldRefine), ...system } as never) as unknown as CollectionSchema,
    select: createSelectSchema(table) as unknown as CollectionSchema,
    applyConditions: buildApplyConditions(def),
  }
}
