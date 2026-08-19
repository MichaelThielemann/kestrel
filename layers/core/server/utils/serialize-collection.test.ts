import { describe, it, expect } from 'vitest'
import { serializeCollection, serializeField, serializeBlock, type SerializedField } from './serialize-collection'
import type { CollectionDef } from './defineCollection'

describe('serializeField', () => {
  it('normalizes flags and passes through per-type options', () => {
    expect(serializeField({ type: 'text', required: true, options: { maxLength: 50, multiline: true } }))
      .toEqual({ type: 'text', required: true, unique: false, options: { maxLength: 50, multiline: true } })
  })

  it('serializes a relation field (collection + many + labelField)', () => {
    expect(serializeField({ type: 'relation', relation: { collection: 'pages', many: true, labelField: 'title' } }))
      .toEqual({ type: 'relation', required: false, unique: false, relation: { collection: 'pages', many: true, labelField: 'title' } })
  })

  it('recurses into repeater sub-fields', () => {
    const out = serializeField({ type: 'repeater', options: { fields: { label: { type: 'text' }, count: { type: 'number' } } } })
    expect(out.options).toEqual({ fields: {
      label: { type: 'text', required: false, unique: false },
      count: { type: 'number', required: false, unique: false },
    } })
  })

  it('serializes flag-only field types (boolean, json) with no options/relation/default', () => {
    expect(serializeField({ type: 'boolean' }))
      .toEqual({ type: 'boolean', required: false, unique: false })
    expect(serializeField({ type: 'json' }))
      .toEqual({ type: 'json', required: false, unique: false })
  })

  it('passes through media options', () => {
    expect(serializeField({ type: 'media', options: { multiple: true, accept: 'image' } }))
      .toEqual({ type: 'media', required: false, unique: false, options: { multiple: true, accept: 'image' } })
  })

  it('passes through link options (types + collections) and omits them when absent', () => {
    expect(serializeField({ type: 'link', options: { types: ['internal', 'external'], collections: ['pages'] } }).options)
      .toEqual({ types: ['internal', 'external'], collections: ['pages'] })
    expect('options' in serializeField({ type: 'link' })).toBe(false)
  })

  it('omits labelField, defaults many=false, and marks a bare relation single', () => {
    expect(serializeField({ type: 'relation', relation: { collection: 'posts' } }))
      .toEqual({ type: 'relation', required: false, unique: false, single: true, relation: { collection: 'posts', many: false } })
  })

  it('passes through choice multiple + display', () => {
    expect(serializeField({ type: 'choice', options: { choices: [{ label: 'A', value: 'a' }], multiple: true, display: 'buttons' } }).options)
      .toEqual({ choices: [{ label: 'A', value: 'a' }], multiple: true, display: 'buttons' })
  })

  it('omits options that are not JSON-serializable (mirrors the default-value guard; a bad custom-field config must not throw the whole /api/collections response)', () => {
    expect('options' in serializeField({ type: 'text', options: { maxLength: 5, bad: () => 1 } } as never)).toBe(false)
    expect('options' in serializeField({ type: 'text', options: { n: NaN } } as never)).toBe(false)
    expect(serializeField({ type: 'text', options: { maxLength: 5 } } as never).options).toEqual({ maxLength: 5 })
  })

  it('carries a resolved fieldLayout on repeater options when present, omitting it otherwise', () => {
    const withLayout = serializeField({ type: 'repeater', options: {
      fields: { a: { type: 'text' }, b: { type: 'number' } },
      fieldLayout: [['a|2', 'b']],
    } })
    expect(withLayout.options!.fieldLayout).toEqual([{ kind: 'row', fields: ['a', 'b'], tracks: [2, 1] }])
    // absent → the options carry only `fields`
    expect('fieldLayout' in serializeField({ type: 'repeater', options: { fields: { a: { type: 'text' } } } }).options!).toBe(false)
  })

  it('throws when a repeater fieldLayout references an unknown sub-field', () => {
    expect(() => serializeField({ type: 'repeater', options: { fields: { a: { type: 'text' } }, fieldLayout: ['ghost'] } }))
      .toThrowError(/unknown field "ghost"/)
  })

  it('recurses repeater sub-fields of any type, including media and nested repeaters', () => {
    const out = serializeField({ type: 'repeater', options: { fields: {
      gallery: { type: 'media', options: { multiple: true } },
      items: { type: 'repeater', options: { fields: { name: { type: 'text', required: true } } } },
    } } })
    expect(out.options).toEqual({ fields: {
      gallery: { type: 'media', required: false, unique: false, options: { multiple: true } },
      items: { type: 'repeater', required: false, unique: false, options: { fields: {
        name: { type: 'text', required: true, unique: false },
      } } },
    } })
  })

  it('keeps a JSON-safe default but drops a function default', () => {
    expect(serializeField({ type: 'number', default: 7 }).default).toBe(7)
    expect('default' in serializeField({ type: 'text', default: (() => 'x') as unknown })).toBe(false)
  })

  it('keeps JSON-safe object/array defaults but drops a non-JSON default (Date)', () => {
    expect(serializeField({ type: 'json', default: { theme: 'dark' } }).default).toEqual({ theme: 'dark' })
    expect(serializeField({ type: 'choice', options: { choices: [{ label: 'A', value: 'a' }], multiple: true }, default: ['a'] }).default).toEqual(['a'])
    expect('default' in serializeField({ type: 'datetime', default: new Date() as unknown })).toBe(false)
  })

  it('copies a field condition top-level, for plain, relation, repeater sub-field, and block fields', () => {
    const condition = { field: 'type', is: 'image' } as const
    expect(serializeField({ type: 'media', condition }).condition).toEqual(condition)
    expect(serializeField({ type: 'relation', relation: { collection: 'p' }, condition }).condition).toEqual(condition)
    const rep = serializeField({ type: 'repeater', options: { fields: { cta: { type: 'link', condition } } } })
    expect((rep.options!.fields as Record<string, SerializedField>).cta!.condition).toEqual(condition)
    expect(serializeBlock({ name: 'hero', fields: { cta: { type: 'link', condition } } }).fields.cta!.condition).toEqual(condition)
  })

  it('omits condition when absent', () => {
    expect('condition' in serializeField({ type: 'text' })).toBe(false)
  })
})

