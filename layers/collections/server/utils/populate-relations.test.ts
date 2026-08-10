import { describe, it, expect, beforeEach } from 'vitest'
import { buildRelationFieldPopulator, skipMissing, type ResolveRecord } from './populate-relations'
import { buildFieldTreePopulator } from '../../../fields/server/utils/field-populate'
import type { FieldPopulator } from '../../../core/server/utils/populate'
import { withResolveScope } from '../../../core/server/utils/resolve-scope'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { defineBlock, registerBlock, clearBlocks } from '../../../fields/server/utils/defineBlock'

beforeEach(() => clearBlocks())

// Fake record resolver standing in for getOne: a marker record for known ids, null for a stale/deleted/draft
// id (getOne would 404 → the plugin maps that to null). Records every call so the depth-decrement is assertable.
const calls: Array<{ collection: string; id: number; depth: number; locale: string; publicOnly: boolean }> = []
const fakeResolve: ResolveRecord = (collection, id, depth, locale, publicOnly) => {
  calls.push({ collection, id, depth, locale, publicOnly })
  if (id === 999) return null
  return { id, label: `${collection}#${id}`, depthSeen: depth }
}
beforeEach(() => { calls.length = 0 })

// authors / speakers stand in for a collection the real access guard would refuse an anonymous caller.
const relPop = buildRelationFieldPopulator(fakeResolve, (collection) => collection === 'pages')
const lookup = (t: string): FieldPopulator | undefined => (t === 'relation' ? relPop : undefined)
const populate = buildFieldTreePopulator(lookup)

describe('relation field populator (under the field-tree walker)', () => {
  it('expands a SINGLE relation (columns key `${key}Id`) under $<name>, leaving the raw id intact', () => {
    const def = defineCollection({
      name: 'posts', mode: 'multi', translatable: false,
      fields: { author: { type: 'relation', relation: { collection: 'authors' } } },
    })
    const out = populate({ id: 1, authorId: 7 }, { depth: 2, locale: 'en', def })
    expect(out.authorId).toBe(7)
    expect(out.$author).toEqual({ id: 7, label: 'authors#7', depthSeen: 1 })
  })

  it('passes the DECREMENTED depth to the related read (the cycle guard)', () => {
    const def = defineCollection({
      name: 'posts', mode: 'multi', translatable: false,
      fields: { author: { type: 'relation', relation: { collection: 'authors' } } },
    })
    populate({ id: 1, authorId: 7 }, { depth: 3, locale: 'de', def })
    expect(calls).toEqual([{ collection: 'authors', id: 7, depth: 2, locale: 'de', publicOnly: false }])
  })

  it('expands a MANY relation into an array under $<name>, filtering out stale ids', () => {
    const def = defineCollection({
      name: 'lineups', mode: 'multi', translatable: false,
      fields: { speakers: { type: 'relation', relation: { collection: 'speakers', many: true } } },
    })
    const out = populate({ id: 1, speakers: [1, 999, 2] }, { depth: 1, locale: 'en', def })
    expect(out.speakers).toEqual([1, 999, 2]) // raw ids untouched
    expect(out.$speakers).toEqual([
      { id: 1, label: 'speakers#1', depthSeen: 0 },
      { id: 2, label: 'speakers#2', depthSeen: 0 },
    ])
  })

  it('leaves $<name> as null for a single stale/missing relation', () => {
    const def = defineCollection({
      name: 'posts', mode: 'multi', translatable: false,
      fields: { author: { type: 'relation', relation: { collection: 'authors' } } },
    })
    const out = populate({ id: 1, authorId: 999 }, { depth: 2, locale: 'en', def })
    expect(out.$author).toBeNull()
  })

  it('expands relations nested in a REPEATER (props key-mode → bare key)', () => {
    const def = defineCollection({
      name: 'posts', mode: 'multi', translatable: false,
      fields: { rows: { type: 'repeater', options: { fields: { author: { type: 'relation', relation: { collection: 'authors' } } } } } },
    })
    const out = populate({ id: 1, rows: [{ author: 3 }, { author: 4 }] }, { depth: 2, locale: 'en', def })
    const rows = out.rows as Array<Record<string, unknown>>
    expect(rows[0].$author).toEqual({ id: 3, label: 'authors#3', depthSeen: 1 })
    expect(rows[1].$author).toEqual({ id: 4, label: 'authors#4', depthSeen: 1 })
  })

  it('expands a relation inside block props', () => {
    registerBlock(defineBlock({ name: 'card', fields: { author: { type: 'relation', relation: { collection: 'authors' } } } }))
    const def = defineCollection({ name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true }, fields: {} })
    const out = populate({
      id: 1,
      content: [{ id: 'a', type: 'card', props: { author: 8 } }],
    }, { depth: 2, locale: 'en', def })
    const props = (out.content as Array<{ props: Record<string, unknown> }>)[0].props
    expect(props.$author).toEqual({ id: 8, label: 'authors#8', depthSeen: 1 })
  })

  it('does not mutate the original input row or repeater entries', () => {
    const def = defineCollection({
      name: 'posts', mode: 'multi', translatable: false,
      fields: {
        author: { type: 'relation', relation: { collection: 'authors' } },
        rows: { type: 'repeater', options: { fields: { editor: { type: 'relation', relation: { collection: 'authors' } } } } },
      },
    })
    const entry = { editor: 5 }
    const row = { id: 1, authorId: 7, rows: [entry] }
    populate(row, { depth: 2, locale: 'en', def })
    expect((row as Record<string, unknown>).$author).toBeUndefined()
    expect((entry as Record<string, unknown>).$editor).toBeUndefined()
  })
})

