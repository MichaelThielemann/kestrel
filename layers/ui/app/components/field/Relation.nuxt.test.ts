import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { getQuery } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import FieldRelation from './Relation.vue'

// Mirrors the real /api/[collection]/options shape: { data: [{ id, label }] }.
registerEndpoint('/api/posts/options', (event) => {
  const q = getQuery(event)
  if (q.ids) return { data: [{ id: 1, label: 'First Post' }], total: 1 }
  if (q.search) return { data: [{ id: 2, label: 'Second Post' }], total: 1 }
  return { data: [], total: 0 }
})

const base = { name: 'Posts', locale: 'en' }
const relation = { type: 'relation' as const, relation: { collection: 'posts', many: true } }

describe('FieldRelation (nuxt env)', () => {
  it('resolves the current ids to chip labels via /options?ids', async () => {
    const w = await mountSuspended(FieldRelation, { props: { ...base, field: relation, modelValue: [1] } })
    await flushPromises()
    expect(w.text()).toContain('First Post')
  })

  it('debounce-searches and lists matching options via /options?search', async () => {
    const w = await mountSuspended(FieldRelation, { props: { ...base, field: relation, modelValue: [] } })
    await w.get('input').trigger('focus')
    await w.get('input').setValue('sec')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    expect(w.html()).toContain('Second Post')
  })
})
