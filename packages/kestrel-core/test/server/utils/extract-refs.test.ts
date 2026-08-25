import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { extractFieldRefs, extractRecordRefs, extractLocatedRecordRefs } from '../../../src/server/utils/extract-refs.js'
import { defineCollection, type FieldDef } from '../../../src/server/utils/defineCollection.js'
import { registerBlock, clearBlocks } from '../../../src/server/blocks/registry.js'
import { richtextLinkHref } from '../../../src/app/utils/richtext-links.js'

const relation = (collection: string, many = false): FieldDef => ({ type: 'relation', relation: { collection, many } })
const media = (multiple = false): FieldDef => ({ type: 'media', options: { multiple } })

describe('extractFieldRefs — single value bag', () => {
  describe('relation', () => {
    it('reads a single relation from the `${name}Id` column in columns mode', () => {
      expect(extractFieldRefs({ author: relation('users') }, { authorId: 5 }, 'columns')).toEqual([{ collection: 'users', id: 5 }])
    })
    it('reads a single relation from the BARE name in props mode (asymmetry)', () => {
      expect(extractFieldRefs({ author: relation('users') }, { author: 5 }, 'props')).toEqual([{ collection: 'users', id: 5 }])
    })
    it('does NOT read the bare name in columns mode (the FK column is `${name}Id`)', () => {
      expect(extractFieldRefs({ author: relation('users') }, { author: 5 }, 'columns')).toEqual([])
    })
    it('reads a many-relation from the bare name (a json array) in either mode', () => {
      expect(extractFieldRefs({ tags: relation('tags', true) }, { tags: [1, 2, 3] }, 'columns')).toEqual([
        { collection: 'tags', id: 1 }, { collection: 'tags', id: 2 }, { collection: 'tags', id: 3 },
      ])
      expect(extractFieldRefs({ tags: relation('tags', true) }, { tags: [7] }, 'props')).toEqual([{ collection: 'tags', id: 7 }])
    })
    it('ignores non-numeric / missing relation values', () => {
      expect(extractFieldRefs({ author: relation('users') }, {}, 'columns')).toEqual([])
      expect(extractFieldRefs({ author: relation('users') }, { authorId: null }, 'columns')).toEqual([])
      expect(extractFieldRefs({ tags: relation('tags', true) }, { tags: [1, 'x', null, 2] }, 'props')).toEqual([
        { collection: 'tags', id: 1 }, { collection: 'tags', id: 2 },
      ])
    })
  })

  describe('media', () => {
    it('reads single media from `${name}Id` (columns) / bare (props), targeting the `media` collection', () => {
      expect(extractFieldRefs({ cover: media() }, { coverId: 7 }, 'columns')).toEqual([{ collection: 'media', id: 7 }])
      expect(extractFieldRefs({ cover: media() }, { cover: 7 }, 'props')).toEqual([{ collection: 'media', id: 7 }])
    })
    it('reads multiple media from the bare json array', () => {
      expect(extractFieldRefs({ gallery: media(true) }, { gallery: [2, 4] }, 'columns')).toEqual([
        { collection: 'media', id: 2 }, { collection: 'media', id: 4 },
      ])
    })
  })

  describe('link', () => {
    it('reads an internal link as a (collection,id) ref (bare key, both modes)', () => {
      const cta: FieldDef = { type: 'link' }
      expect(extractFieldRefs({ cta }, { cta: { type: 'internal', collection: 'pages', id: 9 } }, 'columns')).toEqual([{ collection: 'pages', id: 9 }])
      expect(extractFieldRefs({ cta }, { cta: { type: 'internal', collection: 'pages', id: 9 } }, 'props')).toEqual([{ collection: 'pages', id: 9 }])
    })
    it('ignores external / email / tel / null / malformed links', () => {
      const cta: FieldDef = { type: 'link' }
      expect(extractFieldRefs({ cta }, { cta: { type: 'external', url: 'https://x' } }, 'columns')).toEqual([])
      expect(extractFieldRefs({ cta }, { cta: { type: 'email', email: 'a@b.c' } }, 'columns')).toEqual([])
      expect(extractFieldRefs({ cta }, { cta: null }, 'columns')).toEqual([])
      expect(extractFieldRefs({ cta }, { cta: { type: 'internal', collection: 'pages' } }, 'columns')).toEqual([])
    })
  })

  describe('richtext', () => {
    it('extracts every internal-link marker in the HTML', () => {
      const html = `<p><a href="${richtextLinkHref('pages', 5)}">a</a> <a href="${richtextLinkHref('posts', 9)}">b</a></p>`
      expect(extractFieldRefs({ body: { type: 'richtext' } }, { body: html }, 'columns')).toEqual([
        { collection: 'pages', id: 5 }, { collection: 'posts', id: 9 },
      ])
    })
    it('ignores non-string / plain HTML', () => {
      expect(extractFieldRefs({ body: { type: 'richtext' } }, { body: '<p>plain</p>' }, 'columns')).toEqual([])
      expect(extractFieldRefs({ body: { type: 'richtext' } }, { body: null }, 'columns')).toEqual([])
    })
  })

  describe('repeater', () => {
    const items: FieldDef = {
      type: 'repeater',
      options: { fields: { ref: relation('pages'), pic: media(), cta: { type: 'link' } } },
    }
    it('recurses into each entry with props keyMode (bare keys)', () => {
      const bag = { items: [{ ref: 1, pic: 2, cta: { type: 'internal', collection: 'posts', id: 3 } }, { ref: 4, pic: 5 }] }
      expect(extractFieldRefs({ items }, bag, 'columns')).toEqual([
        { collection: 'pages', id: 1 }, { collection: 'media', id: 2 }, { collection: 'posts', id: 3 },
        { collection: 'pages', id: 4 }, { collection: 'media', id: 5 },
      ])
    })
    it('tolerates non-array / non-object entries', () => {
      expect(extractFieldRefs({ items }, { items: 'nope' }, 'columns')).toEqual([])
      expect(extractFieldRefs({ items }, { items: [null, 1, { ref: 8 }] }, 'columns')).toEqual([{ collection: 'pages', id: 8 }])
    })
  })

  describe('non-reference field types and dedupe', () => {
    it('ignores text/number/boolean/datetime/choice/json', () => {
      const fields: Record<string, FieldDef> = {
        a: { type: 'text' }, b: { type: 'number' }, c: { type: 'boolean' },
        d: { type: 'datetime' }, e: { type: 'choice', options: { choices: [{ label: 'x', value: 'x' }] } }, f: { type: 'json' },
      }
      expect(extractFieldRefs(fields, { a: 'x', b: 1, c: true, d: '2020-01-01', e: 'x', f: { author: 99 } }, 'columns')).toEqual([])
    })
    it('dedupes identical (collection,id) refs across fields', () => {
      const fields = { a: relation('pages'), b: relation('pages'), tags: relation('pages', true) }
      const bag = { aId: 1, bId: 1, tags: [1, 2] }
      expect(extractFieldRefs(fields, bag, 'columns')).toEqual([{ collection: 'pages', id: 1 }, { collection: 'pages', id: 2 }])
    })
  })
})

