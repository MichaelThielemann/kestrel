import { describe, it, expect, beforeEach } from 'vitest'
import { registerEndpoint, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { getQuery, readBody } from 'h3'
import { useCollectionOps } from './useCollectionOps'

let lastBulk: { action?: string; ids?: number[] } = {}
let bulkCalls = 0
let failBulk = false
registerEndpoint('/api/things/bulk', async (event) => {
  const body = await readBody(event)
  lastBulk = body
  bulkCalls++
  if (failBulk) throw createError({ statusCode: 400, statusMessage: 'nope' })
  // For duplicate, the created ids differ from the input ids.
  const ids = body.action === 'duplicate' ? body.ids.map((n: number) => n + 100) : body.ids
  return { action: body.action, count: ids.length, ids }
})

let refQuery: Record<string, unknown> = {}
registerEndpoint('/api/references/referrers', (event) => {
  refQuery = getQuery(event)
  return { counts: { '1': 3, '2': 0 } }
})

let publishBodies: Record<string, unknown>[] = []
registerEndpoint('/api/publish', async (event) => {
  publishBodies.push(await readBody(event))
  return { queued: true, generates: true, routes: [], pruned: [], drafts: [] }
})

let changed = 0
const Host = defineComponent({ setup: () => ({ ops: useCollectionOps('things', () => { changed++ }) }), template: '<div/>' })

describe('useCollectionOps', () => {
  beforeEach(() => { lastBulk = {}; bulkCalls = 0; failBulk = false; changed = 0; refQuery = {}; publishBodies = [] })

  it('previewDelete reads the referrer aggregate and folds it into a report (no mutation)', async () => {
    const w = await mountSuspended(Host)
    const report = await w.vm.ops.previewDelete([1, 2])
    expect(refQuery.collection).toBe('things')
    expect(refQuery.ids).toBe('1,2')
    expect(report.count).toBe(2)
    expect(report.referencedCount).toBe(1)
    expect(report.referenced).toEqual([{ id: 1, referrers: 3 }])
    expect(report.checked).toBe(true) // a report from a SUCCESSFUL lookup is marked verified
    expect(bulkCalls).toBe(0)
  })

  it('confirmDelete posts action=delete and fires onChanged', async () => {
    const w = await mountSuspended(Host)
    await w.vm.ops.confirmDelete([1, 2]); await flushPromises()
    expect(lastBulk).toEqual({ action: 'delete', ids: [1, 2] })
    expect(changed).toBe(1)
  })

  it('duplicate posts action=duplicate and returns the CREATED ids', async () => {
    const w = await mountSuspended(Host)
    const res = await w.vm.ops.duplicate([1]); await flushPromises()
    expect(lastBulk).toEqual({ action: 'duplicate', ids: [1] })
    expect(res.ids).toEqual([101])
    expect(changed).toBe(1)
  })

  it('setStatus maps published→publish and draft→unpublish', async () => {
    const w = await mountSuspended(Host)
    await w.vm.ops.setStatus([1], 'published'); await flushPromises()
    expect(lastBulk.action).toBe('publish')
    await w.vm.ops.setStatus([1], 'draft'); await flushPromises()
    expect(lastBulk.action).toBe('unpublish')
  })

  // Since ADR-0008 the status write and the render are two steps: publishing has to ask for the render,
  // while unpublishing must not — the write event prunes the pages on its own, at once.
  it('setStatus publishes the static output after a bulk publish, and not after an unpublish', async () => {
    const w = await mountSuspended(Host)
    await w.vm.ops.setStatus([1, 2], 'published'); await flushPromises()
    expect(publishBodies).toEqual([{ collection: 'things', ids: [1, 2] }])
    await w.vm.ops.setStatus([1], 'draft'); await flushPromises()
    expect(publishBodies).toHaveLength(1)
  })

  it('surfaces the server statusMessage on failure and rethrows', async () => {
    failBulk = true
    const w = await mountSuspended(Host)
    await expect(w.vm.ops.confirmDelete([1])).rejects.toBeDefined()
    expect(w.vm.ops.error.value).toBe('nope')
    expect(changed).toBe(0)
  })
})
