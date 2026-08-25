import { describe, it, expect } from 'vitest'
import { applyFieldTransforms } from '../../../src/server/utils/crud.js'
import type { BuiltCollection } from '../../../src/index.js'

// A minimal BuiltCollection — applyFieldTransforms only reads c.def.fields. A `slug` field auto-generated
// from `title` exercises the write-time transform wiring (column-key resolution, create-all vs
// update-patched-only).
const c = { def: { fields: {
  title: { type: 'text', required: true },
  slug: { type: 'slug', options: { from: 'title' } },
} } } as unknown as BuiltCollection

describe('applyFieldTransforms (write-time field transforms)', () => {
  it('CREATE (all): generates an OMITTED slug from the source field', () => {
    const v: Record<string, unknown> = { title: 'Hello World' } // slug not present at all
    applyFieldTransforms(c, v, v, true)
    expect(v.slug).toBe('hello-world')
  })

  it('CREATE (all): slugifies an explicit slug value', () => {
    const v: Record<string, unknown> = { title: 'X', slug: 'My Custom Slug' }
    applyFieldTransforms(c, v, v, true)
    expect(v.slug).toBe('my-custom-slug')
  })

  it('UPDATE (patched-only): does NOT touch the slug when it is not in the patch', () => {
    const v: Record<string, unknown> = { title: 'New Title' } // slug not patched → URL must be preserved
    applyFieldTransforms(c, v, { title: 'New Title', slug: 'existing-slug' }, false)
    expect('slug' in v).toBe(false)
  })

  it('UPDATE (patched-only): re-derives a CLEARED slug from the merged record', () => {
    const v: Record<string, unknown> = { slug: '' } // user blanked it
    applyFieldTransforms(c, v, { title: 'Source Title', slug: '' }, false)
    expect(v.slug).toBe('source-title')
  })

  it('is a no-op for collections without any transform field', () => {
    const plain = { def: { fields: { title: { type: 'text' } } } } as unknown as BuiltCollection
    const v: Record<string, unknown> = { title: 'kept as-is' }
    applyFieldTransforms(plain, v, v, true)
    expect(v).toEqual({ title: 'kept as-is' })
  })
})