describe('extractRecordRefs — whole record (top-level + blocks)', () => {
  beforeEach(() => {
    clearBlocks()
    registerBlock({ name: 'hero', fields: { cta: { type: 'link' }, img: media() } })
    registerBlock({ name: 'wrap', fields: { ref: relation('pages') }, slots: ['default'] })
  })
  afterEach(() => clearBlocks())

  it('combines top-level columns (Id-suffixed) with block props (bare), recursing slots, deduped', () => {
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false, pageLike: true, blocks: { enabled: true },
      fields: { author: relation('users'), body: { type: 'richtext' } },
    })
    const row = {
      id: 1,
      authorId: 10,
      body: `<a href="${richtextLinkHref('posts', 20)}">x</a>`,
      content: [
        { id: 'b1', type: 'hero', props: { cta: { type: 'internal', collection: 'pages', id: 30 }, img: 40 } },
        {
          id: 'b2', type: 'wrap', props: { ref: 50 },
          slots: { default: [{ id: 'b3', type: 'hero', props: { cta: { type: 'internal', collection: 'pages', id: 30 }, img: 60 } }] },
        },
      ],
    }
    expect(extractRecordRefs(def, row)).toEqual([
      { collection: 'users', id: 10 },
      { collection: 'posts', id: 20 },
      { collection: 'pages', id: 30 },
      { collection: 'media', id: 40 },
      { collection: 'pages', id: 50 },
      { collection: 'media', id: 60 },
    ])
  })

  it('ignores content when blocks are not enabled', () => {
    const def = defineCollection({ name: 'x', mode: 'multi', translatable: false, fields: { author: relation('users') } })
    expect(extractRecordRefs(def, { id: 1, authorId: 3, content: [{ id: 'b1', type: 'hero', props: { img: 9 } }] })).toEqual([
      { collection: 'users', id: 3 },
    ])
  })

  it('extracts the seo social image (seo.image) as a media ref — GC/dead-link tracking covers og:image', () => {
    const def = defineCollection({ name: 'pages', mode: 'multi', translatable: false, pageLike: true, seo: true, fields: {} })
    expect(extractRecordRefs(def, { id: 1, seo: { title: 'T', image: 12 } })).toEqual([
      { collection: 'media', id: 12 },
    ])
    expect(extractLocatedRecordRefs(def, { id: 1, seo: { image: 12 } })).toEqual([
      { field: 'seo.image', collection: 'media', id: 12 },
    ])
    // no seo bag / seo disabled → nothing
    expect(extractRecordRefs(def, { id: 1 })).toEqual([])
    const plain = defineCollection({ name: 'x', mode: 'multi', translatable: false, fields: {} })
    expect(extractRecordRefs(plain, { id: 1, seo: { image: 12 } })).toEqual([])
  })

  it('tolerates an unregistered block type and non-object nodes', () => {
    const def = defineCollection({ name: 'x', mode: 'multi', translatable: false, blocks: { enabled: true }, fields: {} })
    expect(extractRecordRefs(def, { id: 1, content: [null, 'nope', { id: 'b', type: 'unknown', props: { img: 1 } }] })).toEqual([])
  })
})

