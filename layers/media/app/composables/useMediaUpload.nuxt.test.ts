import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerEndpoint, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { setResponseStatus } from 'h3'
import { defineComponent } from 'vue'
import { useMediaUpload, type UploadItem } from './useMediaUpload'

let mode: 'ok' | 'conflict' | 'error' | 'h2error' | 'unauthorized' = 'ok'
let errorStatus = 413
let errorMsg = 'Payload too large'
registerEndpoint('/api/media', (event) => {
  if (mode === 'conflict') throw createError({ statusCode: 409, statusMessage: 'exists', data: { storageKey: 'x', existingId: 5, suggestion: 'a-2.png' } })
  if (mode === 'error') throw createError({ statusCode: errorStatus, statusMessage: errorMsg })
  if (mode === 'unauthorized') throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
  if (mode === 'h2error') {
    // Model an HTTP/2 response: status set, the reason phrase (statusText) blank, the reason carried
    // only in the JSON body — exactly the case where reading err.statusMessage (statusText) loses it.
    setResponseStatus(event, 413, '')
    return { statusCode: 413, statusMessage: 'Payload too large' }
  }
  return { id: 1, filename: 'a.png', folder: '', size: 1, src: '/u/a' }
})
const Host = defineComponent({ setup: () => ({ up: useMediaUpload() }), template: '<div/>' })
const onError = vi.fn<(item: UploadItem) => void>()
const ErrHost = defineComponent({ setup: () => ({ up: useMediaUpload({ onError }) }), template: '<div/>' })
const fakeFile = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })

