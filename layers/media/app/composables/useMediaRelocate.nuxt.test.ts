import { describe, it, expect, beforeEach } from 'vitest'
import { registerEndpoint, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { readBody } from 'h3'
import { useMediaRelocate } from './useMediaRelocate'

let lastBody: Record<string, unknown> | null = null
let conflictMode = false
let failPreview = false
const reportWith = (conflicts: unknown[]) => ({ summary: { files: 1, folders: 0, totalBytes: 10 }, conflicts })
registerEndpoint('/api/media/move', async (event) => {
  const body = await readBody(event); lastBody = body
  if (body?.dryRun) {
    if (failPreview) throw createError({ statusCode: 500, statusMessage: 'boom' })
    return reportWith(conflictMode ? [{ item: { type: 'file', id: 1 }, targetPath: 'dest/a.png', type: 'file-exists' }] : [])
  }
  return [{ item: { type: 'file', id: 1 }, status: 'moved', newPath: 'dest/a.png' }]
})
registerEndpoint('/api/media/copy', async (event) => {
  const body = await readBody(event); lastBody = body
  if (body?.dryRun) return reportWith([])
  return []
})
let changed = 0
const Host = defineComponent({ setup: () => ({ r: useMediaRelocate(() => { changed++ }) }), template: '<div/>' })

describe('useMediaRelocate', () => {
  beforeEach(() => { lastBody = null; conflictMode = false; changed = 0; failPreview = false })
  it('preview returns the dry-run report with conflicts', async () => {
    conflictMode = true
    const w = await mountSuspended(Host)
    const report = await w.vm.r.preview('move', [{ type: 'file', id: 1 }], 'dest')
    expect(report.conflicts).toHaveLength(1)
    expect(lastBody).toMatchObject({ dryRun: true, dest: 'dest' })
  })
  it('execute posts the op type + strategy and fires onChanged', async () => {
    const w = await mountSuspended(Host)
    await w.vm.r.execute('copy', [{ type: 'file', id: 1 }], 'dest', 'overwrite'); await flushPromises()
    expect(lastBody).toMatchObject({ dest: 'dest', onConflict: 'overwrite' })
    expect(lastBody?.dryRun).toBeUndefined()
    expect(changed).toBe(1)
  })
  it('preview sets error and rethrows on failure', async () => {
    failPreview = true
    const w = await mountSuspended(Host)
    await expect(w.vm.r.preview('move', [{ type: 'file', id: 1 }], 'dest')).rejects.toBeDefined()
    expect(w.vm.r.error.value).toBeTruthy()
  })
})
