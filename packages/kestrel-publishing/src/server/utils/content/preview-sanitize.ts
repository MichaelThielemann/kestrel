import { fieldIs, resolveColumnName , sanitizeRichtext  } from '@kestrel/core'
import type { BuiltCollection, FieldDef } from '@kestrel/core'
import { getBlock } from '@kestrel/fields'

/**
 * Sanitize every richtext leaf reachable from `scope` (top-level fields + nested repeater entries), in
 * place. Mirrors the WALK shape of crud.ts's `applyFieldTransforms`/`transformNested`, but not the
 * mechanism: richtext's sanitizer is wired into the Zod validator (`z.string().transform(sanitizeRichtext)`
 * in field-registry/index.ts), not the field-type's `transform` hook that walk calls — and running the
 * collection's Zod schema here isn't an option anyway, see `sanitizePreviewValues` below. So this calls
 * `sanitizeRichtext` directly wherever a `richtext` field is present, and only there; every other field
 * passes through untouched.
 */
function sanitizeRichtextFields(fields: Record<string, FieldDef>, scope: Record<string, unknown>): void {
  for (const [key, fieldDef] of Object.entries(fields)) {
    const { jsKey } = resolveColumnName(key, fieldDef)
    if (!Object.hasOwn(scope, jsKey)) continue
    if (fieldIs(fieldDef, 'richtext')) {
      if (typeof scope[jsKey] === 'string') scope[jsKey] = sanitizeRichtext(scope[jsKey] as string)
    } else if (fieldIs(fieldDef, 'repeater')) {
      const entries = scope[jsKey]
      if (Array.isArray(entries)) {
        for (const entry of entries) if (entry && typeof entry === 'object') sanitizeRichtextFields(fieldDef.options.fields, entry as Record<string, unknown>)
      }
    }
  }
}

/** Same walk as `transformBlocks` in crud.ts: each block's props (by its registered field defs) + its
 *  slots' nested blocks, recursively. An unregistered block type is left as-is (matches crud.ts). */
function sanitizeRichtextInBlocks(blocks: unknown): void {
  if (!Array.isArray(blocks)) return
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; props?: unknown; slots?: unknown }
    const def = typeof b.type === 'string' ? getBlock(b.type) : undefined
    if (def && b.props && typeof b.props === 'object') sanitizeRichtextFields(def.fields, b.props as Record<string, unknown>)
    if (b.slots && typeof b.slots === 'object') for (const sub of Object.values(b.slots as Record<string, unknown>)) sanitizeRichtextInBlocks(sub)
  }
}

/**
 * Apply the richtext sanitizer to a preview ticket's `values` — the fix for the ticket bypassing it
 * entirely (it normally runs as a Zod `.transform()` on WRITE, `create`/`update`/`putSingleton` in
 * crud.ts; a ticket never reaches those). Deliberately NOT a schema parse: `values` is the editor's
 * in-progress, possibly-invalid draft (a missing required field, an out-of-range number, …), and a preview
 * exists precisely so a draft can be inspected BEFORE it would pass a save — a strict or even a `.partial()`
 * parse would legitimately reject some of what it must accept. Sanitizing is not a validity constraint
 * though (it only narrows stored bytes, the same way a save would), so a direct field-tree walk gets the
 * safety without the rejection risk. Walks top-level fields, repeater entries, and (when the collection
 * uses the block editor) block props + nested slots — everywhere a richtext leaf can live.
 * @public
 */
export function sanitizePreviewValues(collection: BuiltCollection, values: Record<string, unknown>): void {
  sanitizeRichtextFields(collection.def.fields, values)
  if (collection.def.blocks?.enabled && Object.hasOwn(values, 'content')) sanitizeRichtextInBlocks(values.content)
}