describe('serializeCollection', () => {
  const def: CollectionDef = {
    name: 'pages',
    mode: 'multi',
    translatable: true,
    pageLike: true,
    seo: true,
    status: true,
    blocks: { enabled: true, allowed: ['hero', 'prose'] },
    label: { singular: 'Page', plural: 'Pages' },
    icon: 'file-text',
    fields: {
      title: { type: 'text', required: true },
      format: { type: 'choice', options: { choices: [{ label: 'A', value: 'a' }], multiple: false } },
    },
  }

  it('allowlists collection metadata, normalizes flags, and serializes fields', () => {
    expect(serializeCollection(def)).toEqual({
      name: 'pages',
      mode: 'multi',
      translatable: true,
      pageLike: true,
      seo: true,
      status: true,
      blocks: { enabled: true, allowed: ['hero', 'prose'] },
      editor: 'blocks',
      nav: true,
      label: { singular: 'Page', plural: 'Pages' },
      icon: 'file-text',
      fields: {
        title: { type: 'text', required: true, unique: false },
        format: { type: 'choice', required: false, unique: false, options: { choices: [{ label: 'A', value: 'a' }], multiple: false } },
      },
    })
  })

  it('defaults absent collection flags to false and blocks to disabled', () => {
    const out = serializeCollection({ name: 'settings', mode: 'single', translatable: false, fields: {} })
    expect(out).toMatchObject({ pageLike: false, seo: false, status: false, blocks: { enabled: false } })
    expect(out.blocks).not.toHaveProperty('allowed')
    expect(out).not.toHaveProperty('label')
    expect(out).not.toHaveProperty('icon')
  })

  it('nav: defaults true, and is false for a system collection (hidden from the admin rail)', () => {
    expect(serializeCollection({ name: 'posts', mode: 'multi', translatable: false, fields: {} }).nav).toBe(true)
    expect(serializeCollection({ name: 'media_settings', mode: 'single', translatable: false, nav: false, fields: {} }).nav).toBe(false)
    expect(serializeCollection({ name: 'x', mode: 'multi', translatable: false, nav: true, fields: {} }).nav).toBe(true)
  })

  it('resolves a valid collection fieldLayout to normalized nodes on the wire', () => {
    const out = serializeCollection({
      name: 'demo', mode: 'multi', translatable: false,
      fields: { title: { type: 'text' }, subtitle: { type: 'text' }, body: { type: 'richtext' } },
      fieldLayout: [['title|2', 'subtitle'], { Content: ['body'] }],
    })
    expect(out.fieldLayout).toEqual([
      { kind: 'row', fields: ['title', 'subtitle'], tracks: [2, 1] },
      { kind: 'group', label: 'Content', rows: [{ kind: 'row', fields: ['body'], tracks: [1] }] },
    ])
  })

  it('omits fieldLayout when the collection declares none (like icon/label)', () => {
    expect('fieldLayout' in serializeCollection({ name: 'x', mode: 'multi', translatable: false, fields: { a: { type: 'text' } } })).toBe(false)
  })

  it('throws when a collection fieldLayout references an unknown field', () => {
    expect(() => serializeCollection({ name: 'x', mode: 'multi', translatable: false, fields: { a: { type: 'text' } }, fieldLayout: ['nope'] }))
      .toThrowError(/collection "x".*unknown field "nope"/)
  })

  it('passes an icon through when present', () => {
    expect(serializeCollection({ name: 'settings', mode: 'single', translatable: false, icon: 'settings', fields: {} }).icon).toBe('settings')
    expect(serializeCollection({ name: 'x', mode: 'multi', translatable: false, icon: '<path d="M0 0"/>', fields: {} }).icon).toBe('<path d="M0 0"/>')
  })

  // The editor `type` is the presentation axis (which admin editor body renders), resolved once here so the
  // client just reads it. It is deliberately separate from the `blocks` schema flag but defaults from it.
  it('resolves the editor type: blocks when blocks-enabled, else fields', () => {
    expect(serializeCollection(def).editor).toBe('blocks')
    expect(serializeCollection({ name: 'settings', mode: 'single', translatable: false, fields: {} }).editor).toBe('fields')
    expect(serializeCollection({ name: 'posts', mode: 'multi', translatable: false, fields: {} }).editor).toBe('fields')
  })

  it('lets an explicit def.editor win over the derived default (extension editor types)', () => {
    expect(serializeCollection({ name: 'flows', mode: 'multi', translatable: false, editor: 'node-graph', fields: {} }).editor).toBe('node-graph')
    // Explicit editor overrides even a blocks-enabled default.
    expect(serializeCollection({ ...def, editor: 'node-graph' }).editor).toBe('node-graph')
  })
})

