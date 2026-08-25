import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { text } from 'drizzle-orm/sqlite-core'
import { defineFieldType, constrain, opt, optArr } from '../../../src/server/utils/defineFieldType.js'
import type { FieldTypeDescriptor } from '../../../src/server/utils/defineFieldType.js'
import { getFieldType, fieldTypes } from '../../../src/server/field-registry/index.js'
import { buildCollection, defineCollection } from '@kestrel/core'

type ColumnFn = FieldTypeDescriptor['column']
type ValidatorFn = FieldTypeDescriptor['validator']

const registerColor = () =>
  defineFieldType({
    name: 'color',
    column: (n, f) => constrain(text(n), f),
    validator: (f) => opt(z.string().regex(/^#[0-9a-f]{6}$/i), f),
  })

describe('defineFieldType — consumer-defined field types, end to end', () => {
  beforeEach(() => {
    delete fieldTypes.color // keep the singleton registry clean between cases
  })

  it('getFieldType throws a clear error for an unregistered type', () => {
    expect(() => getFieldType('color')).toThrow(/unknown field type "color"/)
  })

  it('registers a server descriptor reachable via getFieldType', () => {
    registerColor()
    expect(getFieldType('color')).toMatchObject({ column: expect.any(Function), validator: expect.any(Function) })
  })

  it('builds a real column + validation when a collection uses the custom type', () => {
    registerColor()
    const built = buildCollection(
      defineCollection({
        name: 'palette',
        mode: 'multi',
        fields: {
          name: { type: 'text', required: true },
          swatch: { type: 'color', required: true } as never, // custom type — not in the builtin union
        },
      }),
    )
    // The custom validator is woven into the collection's insert schema.
    expect(built.insert.safeParse({ name: 'Red', swatch: '#ff0000' }).success).toBe(true)
    expect(built.insert.safeParse({ name: 'Red', swatch: 'not-a-color' }).success).toBe(false)
    // required is honoured (no nullish slip-through).
    expect(built.insert.safeParse({ name: 'Red' }).success).toBe(false)
  })

  it('does not disturb the built-in registry', () => {
    registerColor()
    expect(getFieldType('text')).toBeDefined()
    expect(getFieldType('relation')).toBeDefined()
  })

  it('forwards a consumer-supplied transform (must not be silently dropped)', () => {
    const transform = (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : v)
    const column: ColumnFn = (n, f) => constrain(text(n), f)
    const validator: ValidatorFn = (f) => opt(z.string(), f)
    defineFieldType({ name: 'color', column, validator, transform } as never)
    expect(getFieldType('color').transform).toBe(transform)
  })
})

describe('optArr — a non-required array tolerates an untouched null (no spurious 400)', () => {
  const arr = z.array(z.number())
  it('explicit null → [] (PATCH clear); undefined → undefined so the column default ([]) applies on insert', () => {
    const schema = optArr(arr) // non-required (no field)
    expect(schema.safeParse(null).success).toBe(true)
    expect(schema.safeParse(null).data).toEqual([]) // clears on a PATCH instead of a silent no-op
    expect(schema.safeParse(undefined).success).toBe(true)
    expect(schema.safeParse(undefined).data).toBeUndefined()
    expect(schema.safeParse([1, 2]).data).toEqual([1, 2])
  })
  it('required still rejects an empty array', () => {
    const schema = optArr(arr, { type: 'x', required: true } as never)
    expect(schema.safeParse([]).success).toBe(false)
    expect(schema.safeParse([1]).success).toBe(true)
  })
})
