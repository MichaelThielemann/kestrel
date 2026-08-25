import { describe, it, expect } from 'vitest'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { useEditForm } from './useEditForm'

// Regression: a stale-reference warning must clear the moment the offending field is edited (a media/
// relation swap in the block editor, or a root page field), not only after a full page reload — the
// `deadRefs` map is otherwise fetched once on load and never re-derived.

const pagesSchema = {
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, seo: false, status: false,
  blocks: { enabled: true, allowed: ['hero'] }, editor: 'blocks', nav: true,
  fields: { title: { type: 'text', required: true, unique: false } },
}

registerEndpoint('/api/collections', () => ({ data: [pagesSchema] }))
registerEndpoint('/api/pages/readOne/1', () => ({
  id: 1, title: 'Hello', path: '/', layout: null, updatedAt: '2026-01-01T00:00:00.000Z',
  content: [{ id: 'b1', type: 'hero', props: { image: 5 } }],
}))
registerEndpoint('/api/pages/deadRefs/1', () => ([
  { field: 'image', blockId: 'b1', collection: 'media', id: 5, reason: 'missing' },
  { field: 'title', collection: 'pages', id: 1, reason: 'missing' },
]))

describe('useEditForm — dead-ref reconciliation', () => {
  it('clears a block dead ref once its field is edited (the reference is swapped out)', async () => {
    const form = useEditForm({ collection: 'pages', id: '1' })
    await form.ready
    expect(form.deadRefs.value).toHaveLength(2)

    const next = [{ id: 'b1', type: 'hero', props: { image: 9 } }]
    form.setField('content', next)

    expect(form.deadRefs.value).toEqual([{ field: 'title', collection: 'pages', id: 1, reason: 'missing' }])
  })

  it('leaves a block dead ref through an unrelated content change (a reorder)', async () => {
    const form = useEditForm({ collection: 'pages', id: '1' })
    await form.ready

    // A no-op "reorder" of a single-block tree: same block, same props, same reference.
    const same = [{ id: 'b1', type: 'hero', props: { image: 5 } }]
    form.setField('content', same)

    expect(form.deadRefs.value.some((r) => r.blockId === 'b1')).toBe(true)
  })

  it('clears a root-level dead ref once its own field is edited', async () => {
    const form = useEditForm({ collection: 'pages', id: '1' })
    await form.ready

    form.setField('title', 'Renamed')

    expect(form.deadRefs.value.some((r) => r.field === 'title' && !r.blockId)).toBe(false)
    expect(form.deadRefs.value.some((r) => r.blockId === 'b1')).toBe(true)
  })
})
