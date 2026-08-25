import { describe, it, expect, beforeEach } from 'vitest'
import { registerEndpoint, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { getQuery, readBody } from 'h3'
import { useCollectionOps } from './useCollectionOps'

let lastBody: Record<string, unknown> = {}
let lastOp = ''
let bulkCalls = 0
let failBulk = false
function batchHandler(op: string) {
  return async (event: Parameters<typeof readBody>[0]) => {
    const body = await readBody(event)
    lastBody = body
    lastOp = op
    bulkCalls++
    if (failBulk) throw createError({ statusCode: 400, statusMessage: 'nope' })
    // `duplicate` answers with the CREATED rows (different ids); the others answer count + touched ids.
    if (op === 'duplicate') return (body.ids as number[]).map((n) => ({ id: n + 100 }))
    return { count: (body.ids as number[]).length, ids: body.ids }
  }
}
registerEndpoint('/api/things/deleteMany', { method: 'POST', handler: batchHandler('deleteMany') })
registerEndpoint('/api/things/duplicate', { method: 'POST', handler: batchHandler('duplicate') })
registerEndpoint('/api/things/updateMany', { method: 'POST', handler: batchHandler('updateMany') })

let archiveBody: Record<string, unknown> | undefined
const archiveHandler = async (event: Parameters<typeof readBody>[0]) => {
  archiveBody = await readBody(event).catch(() => undefined)
  return { ok: true }
}
registerEndpoint('/api/things/archive', { method: 'POST', handler: archiveHandler })
registerEndpoint('/api/things/archive/1', { method: 'POST', handler: archiveHandler })

let refQuery: Record<string, unknown> = {}
registerEndpoint('/api/things/referrers', (event) => {
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
  beforeEach(() => { lastBody = {}; lastOp = ''; bulkCalls = 0; failBulk = false; changed = 0; refQuery = {}; publishBodies = []; archiveBody = undefined })

  it('runCustomAction posts {ids} to the pipeline\'s own route for a "bulk"/"both" action and fires onChanged', async () => {
    const w = await mountSuspended(Host)
    const res = await w.vm.ops.runCustomAction({ name: 'archive', route: { url: '/api/things/archive', method: 'POST' }, kind: 'bulk' }, [1, 2])
    await flushPromises()
    expect(archiveBody).toEqual({ ids: [1, 2] })
    expect(res).toEqual({ action: 'archive', count: 2, ids: [1, 2] })
    expect(changed).toBe(1)
  })

  it('runCustomAction posts no body to /<id> for a "record" action', async () => {
    const w = await mountSuspended(Host)
    await w.vm.ops.runCustomAction({ name: 'archive', route: { url: '/api/things/archive/1', method: 'POST' }, kind: 'record' }, [1])
    await flushPromises()
    expect(archiveBody).toBeUndefined()
  })

  it('previewDelete reads the referrer aggregate and folds it into a report (no mutation)', async () => {
    const w = await mountSuspended(Host)
    const report = await w.vm.ops.previewDelete([1, 2])
    expect(refQuery.ids).toBe('1,2')
    expect(report.count).toBe(2)
    expect(report.referencedCount).toBe(1)
    expect(report.referenced).toEqual([{ id: 1, referrers: 3 }])
    expect(report.checked).toBe(true) // a report from a SUCCESSFUL lookup is marked verified
    expect(bulkCalls).toBe(0)
  })

  it('confirmDelete posts to deleteMany and fires onChanged', async () => {
    const w = await mountSuspended(Host)
    await w.vm.ops.confirmDelete([1, 2]); await flushPromises()
    expect(lastOp).toBe('deleteMany')
    expect(lastBody).toEqual({ ids: [1, 2] })
    expect(changed).toBe(1)
  })

  it('duplicate posts to duplicate and returns the CREATED ids', async () => {
    const w = await mountSuspended(Host)
    const res = await w.vm.ops.duplicate([1]); await flushPromises()
    expect(lastOp).toBe('duplicate')
    expect(lastBody).toEqual({ ids: [1] })
    expect(res.ids).toEqual([101])
    expect(changed).toBe(1)
  })

  it('setStatus writes updateMany with a status patch (published→publish, draft→unpublish)', async () => {
    const w = await mountSuspended(Host)
    await w.vm.ops.setStatus([1], 'published'); await flushPromises()
    expect(lastOp).toBe('updateMany')
    expect(lastBody).toEqual({ ids: [1], patch: { status: 'published' } })
    await w.vm.ops.setStatus([1], 'draft'); await flushPromises()
    expect(lastOp).toBe('updateMany')
    expect(lastBody).toEqual({ ids: [1], patch: { status: 'draft' } })
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
