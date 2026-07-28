import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MediaConflictDialog from './MediaConflictDialog.vue'
import type { Conflict } from '../utils/ops'

const conflicts: Conflict[] = [{ item: { type: 'file', id: 1 }, targetPath: 'dest/a.png', type: 'file-exists' }]

describe('MediaConflictDialog', () => {
  it('lists conflicts and emits resolve with the chosen strategy', async () => {
    const w = await mountSuspended(MediaConflictDialog, { props: { open: true, conflicts, type: 'copy', dest: 'dest' } })
    expect(w.text()).toContain('dest/a.png')
    expect(w.text()).toContain('file already exists')
    const replace = w.findAll('button').find((b) => /^replace$/i.test(b.text().trim()))
    await replace!.trigger('click')
    expect(w.emitted('resolve')?.at(-1)).toEqual(['overwrite'])
    const keepBoth = w.findAll('button').find((b) => /keep both/i.test(b.text()))
    await keepBoth!.trigger('click')
    expect(w.emitted('resolve')?.at(-1)).toEqual(['rename'])
  })
})
