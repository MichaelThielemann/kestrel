import { describe, it, expect } from 'vitest'
import {
  KESTREL_FIELD, field,
  textField, slugField, richtextField, numberField, booleanField, datetimeField,
  choiceField, jsonField, linkField, mediaField, relationField, repeaterField,
} from './field-factories'
import type { FieldFactoryResult } from './field-factories'

const def = (r: FieldFactoryResult) => r[KESTREL_FIELD]

describe('field factories — carry the exact declarative FieldDef + a Vue prop constructor', () => {
  it('leaf fields: base props at the top level, extras under options; correct Vue constructor', () => {
    expect(def(textField({ required: true }))).toEqual({ type: 'text', required: true })
    expect(textField().type).toBe(String)
    expect(def(textField({ maxLength: 5 }))).toEqual({ type: 'text', options: { maxLength: 5 } })
    expect(def(slugField())).toEqual({ type: 'slug' })
    expect(def(richtextField({ required: true }))).toEqual({ type: 'richtext', required: true })
    expect(def(numberField({ default: 4000 }))).toEqual({ type: 'number', default: 4000 })
    expect(numberField().type).toBe(Number)
    expect(def(booleanField())).toEqual({ type: 'boolean' })
    expect(booleanField().type).toBe(Boolean)
    expect(def(datetimeField())).toEqual({ type: 'datetime' })
    // choice options carry `{ label, value }[]` (the declarative arm's shape) — the factory passes them through
    expect(def(choiceField({ choices: [{ label: 'A', value: 'a' }] }))).toEqual({ type: 'choice', options: { choices: [{ label: 'A', value: 'a' }] } })
    expect(def(jsonField())).toEqual({ type: 'json' })
    expect(jsonField().type).toBe(Object)
    expect(def(linkField())).toEqual({ type: 'link' })
    expect(linkField().type).toBe(Object)
  })

  it('choiceField/datetimeField: Vue prop constructor matches the runtime value shape', () => {
    // single choice → String; multiple → Array (value is string[])
    expect(choiceField().type).toBe(String)
    expect(choiceField({ multiple: true }).type).toBe(Array)
    expect(def(choiceField({ multiple: true }))).toEqual({ type: 'choice', options: { multiple: true } })
    // single datetime → String; range → Object (value is { start, end })
    expect(datetimeField().type).toBe(String)
    expect(datetimeField({ range: true }).type).toBe(Object)
    expect(def(datetimeField({ range: true }))).toEqual({ type: 'datetime', options: { range: true } })
  })

  it('mediaField: single → options + Number prop; multiple → options.multiple + Array prop', () => {
    expect(def(mediaField({ accept: 'image' }))).toEqual({ type: 'media', options: { accept: 'image' } })
    expect(mediaField().type).toBe(Number)
    expect(def(mediaField())).toEqual({ type: 'media' })
    expect(def(mediaField({ multiple: true }))).toEqual({ type: 'media', options: { multiple: true } })
    expect(mediaField({ multiple: true }).type).toBe(Array)
    // base + option mix
    expect(def(mediaField({ required: true, accept: 'image' }))).toEqual({ type: 'media', required: true, options: { accept: 'image' } })
  })

  it('relationField: collection/many/labelField → relation; many → Array, single → Number', () => {
    expect(def(relationField({ collection: 'speakers', many: true }))).toEqual({ type: 'relation', relation: { collection: 'speakers', many: true } })
    expect(def(relationField({ collection: 'authors' }))).toEqual({ type: 'relation', relation: { collection: 'authors' } })
    expect(def(relationField({ collection: 'authors', labelField: 'name' }))).toEqual({ type: 'relation', relation: { collection: 'authors', labelField: 'name' } })
    expect(relationField({ collection: 'x' }).type).toBe(Number)
    expect(relationField({ collection: 'x', many: true }).type).toBe(Array)
  })

  it('relationField throws when `collection` is missing (instead of silently emitting collection: undefined)', () => {
    expect(() => relationField()).toThrow(/collection/)
    expect(() => relationField({ many: true })).toThrow(/collection/)
  })

  it('field(): the generic escape hatch for a custom (defineFieldType) type', () => {
    expect(def(field('secureGallery'))).toEqual({ type: 'secureGallery' })
    expect(def(field('secureGallery', { required: true, folder: 'x' }))).toEqual({ type: 'secureGallery', required: true, options: { folder: 'x' } })
    expect(field('secureGallery').type).toBe(Object)
  })

  it('repeaterField: unwraps sub-field factory calls into FieldDefs, recursing nested repeaters', () => {
    const r = repeaterField({
      fields: {
        pic: mediaField(),
        caption: richtextField({ required: true }),
        nested: repeaterField({ fields: { cta: linkField() } }),
      },
    })
    expect(def(r)).toEqual({
      type: 'repeater',
      options: {
        fields: {
          pic: { type: 'media' },
          caption: { type: 'richtext', required: true },
          nested: { type: 'repeater', options: { fields: { cta: { type: 'link' } } } },
        },
      },
    })
    expect(r.type).toBe(Array)
  })

  it('repeaterField: forwards a fieldLayout into options (no longer silently dropped)', () => {
    const r = repeaterField({ fields: { a: textField(), b: textField() }, fieldLayout: [['a', 'b']] })
    expect(def(r)).toEqual({
      type: 'repeater',
      options: { fields: { a: { type: 'text' }, b: { type: 'text' } }, fieldLayout: [['a', 'b']] },
    })
    // absent → options carry only `fields`
    expect('fieldLayout' in (def(repeaterField({ fields: { a: textField() } })) as { options: object }).options).toBe(false)
  })

  it("reproduces the hero block's declarative fields byte-for-byte from a defineProps-shaped object", () => {
    const propsDecl = { heading: textField({ required: true }), image: mediaField({ accept: 'image' }), cta: linkField() }
    const fields = Object.fromEntries(Object.entries(propsDecl).map(([k, v]) => [k, def(v)]))
    expect(fields).toEqual({
      heading: { type: 'text', required: true },
      image: { type: 'media', options: { accept: 'image' } },
      cta: { type: 'link' },
    })
  })
})
