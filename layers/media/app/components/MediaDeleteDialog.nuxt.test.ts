import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MediaDeleteDialog from './MediaDeleteDialog.vue'
import type { DeleteReport } from '../utils/ops'

const report: DeleteReport = {
  summary: { files: 1, folders: 0, totalBytes: 2048 },
  usages: { 5: [{ collection: 'pages', recordId: 2, field: 'hero' }] },
}

describe('MediaDeleteDialog', () => {
  it('shows the summary + usage warnings and emits confirm', async () => {
    const w = await mountSuspended(MediaDeleteDialog, { props: { open: true, report, names: { 5: 'hero.png' } } })
    expect(w.text()).toContain('1 file')
    expect(w.text()).toContain('hero.png')
    expect(w.text()).toContain('pages #2 (hero)')
    const del = w.findAll('button').find((b) => /^delete$/i.test(b.text().trim()))
    await del!.trigger('click')
    expect(w.emitted('confirm')).toBeTruthy()
  })
  it('renders no usage block when there are none', async () => {
    const w = await mountSuspended(MediaDeleteDialog, { props: { open: true, report: { summary: { files: 0, folders: 1, totalBytes: 0 }, usages: {} }, names: {} } })
    expect(w.text()).not.toContain('published content')
  })
  it('shows an error and disables the buttons while busy', async () => {
    const w = await mountSuspended(MediaDeleteDialog, { props: { open: true, report, names: { 5: 'hero.png' }, busy: true, error: 'Delete failed' } })
    expect(w.text()).toContain('Delete failed')
    const del = w.findAll('button').find((b) => /^delete$/i.test(b.text().trim()))
    expect(del!.attributes('disabled')).toBeDefined()
  })
})
