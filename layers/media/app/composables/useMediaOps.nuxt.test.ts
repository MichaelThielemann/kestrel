import { describe, it, expect, beforeEach } from 'vitest'
import { registerEndpoint, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { readBody } from 'h3'
import { useMediaOps } from './useMediaOps'

let executed = 0
let failPreview = false
registerEndpoint('/api/media/delete', async (event) => {
  const body = await readBody(event)
  if (body?.dryRun) {
    if (failPreview) throw createError({ statusCode: 500, statusMessage: 'boom' })
    return { summary: { files: 1, folders: 0, totalBytes: 2048 }, usages: { 5: [{ collection: 'pages', recordId: 2, field: 'hero' }] } }
  }
  executed++
  return { summary: { files: 1, folders: 0, totalBytes: 2048 } }
})
let changed = 0
const Host = defineComponent({ setup: () => ({ ops: useMediaOps(() => { changed++ }) }), template: '<div/>' })

let renamed = 0
let failRename = false
registerEndpoint('/api/media/rename', async (event) => {
  await readBody(event)
  if (failRename) throw createError({ statusCode: 409, statusMessage: 'A file or folder with this name already exists' })
  renamed++
  return [{ id: 5, newPath: 'pics/new.png' }]
})

describe('useMediaOps', () => {
  beforeEach(() => { executed = 0; changed = 0; failPreview = false; renamed = 0; failRename = false })
  it('previewDelete returns the dry-run report with usages', async () => {
    const w = await mountSuspended(Host)
    const report = await w.vm.ops.previewDelete([{ type: 'file', id: 5 }])
    expect(report.summary).toEqual({ files: 1, folders: 0, totalBytes: 2048 })
    expect(report.usages![5][0]).toEqual({ collection: 'pages', recordId: 2, field: 'hero' })
    expect(executed).toBe(0)
  })
  it('confirmDelete executes and fires onChanged', async () => {
    const w = await mountSuspended(Host)
    await w.vm.ops.confirmDelete([{ type: 'file', id: 5 }]); await flushPromises()
    expect(executed).toBe(1)
    expect(changed).toBe(1)
  })
  it('previewDelete sets error and rethrows on failure', async () => {
    failPreview = true
    const w = await mountSuspended(Host)
    await expect(w.vm.ops.previewDelete([{ type: 'file', id: 5 }])).rejects.toBeDefined()
    expect(w.vm.ops.error.value).toBeTruthy()
  })
  it('rename calls the endpoint and fires onChanged', async () => {
    const w = await mountSuspended(Host)
    await w.vm.ops.rename({ type: 'file', id: 5 }, 'new.png'); await flushPromises()
    expect(renamed).toBe(1)
    expect(changed).toBe(1)
  })
  it('rename surfaces a 409 collision as an error and rethrows', async () => {
    failRename = true
    const w = await mountSuspended(Host)
    await expect(w.vm.ops.rename({ type: 'file', id: 5 }, 'taken.png')).rejects.toBeDefined()
    expect(w.vm.ops.error.value).toContain('already exists')
  })
})