describe('extractLocatedRecordRefs — field/block attribution for the editor', () => {
  beforeEach(() => {
    clearBlocks()
    registerBlock({ name: 'hero', fields: { cta: { type: 'link' } } })
    registerBlock({ name: 'wrap', fields: {}, slots: ['default'] })
  })
  afterEach(() => clearBlocks())

  it('attributes top-level refs to the field (no blockId) and block refs to {field, blockId}', () => {
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true },
      fields: { author: relation('users') },
    })
    const row = {
      id: 1, authorId: 7,
      content: [{ id: 'b1', type: 'hero', props: { cta: { type: 'internal', collection: 'pages', id: 9 } } }],
    }
    expect(extractLocatedRecordRefs(def, row)).toEqual([
      { field: 'author', collection: 'users', id: 7 },
      { field: 'cta', blockId: 'b1', collection: 'pages', id: 9 },
    ])
  })

  it('attributes a repeater-nested ref to the repeater field key', () => {
    const def = defineCollection({
      name: 'x', mode: 'multi', translatable: false,
      fields: { rows: { type: 'repeater', options: { fields: { link: { type: 'link' } } } } },
    })
    const row = { id: 1, rows: [{ link: { type: 'internal', collection: 'posts', id: 4 } }] }
    expect(extractLocatedRecordRefs(def, row)).toEqual([{ field: 'rows', collection: 'posts', id: 4 }])
  })

  it('uses the innermost block id for a ref nested in a slot', () => {
    const def = defineCollection({ name: 'x', mode: 'multi', translatable: false, blocks: { enabled: true }, fields: {} })
    const row = {
      id: 1,
      content: [{ id: 'outer', type: 'wrap', props: {}, slots: { default: [{ id: 'inner', type: 'hero', props: { cta: { type: 'internal', collection: 'pages', id: 2 } } }] } }],
    }
    expect(extractLocatedRecordRefs(def, row)).toEqual([{ field: 'cta', blockId: 'inner', collection: 'pages', id: 2 }])
  })
})
