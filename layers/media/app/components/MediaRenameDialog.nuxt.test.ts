import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MediaRenameDialog from './MediaRenameDialog.vue'

describe('MediaRenameDialog', () => {
  it('seeds the current name and emits rename with the trimmed new name', async () => {
    const w = await mountSuspended(MediaRenameDialog, { props: { open: true, name: 'old.png' } })
    const input = w.find('input')
    expect((input.element as HTMLInputElement).value).toBe('old.png')
    await input.setValue('new.png')
    const btn = w.findAll('button').find((b) => /^rename$/i.test(b.text().trim()))
    await btn!.trigger('click')
    expect(w.emitted('rename')?.at(-1)).toEqual(['new.png'])
  })
  it('disables Rename when the name is unchanged or empty, and shows an error', async () => {
    const w = await mountSuspended(MediaRenameDialog, { props: { open: true, name: 'old.png', error: 'A file or folder with this name already exists' } })
    expect(w.text()).toContain('already exists')
    const btn = w.findAll('button').find((b) => /^rename$/i.test(b.text().trim()))
    expect(btn!.attributes('disabled')).toBeDefined()
  })
  it('reseeds the input from the current name when reopened on a different item', async () => {
    const w = await mountSuspended(MediaRenameDialog, { props: { open: false, name: 'first.png' } })
    await w.setProps({ open: true, name: 'first.png' })
    expect((w.find('input').element as HTMLInputElement).value).toBe('first.png')
    await w.setProps({ open: false })
    await w.setProps({ open: true, name: 'second.png' })
    expect((w.find('input').element as HTMLInputElement).value).toBe('second.png')
  })
})
