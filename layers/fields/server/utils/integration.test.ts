import { describe, it, expect, beforeEach } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { buildCollection } from './buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { defineBlock, registerBlock, clearBlocks } from './defineBlock'

beforeEach(() => clearBlocks())

describe('fields integration', () => {
  it('a multi-field collection generates columns and validates + sanitizes through insert', () => {
    registerBlock(defineBlock({ name: 'prose', fields: { body: { type: 'richtext', required: true } } }))
    const c = buildCollection(defineCollection({
      name: 'articles', mode: 'multi', translatable: true, status: true, blocks: { enabled: true },
      fields: {
        title: { type: 'text', required: true },
        rank: { type: 'number', options: { min: 0 } },
        published: { type: 'boolean' },
        cover: { type: 'media' },
        tags: { type: 'relation', relation: { collection: 'tags', many: true } },
        cta: { type: 'link' },
      },
    }))

    const cols = getTableConfig(c.table).columns.map((col) => col.name)
    expect(cols).toEqual(expect.arrayContaining(['title', 'rank', 'published', 'cover_id', 'tags', 'cta', 'content']))

    const ok = c.insert.parse({
      title: '  Hello & Co ', rank: 3, published: true, coverId: 9, tags: [1, 2],
      content: [{ id: 'x', type: 'prose', props: { body: '<script>x</script><p>hi</p>' } }],
    }) as { title: string; content: Array<{ props: { body: string } }> }
    expect(ok.title).toBe('Hello & Co') // plain text trimmed but kept verbatim
    expect(ok.content[0].props.body).toBe('<p>hi</p>') // richtext is sanitized (the real HTML surface)

    expect(c.insert.safeParse({ title: 'x', rank: -1 }).success).toBe(false) // min violated
    expect(c.insert.safeParse({ rank: 1 }).success).toBe(false)              // title required
    expect(c.insert.safeParse({ title: 'x', cta: { type: 'external', url: 'https://example.com' } }).success).toBe(true)
    expect(c.insert.safeParse({ title: 'x', cta: 'not-an-object' }).success).toBe(false) // link is a discriminated union, not a string
  })
})