describe('relation populator under a public-only read', () => {
  const def = defineCollection({
    name: 'posts', mode: 'multi', translatable: false,
    fields: {
      author: { type: 'relation', relation: { collection: 'authors' } },
      related: { type: 'relation', relation: { collection: 'pages' } },
    },
  })

  it('keeps the raw id but attaches no $<name> for a target the caller could not read directly', () => {
    const out = populate({ id: 1, authorId: 7, relatedId: 3 }, { depth: 2, locale: 'en', def, publicOnly: true })
    expect(out.authorId).toBe(7)
    expect('$author' in out).toBe(false)
    expect(calls.some((c) => c.collection === 'authors')).toBe(false)
  })

  it('still expands a publicly readable target', () => {
    const out = populate({ id: 1, authorId: 7, relatedId: 3 }, { depth: 2, locale: 'en', def, publicOnly: true })
    expect(out.$related).toEqual({ id: 3, label: 'pages#3', depthSeen: 1 })
  })

  it('drops a MANY relation into a non-public target as a whole, leaving the raw ids', () => {
    const lineups = defineCollection({
      name: 'lineups', mode: 'multi', translatable: false,
      fields: { speakers: { type: 'relation', relation: { collection: 'speakers', many: true } } },
    })
    const out = populate({ id: 1, speakers: [1, 2] }, { depth: 1, locale: 'en', def: lineups, publicOnly: true })
    expect(out.speakers).toEqual([1, 2])
    expect('$speakers' in out).toBe(false)
  })

  it('caches a public-only resolve separately from an unrestricted one', () => {
    withResolveScope(() => {
      populate({ id: 1, relatedId: 3 }, { depth: 2, locale: 'en', def, publicOnly: true })
      populate({ id: 1, relatedId: 3 }, { depth: 2, locale: 'en', def })
    })
    expect(calls.map((c) => c.publicOnly)).toEqual([true, false])
  })
})

describe('skipMissing — only getOne 404 (stale/deleted/draft) becomes null; other faults propagate (fail-loud)', () => {
  it('returns the record on success', () => {
    expect(skipMissing(() => ({ id: 1, name: 'A' }))).toEqual({ id: 1, name: 'A' })
  })

  it('maps a 404 (stale/deleted/draft target) to null', () => {
    expect(skipMissing(() => { throw { statusCode: 404, statusMessage: 'not found' } })).toBeNull()
  })

  it('RE-THROWS a non-404 statusCode (e.g. a downstream 500) instead of dropping the relation silently', () => {
    expect(() => skipMissing(() => { throw { statusCode: 500 } })).toThrow()
  })

  it('RE-THROWS an ordinary Error with no statusCode (a real fault, not a missing target)', () => {
    expect(() => skipMissing(() => { throw new Error('SQLITE_BUSY') })).toThrowError('SQLITE_BUSY')
  })
})
