import { describe, it, expect } from 'vitest'
import type { SerializedCollection } from '@kestrel/core'
import { availableColumns, defaultVisibleKeys, hasReferenceFields, resolveVisibleColumns, TRANSLATIONS_KEY, DEAD_REFS_KEY } from './list-columns'

const base = (over: Partial<SerializedCollection> = {}): SerializedCollection => ({
  name: 'pages',
  mode: 'multi',
  translatable: true,
  pageLike: true,
  seo: true,
  status: true,
  blocks: { enabled: true },
  fields: {
    title: { type: 'text', required: true, unique: false },
    body: { type: 'richtext', required: false, unique: false },
    author: { type: 'relation', required: false, unique: false, single: true, relation: { collection: 'users', many: false } },
  },
  ...over,
})

describe('availableColumns', () => {
  it('lists id · fields · slug · status · timestamps · translations · dead-refs in order', () => {
    const keys = availableColumns(base()).map((c) => c.key)
    expect(keys).toEqual(['id', 'title', 'body', 'authorId', 'path', 'status', 'createdAt', 'updatedAt', TRANSLATIONS_KEY, DEAD_REFS_KEY])
  })

  it('uses the jsKey for a single relation column', () => {
    expect(availableColumns(base()).find((c) => c.name === 'author')!.key).toBe('authorId')
  })

  it('sorts scalar fields but not richtext; richtext IS filterable (substring), relation by id', () => {
    const cols = availableColumns(base())
    const by = (k: string) => cols.find((c) => c.key === k)!
    expect(by('title').sortable).toBe(true)
    expect(by('title').filterable).toBe(true)
    expect(by('body').sortable).toBe(false) // richtext is not sortable…
    expect(by('body').filterable).toBe(true) // …but is filterable via substring (contains)
    expect(by('authorId').sortable).toBe(true) // single relation is filterable/sortable by id
  })

  it('assigns a filterKind to each filterable column (drives the operator set + typed value control)', () => {
    const cols = availableColumns(base())
    const by = (k: string) => cols.find((c) => c.key === k)!
    expect(by('id').filterKind).toBe('number')
    expect(by('title').filterKind).toBe('text')
    expect(by('body').filterKind).toBe('richtext')
    expect(by('authorId').filterKind).toBe('ref') // single relation → eq/ne by id
    expect(by('path').filterKind).toBe('text')
    expect(by('status').filterKind).toBe('enum')
    expect(by('createdAt').filterKind).toBe('datetime')
    expect(by(TRANSLATIONS_KEY).filterKind).toBeUndefined() // not filterable → no kind
  })

  it('timestamps are sortable AND filterable (a datetime kind with real operators); translations is neither', () => {
    const cols = availableColumns(base())
    expect(cols.find((c) => c.key === 'createdAt')!.sortable).toBe(true)
    expect(cols.find((c) => c.key === 'createdAt')!.filterable).toBe(true)
    const tr = cols.find((c) => c.key === TRANSLATIONS_KEY)!
    expect(tr.sortable).toBe(false)
    expect(tr.filterable).toBe(false)
  })

  it('omits slug/status/translations when the collection lacks those features (dead-refs stays: it holds refs)', () => {
    const keys = availableColumns(base({ pageLike: false, status: false, translatable: false })).map((c) => c.key)
    expect(keys).toEqual(['id', 'title', 'body', 'authorId', 'createdAt', 'updatedAt', DEAD_REFS_KEY])
  })

  it('omits the dead-refs column for a collection that can hold no references', () => {
    const keys = availableColumns(base({
      seo: false, // seo carries a media ref (the social image), so a reference-free collection must disable it
      blocks: { enabled: false },
      fields: { title: { type: 'text', required: false, unique: false } },
    })).map((c) => c.key)
    expect(keys).not.toContain(DEAD_REFS_KEY)
  })

  it('omits translations for a single-mode collection even when translatable', () => {
    const keys = availableColumns(base({ mode: 'single' })).map((c) => c.key)
    expect(keys).not.toContain(TRANSLATIONS_KEY)
  })
})

describe('defaultVisibleKeys', () => {
  it('hides id and heavy fields, keeps scalar fields + slug + status + timestamps + translations + dead-refs', () => {
    expect(defaultVisibleKeys(base())).toEqual(['title', 'path', 'status', 'createdAt', 'updatedAt', TRANSLATIONS_KEY, DEAD_REFS_KEY])
  })

  it('drops a multi-value choice but keeps a single one', () => {
    const schema = base({
      pageLike: false,
      status: false,
      translatable: false,
      seo: false, // no seo → no dead-refs column, so the visible set is just the fields + timestamps
      blocks: { enabled: false },
      fields: {
        size: { type: 'choice', required: false, unique: false, options: { choices: [], multiple: false } },
        tags: { type: 'choice', required: false, unique: false, options: { choices: [], multiple: true } },
      },
    })
    expect(defaultVisibleKeys(schema)).toEqual(['size', 'createdAt', 'updatedAt'])
  })
})

describe('hasReferenceFields', () => {
  it('is true for blocks, relation, media, link, richtext, or a repeater holding one', () => {
    expect(hasReferenceFields(base({ blocks: { enabled: true }, fields: {} }))).toBe(true)
    const f = (field: Record<string, unknown>) =>
      hasReferenceFields(base({ blocks: { enabled: false }, fields: { x: { required: false, unique: false, ...field } as never } }))
    expect(f({ type: 'relation', relation: { collection: 'u', many: false } })).toBe(true)
    expect(f({ type: 'media' })).toBe(true)
    expect(f({ type: 'link' })).toBe(true)
    expect(f({ type: 'richtext' })).toBe(true)
    expect(f({ type: 'repeater', options: { fields: { y: { type: 'link', required: false, unique: false } } } })).toBe(true)
  })
  it('is true when only the seo social-image column is present (no other ref fields)', () => {
    expect(hasReferenceFields(base({ seo: true, blocks: { enabled: false }, fields: { title: { type: 'text', required: false, unique: false } } }))).toBe(true)
  })
  it('is false for a collection of only plain scalar fields, no blocks, no seo', () => {
    expect(hasReferenceFields(base({
      seo: false,
      blocks: { enabled: false },
      fields: { title: { type: 'text', required: false, unique: false } },
    }))).toBe(false)
  })
})

describe('resolveVisibleColumns', () => {
  it('keeps canonical order and drops unknown/stale keys', () => {
    const available = availableColumns(base())
    const cols = resolveVisibleColumns(available, ['status', 'gone', 'title', 'id'])
    expect(cols.map((c) => c.key)).toEqual(['id', 'title', 'status'])
  })
})
