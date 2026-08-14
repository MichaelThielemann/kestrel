import { describe, it, expect } from 'vitest'
import { seoSchema } from './seo'

const parse = (value: unknown) => seoSchema.partial().safeParse(value)

describe('seoSchema', () => {
  it('accepts the article metadata fields alongside the existing ones', () => {
    const r = parse({ title: 'T', description: 'D', noindex: true, image: 3, author: 'Ada', publishedDate: '2026-01-15', keywords: 'a, b' })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ author: 'Ada', publishedDate: '2026-01-15', keywords: 'a, b' })
  })

  it('accepts a record with no article metadata at all — the default shape', () => {
    expect(parse({ title: 'T' }).success).toBe(true)
    expect(parse({}).success).toBe(true)
  })

  it('accepts an ISO datetime as well as a plain ISO date', () => {
    expect(parse({ publishedDate: '2026-01-15T09:30:00Z' }).success).toBe(true)
  })

  it('accepts a cleared date — the editor sends an empty string, not undefined', () => {
    expect(parse({ publishedDate: '' }).success).toBe(true)
  })

  it('rejects a publishedDate that is not a date, rather than publishing a broken datePublished', () => {
    expect(parse({ publishedDate: 'last tuesday' }).success).toBe(false)
    expect(parse({ publishedDate: '15.01.2026' }).success).toBe(false)
  })
})
