import { z } from 'zod'
import type { ZodObject } from 'zod'
import type { FieldDef, Localized } from '../../../core/server/utils/defineCollection'
import { buildFieldObjectSchema } from './buildFieldSchema'
import { refineConditionalRequired } from './conditional-required'

export interface BlockDef {
  name: string
  fields: Record<string, FieldDef>
  slots?: string[]
  label?: Localized
  /** Optional icon name for the admin block picker (e.g. a lucide name). Set via the SFC's `defineBlock`. */
  icon?: string
  /** Optional preview image (URL/path, e.g. '/block-previews/hero.png') shown above the name in the picker. */
  image?: string
}

const blocks = new Map<string, BlockDef>()

export function defineBlock(def: BlockDef): BlockDef {
  return def
}
export function registerBlock(def: BlockDef): void {
  blocks.set(def.name, def)
}
export function getBlock(name: string): BlockDef | undefined {
  return blocks.get(name)
}
export function clearBlocks(): void {
  blocks.clear()
}
export function allBlocks(allowed?: string[]): BlockDef[] {
  const all = [...blocks.values()]
  return allowed?.length ? all.filter((b) => allowed.includes(b.name)) : all
}

const MAX_BLOCK_DEPTH = 60
const MAX_BLOCK_NODES = 10_000

// Iterative (no recursion) traversal so the guard itself can't stack-overflow.
function withinBlockBounds(value: unknown): boolean {
  const stack: Array<{ v: unknown; depth: number }> = [{ v: value, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const top = stack.pop() as { v: unknown; depth: number }
    const { v, depth } = top
    if (v === null || typeof v !== 'object') continue
    if (depth > MAX_BLOCK_DEPTH) return false
    if (++nodes > MAX_BLOCK_NODES) return false
    if (Array.isArray(v)) {
      for (const item of v) stack.push({ v: item, depth: depth + 1 })
    } else {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        stack.push({ v: (v as Record<string, unknown>)[key], depth: depth + 1 })
      }
    }
  }
  return true
}

export function buildBlocksSchema(blockDefs: BlockDef[]): z.ZodType {
  const node: z.ZodType = blockDefs.length
    ? z.lazy(() =>
        z.discriminatedUnion(
          'type',
          blockDefs.map((b) =>
            z.object({
              id: z.string().min(1),
              type: z.literal(b.name),
              props: refineConditionalRequired(z.object(buildFieldObjectSchema(b.fields)), b.fields),
              slots: b.slots?.length
                ? z.object(Object.fromEntries(b.slots.map((s) => [s, z.array(node)]))).partial().optional()
                : z.undefined().optional(),
            }),
          ) as unknown as [ZodObject, ...ZodObject[]],
        ),
      )
    : z.never()
  return z.unknown()
    .superRefine((val, ctx) => {
      if (!withinBlockBounds(val)) {
        ctx.addIssue({ code: 'custom', message: 'Block tree exceeds the maximum depth or size' })
      }
    })
    .pipe(z.array(node))
}
