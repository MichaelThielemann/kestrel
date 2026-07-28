import { describe, it, expect } from 'vitest'
import { defineCollection } from './defineCollection'

describe('defineCollection', () => {
  it('returns the definition unchanged (identity helper for typing)', () => {
    const def = defineCollection({
      name: 'pages',
      mode: 'multi',
      translatable: true,
      pageLike: true,
      seo: true,
      blocks: { enabled: true },
      fields: { title: { type: 'text', required: true } },
    })
    expect(def.name).toBe('pages')
    expect(def.mode).toBe('multi')
    expect(def.fields.title.type).toBe('text')
  })

  it('rejects a pageLike singleton (a routable record must be multi so the slug engine governs it)', () => {
    expect(() => defineCollection({ name: 'home', mode: 'single', translatable: false, pageLike: true, fields: {} }))
      .toThrowError(/pageLike.*multi/i)
  })

  it('rejects a collection named after a reserved framework API namespace (would leak the endpoint anonymously)', () => {
    for (const name of ['links', 'blocks', 'references', 'publish-status', 'auth']) {
      expect(() => defineCollection({ name, mode: 'multi', translatable: false, fields: {} })).toThrowError(/reserved framework API namespace/)
    }
    // a normal name is fine
    expect(() => defineCollection({ name: 'articles', mode: 'multi', translatable: false, fields: {} })).not.toThrow()
  })

  it("rejects editor: 'blocks' without blocks.enabled (the block body would mount but its content never persists)", () => {
    expect(() => defineCollection({ name: 'landing', mode: 'multi', translatable: false, editor: 'blocks', fields: {} }))
      .toThrowError(/editor.*blocks.*blocks/i)
    // the correct combination is accepted
    expect(() => defineCollection({ name: 'ok', mode: 'multi', translatable: false, editor: 'blocks', blocks: { enabled: true }, fields: {} }))
      .not.toThrow()
  })

  it('accepts a valid fieldLayout at the collection top level and inside a repeater', () => {
    expect(() => defineCollection({
      name: 'demo', mode: 'multi', translatable: false,
      fields: {
        title: { type: 'text' },
        subtitle: { type: 'text' },
        rows: { type: 'repeater', options: { fields: { a: { type: 'text' }, b: { type: 'text' } }, fieldLayout: [['a', 'b']] } },
      },
      fieldLayout: [['title|2', 'subtitle'], 'rows'],
    })).not.toThrow()
  })

  it('fails loud at definition time on a bad collection fieldLayout (unknown field / bad width)', () => {
    expect(() => defineCollection({ name: 'demo', mode: 'multi', translatable: false, fields: { a: { type: 'text' } }, fieldLayout: ['ghost'] }))
      .toThrowError(/unknown field "ghost"/)
    expect(() => defineCollection({ name: 'demo', mode: 'multi', translatable: false, fields: { a: { type: 'text' } }, fieldLayout: [['a|red']] }))
      .toThrowError(/invalid width/)
  })

  it('fails loud on a bad fieldLayout inside a nested repeater', () => {
    expect(() => defineCollection({
      name: 'demo', mode: 'multi', translatable: false,
      fields: { rows: { type: 'repeater', options: { fields: { a: { type: 'text' } }, fieldLayout: ['ghost'] } } },
    })).toThrowError(/repeater "rows".*unknown field "ghost"/)
  })

  it('accepts a discriminated-union field def with typed options', () => {
    const def = defineCollection({
      name: 'demo', mode: 'multi', translatable: false,
      fields: {
        title: { type: 'text', required: true, options: { maxLength: 200 } },
        format: { type: 'choice', options: { choices: [{ label: 'A', value: 'a' }] } },
        rows: { type: 'repeater', options: { fields: { label: { type: 'text' } } } },
      },
    })
    expect(def.fields.format.type).toBe('choice')
  })
})
