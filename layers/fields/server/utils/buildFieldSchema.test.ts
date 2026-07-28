import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildFieldSchema, buildFieldObjectSchema } from './buildFieldSchema'

describe('buildFieldSchema', () => {
  it('keys the refine record by jsKey and replaces per-field schemas', () => {
    const refine = buildFieldSchema({
      title: { type: 'text', required: true },
      cover: { type: 'media' },
    })
    expect(Object.keys(refine).sort()).toEqual(['coverId', 'title'])
    expect((refine.title as z.ZodType).safeParse(undefined).success).toBe(false)
    expect((refine.coverId as z.ZodType).safeParse(undefined).success).toBe(true)
  })

  it('relaxes a conditional required field to accept an absent value, but still validates a present one', () => {
    const refine = buildFieldSchema({
      format: { type: 'text', required: true },
      caption: { type: 'text', required: true, options: { maxLength: 3 }, condition: { field: 'format', is: 'image' } },
    })
    expect((refine.format as z.ZodType).safeParse(undefined).success).toBe(false)
    expect((refine.caption as z.ZodType).safeParse(undefined).success).toBe(true)
    expect((refine.caption as z.ZodType).safeParse(null).success).toBe(true)
    expect((refine.caption as z.ZodType).safeParse('ok').success).toBe(true)
    expect((refine.caption as z.ZodType).safeParse('toolong').success).toBe(false)
  })
})

describe('buildFieldObjectSchema', () => {
  it('keys by raw field name (block props) and validates as a z.object', () => {
    const shape = buildFieldObjectSchema({ heading: { type: 'text', required: true } })
    const obj = z.object(shape)
    expect(obj.safeParse({ heading: 'Hi' }).success).toBe(true)
    expect(obj.safeParse({}).success).toBe(false)
  })

  it('relaxes a conditional required block prop (the controller stays required)', () => {
    const obj = z.object(buildFieldObjectSchema({
      format: { type: 'text', required: true },
      caption: { type: 'text', required: true, condition: { field: 'format', is: 'image' } },
    }))
    expect(obj.safeParse({ format: 'image' }).success).toBe(true) // caption may be omitted
    expect(obj.safeParse({}).success).toBe(false) // format still required
  })
})
