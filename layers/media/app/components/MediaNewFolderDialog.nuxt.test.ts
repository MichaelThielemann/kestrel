import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MediaNewFolderDialog from './MediaNewFolderDialog.vue'

describe('MediaNewFolderDialog', () => {
  it('emits create with the entered name and closes', async () => {
    const w = await mountSuspended(MediaNewFolderDialog, { props: { open: true } })
    await w.find('input').setValue('holiday')
    const createBtn = w.findAll('button').find((b) => /^create$/i.test(b.text().trim()))
    expect(createBtn).toBeTruthy()
    await createBtn!.trigger('click')
    expect(w.emitted('create')?.at(-1)).toEqual(['holiday'])
    expect(w.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('disables create when the name is empty', async () => {
    const w = await mountSuspended(MediaNewFolderDialog, { props: { open: true } })
    const createBtn = w.findAll('button').find((b) => /^create$/i.test(b.text().trim()))
    expect(createBtn!.attributes('disabled')).toBeDefined()
  })
})
