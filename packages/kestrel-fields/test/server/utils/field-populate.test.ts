import { describe, it, expect, beforeEach } from 'vitest'
import { buildFieldTreePopulator } from '../../../src/server/utils/field-populate.js'
import { defineCollection } from '@michaelthielemann/kestrel-core'
import type { FieldPopulator } from '@michaelthielemann/kestrel-core'
import { defineBlock, registerBlock, clearBlocks } from '../../../src/server/utils/defineBlock.js'

beforeEach(() => clearBlocks())

// A stand-in per-type populator: reads a numeric id by key-mode (single-ref convention: `${key}Id` in
// COLUMNS, bare `key` in PROPS) and records `id*10` under a `$seen` bag — so a test can prove exactly
// WHERE the walker dispatched (top-level column, repeater entry, block prop, slot) without a DB.
const seenPop: FieldPopulator = (bag, key, _field, _ctx, keyMode) => {
  const id = bag[keyMode === 'columns' ? `${key}Id` : key]
  if (typeof id === 'number') {
    const seen = (bag.$seen as Record<string, unknown> | undefined) ?? {}
    seen[key] = id * 10
    bag.$seen = seen
  }
}
const lookup = (type: string): FieldPopulator | undefined => (type === 'media' ? seenPop : undefined)
const walk = buildFieldTreePopulator(lookup)

describe('field-tree walker — dispatches each field to its per-type populator, recursing containers', () => {
  it('dispatches a top-level column field (columns key-mode → `${key}Id`)', () => {
    const def = defineCollection({ name: 'c', mode: 'multi', translatable: false, fields: { cover: { type: 'media' } } })
    const out = walk({ id: 1, coverId: 7 }, { depth: 1, locale: 'en', def })
    expect((out.$seen as Record<string, unknown>).cover).toBe(70)
  })

  it('descends into REPEATER entries (props key-mode) — the reported media-in-repeater gap', () => {
    const def = defineCollection({
      name: 'c', mode: 'multi', translatable: false,
      fields: { items: { type: 'repeater', options: { fields: { pic: { type: 'media' } } } } },
    })
    const out = walk({ id: 1, items: [{ pic: 3 }, { pic: 4 }] }, { depth: 1, locale: 'en', def })
    const items = out.items as Array<Record<string, unknown>>
    expect((items[0].$seen as Record<string, unknown>).pic).toBe(30)
    expect((items[1].$seen as Record<string, unknown>).pic).toBe(40)
  })

  it('descends into NESTED repeaters', () => {
    const def = defineCollection({
      name: 'c', mode: 'multi', translatable: false,
      fields: {
        outer: {
          type: 'repeater',
          options: { fields: { inner: { type: 'repeater', options: { fields: { pic: { type: 'media' } } } } } },
        },
      },
    })
    const out = walk({ id: 1, outer: [{ inner: [{ pic: 5 }] }] }, { depth: 1, locale: 'en', def })
    const outer = out.outer as Array<{ inner: Array<Record<string, unknown>> }>
    expect((outer[0].inner[0].$seen as Record<string, unknown>).pic).toBe(50)
  })

  it('descends into block props AND slots, including a repeater inside block props', () => {
    registerBlock(defineBlock({ name: 'hero', fields: { image: { type: 'media' }, gal: { type: 'repeater', options: { fields: { pic: { type: 'media' } } } } }, slots: ['default'] }))
    registerBlock(defineBlock({ name: 'card', fields: { image: { type: 'media' } } }))
    const def = defineCollection({ name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true }, fields: {} })
    const out = walk({
      id: 1,
      content: [
        {
          id: 'a', type: 'hero',
          props: { image: 2, gal: [{ pic: 8 }] },
          slots: { default: [{ id: 'b', type: 'card', props: { image: 9 } }] },
        },
      ],
    }, { depth: 1, locale: 'en', def })
    const nodes = out.content as Array<Record<string, unknown>>
    const heroProps = nodes[0].props as Record<string, unknown>
    expect((heroProps.$seen as Record<string, unknown>).image).toBe(20)
    expect(((heroProps.gal as Array<Record<string, unknown>>)[0].$seen as Record<string, unknown>).pic).toBe(80)
    const cardProps = ((nodes[0].slots as Record<string, unknown>).default as Array<Record<string, unknown>>)[0].props as Record<string, unknown>
    expect((cardProps.$seen as Record<string, unknown>).image).toBe(90)
  })

  it('is a no-op at depth 0 (populateRow gate) — but the walker itself still clones; assert non-mutation of input', () => {
    const def = defineCollection({
      name: 'c', mode: 'multi', translatable: false,
      fields: { items: { type: 'repeater', options: { fields: { pic: { type: 'media' } } } } },
    })
    const entry = { pic: 3 }
    const row = { id: 1, items: [entry] }
    walk(row, { depth: 1, locale: 'en', def })
    expect((entry as Record<string, unknown>).$seen).toBeUndefined()
    expect((row as Record<string, unknown>).$seen).toBeUndefined()
  })

  it('leaves fields with no registered populator untouched', () => {
    const def = defineCollection({ name: 'c', mode: 'multi', translatable: false, fields: { title: { type: 'text' } } })
    const out = walk({ id: 1, title: 'Hi' }, { depth: 1, locale: 'en', def })
    expect(out).toEqual({ id: 1, title: 'Hi' })
  })

  it('a per-instance field.populate override wins over the registered type populator', () => {
    const def = defineCollection({
      name: 'c', mode: 'multi', translatable: false,
      // The `media` type default (seenPop) would attach `$seen`; the inline override must run instead.
      fields: { cover: { type: 'media', populate: (bag, key) => { bag.$override = key } } },
    })
    const out = walk({ id: 1, coverId: 5 }, { depth: 1, locale: 'en', def })
    expect(out.$override).toBe('cover')
    expect(out.$seen).toBeUndefined()
  })
})
