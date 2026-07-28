import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MediaUploadDialog from './MediaUploadDialog.vue'
import type { UploadItem } from '../composables/useMediaUpload'

const conflicts: UploadItem[] = [
  { id: 'u1', file: new File([], 'a.png'), filename: 'a.png', folder: 'pics', status: 'conflict', suggestion: 'a-2.png' },
]

describe('MediaUploadDialog', () => {
  it('lists each conflict by filename', async () => {
    const w = await mountSuspended(MediaUploadDialog, { props: { conflicts, open: true } })
    expect(w.text()).toContain('a.png')
  })
  it('emits resolve(id, overwrite) when a row Overwrite is clicked', async () => {
    const w = await mountSuspended(MediaUploadDialog, { props: { conflicts, open: true } })
    const btn = w.findAll('button').find((b) => /^overwrite$/i.test(b.text().trim()))
    await btn!.trigger('click')
    expect(w.emitted('resolve')?.at(-1)).toEqual(['u1', 'overwrite', undefined])
  })
  it('emits resolve(id, rename, suggestion) when a row Rename is clicked', async () => {
    const w = await mountSuspended(MediaUploadDialog, { props: { conflicts, open: true } })
    const btn = w.findAll('button').find((b) => /^rename$/i.test(b.text().trim()))
    await btn!.trigger('click')
    expect(w.emitted('resolve')?.at(-1)).toEqual(['u1', 'rename', 'a-2.png'])
  })
  it('emits resolve-all on a set-all control', async () => {
    const w = await mountSuspended(MediaUploadDialog, { props: { conflicts, open: true } })
    const btn = w.findAll('button').find((b) => /skip all/i.test(b.text()))
    await btn!.trigger('click')
    expect(w.emitted('resolve-all')?.at(-1)).toEqual(['skip'])
  })
})
