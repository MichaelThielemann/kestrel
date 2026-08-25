import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { text } from 'drizzle-orm/sqlite-core'
import { fieldTypes, registerFieldType, getFieldType } from '../../../src/server/field-registry/index.js'
import type { FieldType } from '@kestrel/core'

const ALL: FieldType[] = [
  'text', 'slug', 'richtext', 'number', 'boolean', 'datetime', 'choice', 'link',
  'media', 'relation', 'repeater', 'json',
]

describe('fieldTypes registry', () => {
  it('has exactly the 12 field types', () => {
    expect(Object.keys(fieldTypes).sort()).toEqual([...ALL].sort())
  })

  it('getFieldType throws the clear error for prototype-chain names (constructor/toString), not a cryptic TypeError', () => {
    expect(() => getFieldType('constructor')).toThrowError(/unknown field type "constructor"/)
    expect(() => getFieldType('toString')).toThrowError(/unknown field type "toString"/)
    expect(() => getFieldType('hasOwnProperty')).toThrowError(/unknown field type/)
  })

  it('text validator trims but stores the value verbatim (no entity-encoding / tag-parsing corruption)', () => {
    const v = fieldTypes.text.validator({ type: 'text', required: true })
    expect(v.parse('  hello ')).toBe('hello')
    expect(v.parse('Tom & Jerry')).toBe('Tom & Jerry')
    expect(v.parse('a < b')).toBe('a < b')
    expect(v.parse('x <foo y')).toBe('x <foo y')
  })
  it('text validator enforces minLength / maxLength on the trimmed value', () => {
    const v = fieldTypes.text.validator({ type: 'text', required: true, options: { minLength: 3, maxLength: 5 } })
    expect(v.safeParse('ab').success).toBe(false)
    expect(v.safeParse('  ab  ').success).toBe(false) // trimmed to 2 chars
    expect(v.safeParse('abc').success).toBe(true)
    expect(v.safeParse('abcdef').success).toBe(false)
  })
  it('text validator is nullish when not required', () => {
    expect(fieldTypes.text.validator({ type: 'text' }).safeParse(undefined).success).toBe(true)
    expect(fieldTypes.text.validator({ type: 'text', required: true }).safeParse(undefined).success).toBe(false)
  })
  it('array/json validators map an explicit null to the empty value (a PATCH clear), undefined stays absent', () => {
    // non-required array-backed field: null → [] (clears on PATCH); undefined → undefined (insert default)
    const repeater = fieldTypes.repeater.validator({ type: 'repeater', options: { fields: { a: { type: 'text' } } } })
    expect(repeater.parse(null)).toEqual([])
    expect(repeater.parse(undefined)).toBeUndefined()
    const multiChoice = fieldTypes.choice.validator({ type: 'choice', options: { multiple: true, choices: [{ label: 'A', value: 'a' }] } })
    expect(multiChoice.parse(null)).toEqual([])
    // json field: null → {}; undefined stays absent
    const json = fieldTypes.json.validator({ type: 'json' })
    expect(json.parse(null)).toEqual({})
    expect(json.parse(undefined)).toBeUndefined()
  })
  it('richtext validator sanitizes', () => {
    expect(fieldTypes.richtext.validator({ type: 'richtext', required: true }).parse('<script>x</script><p>ok</p>')).toBe('<p>ok</p>')
  })
  it('required text/richtext reject empty / whitespace-only (consistent with the client + conditional-required)', () => {
    const reqText = fieldTypes.text.validator({ type: 'text', required: true })
    expect(reqText.safeParse('').success).toBe(false)
    expect(reqText.safeParse('   ').success).toBe(false) // trims to ''
    expect(reqText.safeParse('ok').success).toBe(true)
    expect(fieldTypes.text.validator({ type: 'text' }).safeParse('').success).toBe(true) // optional still accepts ''
    const reqRich = fieldTypes.richtext.validator({ type: 'richtext', required: true })
    expect(reqRich.safeParse('').success).toBe(false)
    expect(reqRich.safeParse('<script>x</script>').success).toBe(false) // sanitizes to '' → still required
    expect(reqRich.parse('<p>ok</p>')).toBe('<p>ok</p>')
  })
  it('number validator honours min/max/integer', () => {
    const v = fieldTypes.number.validator({ type: 'number', required: true, options: { min: 1, max: 5 } })
    expect(v.safeParse(0).success).toBe(false)
    expect(v.safeParse(3).success).toBe(true)
    expect(v.safeParse(2.5).success).toBe(false) // integer by default
  })
  it('number validator allows decimals when options.decimals is set', () => {
    const v = fieldTypes.number.validator({ type: 'number', required: true, options: { decimals: 2 } })
    expect(v.safeParse(19.99).success).toBe(true)
    expect(v.safeParse(2.5).success).toBe(true)
  })
  it('number validator ignores a display-only unit (value stays a bare number)', () => {
    const v = fieldTypes.number.validator({ type: 'number', required: true, options: { decimals: 1, unit: 'rem' } })
    expect(v.parse(4)).toBe(4)
    expect(v.safeParse(2.5).success).toBe(true)
    expect(v.safeParse('4rem').success).toBe(false) // unit is editor chrome only; the stored value is numeric
  })
  it('choice validator is an enum of the choice values', () => {
    const v = fieldTypes.choice.validator({ type: 'choice', required: true, options: { choices: [{ label: 'A', value: 'a' }] } })
    expect(v.safeParse('a').success).toBe(true)
    expect(v.safeParse('b').success).toBe(false)
  })
  it('datetime validator accepts ISO strings per precision', () => {
    const date = fieldTypes.datetime.validator({ type: 'datetime', required: true, options: { precision: 'date' } })
    expect(date.safeParse('2024-01-15').success).toBe(true)
    expect(date.safeParse('15-01-2024').success).toBe(false)
    expect(fieldTypes.datetime.validator({ type: 'datetime', required: true, options: { precision: 'time' } }).safeParse('10:30').success).toBe(true)
    expect(fieldTypes.datetime.validator({ type: 'datetime', required: true }).safeParse('2024-01-15T10:30:00').success).toBe(true)
  })
  it('datetime range validator enforces start <= end', () => {
    const v = fieldTypes.datetime.validator({ type: 'datetime', required: true, options: { precision: 'date', range: true } })
    expect(v.safeParse({ start: '2024-01-01', end: '2024-01-31' }).success).toBe(true)
    expect(v.safeParse({ start: '2024-02-01', end: '2024-01-01' }).success).toBe(false)
  })
  it('link validator accepts each member of the discriminated union', () => {
    const v = fieldTypes.link.validator({ type: 'link', required: true })
    expect(v.safeParse({ type: 'internal', collection: 'pages', id: 3 }).success).toBe(true)
    expect(v.safeParse({ type: 'external', url: 'https://example.com/a' }).success).toBe(true)
    expect(v.safeParse({ type: 'email', email: 'a@b.com' }).success).toBe(true)
    expect(v.safeParse({ type: 'tel', tel: '+49 (30) 123-45' }).success).toBe(true)
  })
  it('link validator accepts an optional hash on internal links, stripping a leading # and rejecting unsafe fragments', () => {
    const v = fieldTypes.link.validator({ type: 'link', required: true })
    expect(v.parse({ type: 'internal', collection: 'pages', id: 3, hash: 'about' }))
      .toEqual({ type: 'internal', collection: 'pages', id: 3, hash: 'about' })
    // a pasted leading '#' is normalized away (stored as the bare fragment)
    expect(v.parse({ type: 'internal', collection: 'pages', id: 3, hash: '#csc23' }))
      .toEqual({ type: 'internal', collection: 'pages', id: 3, hash: 'csc23' })
    // an unsafe fragment (space / markup chars) is rejected — it would corrupt a static <a href>
    expect(v.safeParse({ type: 'internal', collection: 'pages', id: 3, hash: 'a b' }).success).toBe(false)
    expect(v.safeParse({ type: 'internal', collection: 'pages', id: 3, hash: 'x"><script>' }).success).toBe(false)
  })
  it('link validator carries the optional label and trims pasted url/email whitespace', () => {
    const v = fieldTypes.link.validator({ type: 'link', required: true })
    expect(v.parse({ type: 'external', url: '  https://example.com  ', label: '  Home ' }))
      .toEqual({ type: 'external', url: 'https://example.com', label: 'Home' })
    expect(v.parse({ type: 'email', email: ' a@b.com ' })).toEqual({ type: 'email', email: 'a@b.com' })
  })
  it('link validator rejects dangerous url schemes, embedded credentials and control chars', () => {
    const v = fieldTypes.link.validator({ type: 'link', required: true })
    expect(v.safeParse({ type: 'external', url: 'javascript:alert(1)' }).success).toBe(false)
    expect(v.safeParse({ type: 'external', url: 'data:text/html,<script>1</script>' }).success).toBe(false)
    expect(v.safeParse({ type: 'external', url: 'ftp://example.com' }).success).toBe(false)
    // never legitimate in a link, and both would leak into / corrupt the generated static <a href>
    expect(v.safeParse({ type: 'external', url: 'https://user:pass@example.com' }).success).toBe(false)
    expect(v.safeParse({ type: 'external', url: 'https://example.com/\u0000path' }).success).toBe(false)
  })
  it('link validator rejects malformed email/tel and internal without collection/int id', () => {
    const v = fieldTypes.link.validator({ type: 'link', required: true })
    expect(v.safeParse({ type: 'email', email: 'not-an-email' }).success).toBe(false)
    expect(v.safeParse({ type: 'tel', tel: 'call me' }).success).toBe(false)
    expect(v.safeParse({ type: 'tel', tel: '' }).success).toBe(false)
    expect(v.safeParse({ type: 'tel', tel: '+++' }).success).toBe(false) // punctuation only, no digit
    expect(v.safeParse({ type: 'internal', collection: '', id: 1 }).success).toBe(false)
    expect(v.safeParse({ type: 'internal', collection: 'pages' }).success).toBe(false) // missing id
    expect(v.safeParse({ type: 'internal', collection: 'pages', id: 1.5 }).success).toBe(false)
  })
  it('link validator rejects an unknown discriminator and bare strings', () => {
    const v = fieldTypes.link.validator({ type: 'link', required: true })
    expect(v.safeParse({ type: 'whatever', url: 'https://x.com' }).success).toBe(false)
    expect(v.safeParse('https://x.com').success).toBe(false)
  })
  it('link validator is nullish when optional, rejects null/undefined when required', () => {
    expect(fieldTypes.link.validator({ type: 'link' }).safeParse(undefined).success).toBe(true)
    expect(fieldTypes.link.validator({ type: 'link' }).safeParse(null).success).toBe(true)
    expect(fieldTypes.link.validator({ type: 'link', required: true }).safeParse(undefined).success).toBe(false)
    expect(fieldTypes.link.validator({ type: 'link', required: true }).safeParse(null).success).toBe(false)
  })
  it('media (single) validator accepts a number id and honours required', () => {
    expect(fieldTypes.media.validator({ type: 'media' }).safeParse(5).success).toBe(true)
    expect(fieldTypes.media.validator({ type: 'media' }).safeParse(undefined).success).toBe(true)
    expect(fieldTypes.media.validator({ type: 'media', required: true }).safeParse(undefined).success).toBe(false)
  })
  it('media (multiple) validator accepts a number[] and is optional', () => {
    const v = fieldTypes.media.validator({ type: 'media', options: { multiple: true } })
    expect(v.safeParse([1, 2]).success).toBe(true)
    expect(v.safeParse(undefined).success).toBe(true)
  })
  it('repeater validator validates nested fields', () => {
    const v = fieldTypes.repeater.validator({ type: 'repeater', options: { fields: { label: { type: 'text', required: true } } } })
    expect(v.safeParse([{ label: 'x' }]).success).toBe(true)
    expect(v.safeParse([{}]).success).toBe(false)
  })
  it('required array fields reject undefined and the empty array (multi choice, images, many relation)', () => {
    const choice = fieldTypes.choice.validator({ type: 'choice', required: true, options: { multiple: true, choices: [{ label: 'A', value: 'a' }] } })
    expect(choice.safeParse(undefined).success).toBe(false)
    expect(choice.safeParse([]).success).toBe(false)
    expect(choice.safeParse(['a']).success).toBe(true)

    const images = fieldTypes.media.validator({ type: 'media', required: true, options: { multiple: true } })
    expect(images.safeParse(undefined).success).toBe(false)
    expect(images.safeParse([]).success).toBe(false)
    expect(images.safeParse([1]).success).toBe(true)

    const rel = fieldTypes.relation.validator({ type: 'relation', required: true, relation: { collection: 'posts', many: true } })
    expect(rel.safeParse([]).success).toBe(false)
    expect(rel.safeParse([1]).success).toBe(true)
  })
  it('optional array fields still accept undefined and the empty array', () => {
    const v = fieldTypes.media.validator({ type: 'media', options: { multiple: true } })
    expect(v.safeParse(undefined).success).toBe(true)
    expect(v.safeParse([]).success).toBe(true)
  })
  it('optional json: explicit null clears to {} (PATCH reset); undefined stays absent (insert default) — both NOT NULL-safe', () => {
    const v = fieldTypes.json.validator({ type: 'json' } as never)
    expect(v.safeParse(null).success).toBe(true)
    expect(v.safeParse(null).data).toEqual({}) // null → {} : clears on a PATCH, and still satisfies NOT NULL on insert
    expect(v.safeParse(undefined).success).toBe(true)
    expect(v.safeParse(undefined).data).toBeUndefined() // absent → column default '{}' applies
    expect(v.safeParse({ a: 1 }).data).toEqual({ a: 1 })
    expect(v.safeParse([1, 2]).data).toEqual([1, 2])
  })
  it('json validator is optionality-aware: required rejects null/undefined (a 400, not a NOT NULL 500)', () => {
    const v = fieldTypes.json.validator({ type: 'json', required: true } as never)
    expect(v.safeParse(null).success).toBe(false)
    expect(v.safeParse(undefined).success).toBe(false)
    expect(v.safeParse({}).success).toBe(true)
    expect(v.safeParse({ a: 1 }).success).toBe(true)
    expect(v.safeParse(0).success).toBe(true) // a falsy-but-present value is valid
  })
})

describe('registerFieldType — validates the descriptor + warns on any re-registration', () => {
  afterEach(() => { delete fieldTypes.zzz })

  it('throws on a blank name or a missing column/validator function', () => {
    const ok = { column: (n: string) => text(n), validator: () => z.unknown() } as never
    expect(() => registerFieldType('', ok)).toThrow()
    expect(() => registerFieldType('zzz', { validator: () => z.unknown() } as never)).toThrow(/column/)
    expect(() => registerFieldType('zzz', { column: (n: string) => text(n) } as never)).toThrow(/validator/)
  })

  it('warns (not silently clobbers) when a custom name is re-registered', () => {
    const desc = { column: (n: string) => text(n), validator: () => z.unknown() } as never
    registerFieldType('zzz', desc)
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerFieldType('zzz', desc)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('re-registered'))
    spy.mockRestore()
  })

  it('still warns when overriding a built-in', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerFieldType('text', fieldTypes.text)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('built-in'))
    spy.mockRestore()
  })
})
