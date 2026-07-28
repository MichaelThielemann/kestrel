import type { FieldDef } from '../../../core/server/utils/defineCollection'
import { fieldIs } from '../../../core/server/utils/defineCollection'
import { seoPopulateFields } from '../../../core/server/utils/seo'
import type { Populator, PopulateCtx, KeyMode, FieldPopulator } from '../../../core/server/utils/populate'
import { getFieldPopulator } from '../../../core/server/utils/populate'
import { buildBlockPopulator } from './block-populate'

/** How the walker finds the populator for a field type — the global registry by default, or an explicit
 *  map (used by tests + the media/link whole-row compatibility builders to run one populator in isolation). */
export type PopulatorLookup = (type: string) => FieldPopulator | undefined

/**
 * Apply the registered per-field-type populators over ONE flat value bag (top-level row | block props | a
 * repeater entry). For each field: dispatch to its type's populator (which reads by `keyMode` and mutates
 * `bag`), then — for a repeater — clone its entries and recurse in PROPS mode. Cloning the array + entries
 * keeps the ORIGINAL row untouched (population is non-destructive). Mutates `bag` in place. This is the
 * `bagRefs` recursion (see `extract-refs.ts`), generalised from "collect refs" to "run a visitor".
 */
export function applyFieldPopulators(
  bag: Record<string, unknown>,
  fields: Record<string, FieldDef>,
  keyMode: KeyMode,
  ctx: PopulateCtx,
  lookup: PopulatorLookup,
): void {
  for (const [key, field] of Object.entries(fields)) {
    // A per-instance `field.populate` (Pruvious `additional.population`) wins over the type's default.
    const fn = field.populate ?? lookup(field.type)
    if (fn) fn(bag, key, field, ctx, keyMode)
    if (fieldIs(field, 'repeater')) {
      const entries = bag[key]
      if (Array.isArray(entries)) {
        const cloned = entries.map((e) => (e && typeof e === 'object' ? { ...(e as Record<string, unknown>) } : e))
        bag[key] = cloned
        for (const entry of cloned) {
          if (entry && typeof entry === 'object') {
            applyFieldPopulators(entry as Record<string, unknown>, field.options.fields, 'props', ctx, lookup)
          }
        }
      }
    }
  }
}

/**
 * The single global row populator: walks a row's top-level fields (COLUMNS mode) and, when blocks are
 * enabled, its block tree (each node's props in PROPS mode + every slot), dispatching each field to its
 * registered per-type populator and recursing repeaters. Non-destructive (returns a fresh row; block
 * nodes/props are cloned by `buildBlockPopulator`, repeater entries by `applyFieldPopulators`).
 */
export function buildFieldTreePopulator(lookup: PopulatorLookup = getFieldPopulator): Populator {
  return (row, ctx) => {
    const out: Record<string, unknown> = { ...row }
    applyFieldPopulators(out, ctx.def.fields, 'columns', ctx, lookup)
    // The `seo` system column carries a media reference (the social image) — walk it like a props bag
    // so the id resolves under `seo.$media.image` with the same read-capture as any media field.
    if (ctx.def.seo && out.seo && typeof out.seo === 'object') {
      const seoBag = { ...(out.seo as Record<string, unknown>) }
      applyFieldPopulators(seoBag, seoPopulateFields, 'props', ctx, lookup)
      out.seo = seoBag
    }
    if (ctx.def.blocks?.enabled && Array.isArray(out.content)) {
      const walk = buildBlockPopulator((props, fields) => applyFieldPopulators(props, fields, 'props', ctx, lookup))
      out.content = walk(out.content)
    }
    return out
  }
}