describe('useMediaUpload', () => {
  beforeEach(() => { mode = 'ok'; onError.mockClear() })

  it('marks a non-conflict failure as error, keeps the server reason, and notifies onError', async () => {
    mode = 'error'; errorStatus = 413; errorMsg = 'Payload too large'
    const w = await mountSuspended(ErrHost)
    await w.vm.up.enqueue([fakeFile('big.png')], 'pics'); await flushPromises()
    const item = w.vm.up.queue.value[0]
    expect(item.status).toBe('error')
    expect(item.message).toBe('Payload too large')
    expect(w.vm.up.counts.value.error).toBe(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toMatchObject({ status: 'error', message: 'Payload too large', filename: 'big.png' })
  })

  it('surfaces the 415 unsupported-type reason too', async () => {
    mode = 'error'; errorStatus = 415; errorMsg = 'Unsupported media type: image/gif'
    const w = await mountSuspended(ErrHost)
    await w.vm.up.enqueue([fakeFile('x.gif')], 'pics'); await flushPromises()
    expect(w.vm.up.queue.value[0].message).toBe('Unsupported media type: image/gif')
    expect(onError.mock.calls[0]![0]).toMatchObject({ message: 'Unsupported media type: image/gif' })
  })

  it('reads the reason from the response body even when statusText is blank (HTTP/2)', async () => {
    mode = 'h2error'
    const w = await mountSuspended(ErrHost)
    await w.vm.up.enqueue([fakeFile('big.png')], 'pics'); await flushPromises()
    const item = w.vm.up.queue.value[0]
    expect(item.status).toBe('error')
    expect(item.message).toBe('Payload too large') // from err.data, not the empty statusText
    expect(onError.mock.calls[0]![0]).toMatchObject({ message: 'Payload too large' })
  })

  it('does not raise a per-item error for a 401 — the re-auth interceptor owns that path', async () => {
    mode = 'unauthorized'
    const w = await mountSuspended(ErrHost)
    await w.vm.up.enqueue([fakeFile('a.png')], 'pics'); await flushPromises()
    expect(w.vm.up.queue.value[0].status).toBe('error') // the upload still failed…
    expect(onError).not.toHaveBeenCalled()              // …but no toast: the redirect is the feedback
  })

  it('reports an error exactly once when a conflict resolution re-upload then fails', async () => {
    mode = 'conflict'
    const w = await mountSuspended(ErrHost)
    await w.vm.up.enqueue([fakeFile('a.png')], 'pics'); await flushPromises()
    expect(w.vm.up.conflicts.value.length).toBe(1)
    mode = 'error'; errorStatus = 413; errorMsg = 'Payload too large'
    await w.vm.up.resolve(w.vm.up.conflicts.value[0].id, 'overwrite'); await flushPromises()
    expect(w.vm.up.queue.value[0].status).toBe('error')
    expect(w.vm.up.counts.value.error).toBe(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })
  it('uploads a queued file to done', async () => {
    const w = await mountSuspended(Host)
    await w.vm.up.enqueue([fakeFile('a.png')], 'pics'); await flushPromises()
    expect(w.vm.up.queue.value[0].status).toBe('done')
    expect(w.vm.up.counts.value.done).toBe(1)
  })
  it('marks a 409 as conflict with the server suggestion', async () => {
    mode = 'conflict'
    const w = await mountSuspended(Host)
    await w.vm.up.enqueue([fakeFile('a.png')], 'pics'); await flushPromises()
    const item = w.vm.up.queue.value[0]
    expect(item.status).toBe('conflict')
    expect(item.suggestion).toBe('a-2.png')
    expect(w.vm.up.conflicts.value.length).toBe(1)
  })
  it('resolve overwrite re-uploads to done; skip marks skipped', async () => {
    mode = 'conflict'
    const w = await mountSuspended(Host)
    await w.vm.up.enqueue([fakeFile('a.png'), fakeFile('b.png')], 'pics'); await flushPromises()
    expect(w.vm.up.conflicts.value.length).toBe(2)
    mode = 'ok'
    await w.vm.up.resolve(w.vm.up.conflicts.value[0].id, 'overwrite'); await flushPromises()
    await w.vm.up.resolve(w.vm.up.conflicts.value[0].id, 'skip'); await flushPromises()
    expect(w.vm.up.counts.value.done).toBe(1)
    expect(w.vm.up.counts.value.skipped).toBe(1)
    expect(w.vm.up.conflicts.value.length).toBe(0)
  })
  it('resolveAll skip marks every conflict skipped', async () => {
    mode = 'conflict'
    const w = await mountSuspended(Host)
    await w.vm.up.enqueue([fakeFile('a.png'), fakeFile('b.png')], 'pics'); await flushPromises()
    expect(w.vm.up.conflicts.value.length).toBe(2)
    await w.vm.up.resolveAll('skip'); await flushPromises()
    expect(w.vm.up.counts.value.skipped).toBe(2)
    expect(w.vm.up.conflicts.value.length).toBe(0)
  })
  it('resolve rename with no explicit name adopts the server suggestion', async () => {
    mode = 'conflict'
    const w = await mountSuspended(Host)
    await w.vm.up.enqueue([fakeFile('a.png')], 'pics'); await flushPromises()
    const id = w.vm.up.conflicts.value[0].id
    mode = 'ok'
    await w.vm.up.resolve(id, 'rename'); await flushPromises()  // no name arg → uses suggestion
    const item = w.vm.up.queue.value.find((i) => i.id === id)!
    expect(item.filename).toBe('a-2.png')   // adopted the suggestion
    expect(item.status).toBe('done')
  })
  it('enqueueUploads places each file in its own folder', async () => {
    mode = 'ok'
    const w = await mountSuspended(Host)
    await w.vm.up.enqueueUploads([
      { file: fakeFile('a.png'), folder: 'photos' },
      { file: fakeFile('b.png'), folder: 'photos/sub' },
    ])
    await flushPromises()
    expect(w.vm.up.queue.value.map((i: { filename: string; folder: string; status: string }) => [i.filename, i.folder, i.status])).toEqual([
      ['a.png', 'photos', 'done'],
      ['b.png', 'photos/sub', 'done'],
    ])
  })
})
