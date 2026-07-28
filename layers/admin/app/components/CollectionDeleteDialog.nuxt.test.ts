import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CollectionDeleteDialog from './CollectionDeleteDialog.vue'
import type { BatchDeleteReport } from '../utils/collection-ops'

const report: BatchDeleteReport = {
  count: 3,
  referencedCount: 2,
  referenced: [{ id: 1, referrers: 2 }, { id: 2, referrers: 1 }],
  checked: true,
}

const deleteBtn = (w: { findAll: (s: string) => { text: () => string; trigger: (e: string) => Promise<void>; attributes: (a: string) => string | undefined }[] }) =>
  w.findAll('button').find((b) => /^delete$/i.test(b.text().trim()))

describe('CollectionDeleteDialog', () => {
  it('shows the delete count + the referrers warning and emits confirm', async () => {
    const w = await mountSuspended(CollectionDeleteDialog, { props: { open: true, report } })
    expect(w.text()).toContain('3') // count in the summary
    expect(w.find('.collection-delete__warn').exists()).toBe(true)
    expect(w.find('.collection-delete__warn').text()).toContain('2') // referencedCount
    await deleteBtn(w)!.trigger('click')
    expect(w.emitted('confirm')).toBeTruthy()
  })

  it('omits the referrers warning when nothing is referenced (and a verified-safe delete shows no caution)', async () => {
    const w = await mountSuspended(CollectionDeleteDialog, { props: { open: true, report: { count: 1, referencedCount: 0, referenced: [], checked: true } } })
    expect(w.find('.collection-delete__warn').exists()).toBe(false)
    expect(w.find('.collection-delete__caution').exists()).toBe(false)
  })

  it('cautions (not implies safety) when the referrer check could not run — checked:false', async () => {
    // A failed lookup arrives as a zero-referenced report flagged checked:false; the dialog must NOT look
    // like a verified-safe delete. It shows the unverified caution and no (false) referrers warning.
    const w = await mountSuspended(CollectionDeleteDialog, { props: { open: true, report: { count: 2, referencedCount: 0, referenced: [], checked: false } } })
    const caution = w.find('.collection-delete__caution')
    expect(caution.exists()).toBe(true)
    expect(caution.text().length).toBeGreaterThan(0)
    expect(w.find('.collection-delete__warn').exists()).toBe(false)
  })

  it('emits update:open=false on cancel', async () => {
    const w = await mountSuspended(CollectionDeleteDialog, { props: { open: true, report } })
    const cancel = w.findAll('button').find((b) => /cancel/i.test(b.text().trim()))
    await cancel!.trigger('click')
    expect(w.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('shows an error and disables the confirm button while busy', async () => {
    const w = await mountSuspended(CollectionDeleteDialog, { props: { open: true, report, busy: true, error: 'Delete failed' } })
    expect(w.text()).toContain('Delete failed')
    expect(deleteBtn(w)!.attributes('disabled')).toBeDefined()
  })
})