describe('serializeBlock', () => {
  it('serializes name/label/slots and fields (fields identical to collection fields)', () => {
    expect(serializeBlock({
      name: 'hero',
      label: 'Hero',
      slots: ['default'],
      fields: { heading: { type: 'text', required: true }, image: { type: 'media' } },
    })).toEqual({
      name: 'hero',
      label: 'Hero',
      slots: ['default'],
      fields: {
        heading: { type: 'text', required: true, unique: false },
        image: { type: 'media', required: false, unique: false, single: true },
      },
    })
  })

  it('omits label and slots when absent or empty', () => {
    const out = serializeBlock({ name: 'prose', slots: [], fields: { body: { type: 'richtext', required: true } } })
    expect(out).toEqual({ name: 'prose', fields: { body: { type: 'richtext', required: true, unique: false } } })
    expect(out).not.toHaveProperty('label')
    expect(out).not.toHaveProperty('slots')
  })

  it('passes icon and image through when present, and omits them when absent', () => {
    const out = serializeBlock({ name: 'hero', icon: 'image', image: '/block-previews/hero.png', fields: {} })
    expect(out.icon).toBe('image')
    expect(out.image).toBe('/block-previews/hero.png')
    const bare = serializeBlock({ name: 'prose', fields: {} })
    expect(bare).not.toHaveProperty('icon')
    expect(bare).not.toHaveProperty('image')
  })
})
