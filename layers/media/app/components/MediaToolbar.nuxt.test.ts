import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MediaToolbar from './MediaToolbar.vue'

describe('MediaToolbar', () => {
  it('renders the search box and emits update:search on input', async () => {
    const w = await mountSuspended(MediaToolbar, { props: { view: 'grid', search: '' } })
    const input = w.find('input[type="search"]')
    expect(input.exists()).toBe(true)
    await input.setValue('cat')
    expect(w.emitted('update:search')?.at(-1)).toEqual(['cat'])
  })

  it('shows the active view and emits update:view when toggled', async () => {
    const w = await mountSuspended(MediaToolbar, { props: { view: 'grid', search: '' } })
    const table = w.findAll('button').find((b) => /table/i.test(b.text()))
    expect(table).toBeTruthy()
    await table!.trigger('click')
    expect(w.emitted('update:view')?.at(-1)).toEqual(['table'])
  })

  it('emits new-folder when the New folder button is clicked', async () => {
    const w = await mountSuspended(MediaToolbar, { props: { view: 'grid', search: '' } })
    const btn = w.findAll('button').find((b) => /new folder/i.test(b.text()))
    await btn!.trigger('click')
    expect(w.emitted('new-folder')).toBeTruthy()
  })

  it('emits upload with the selected files', async () => {
    const w = await mountSuspended(MediaToolbar, { props: { view: 'grid', search: '' } })
    const input = w.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [new File([], 'x.png')], configurable: true })
    await input.trigger('change')
    const ev = w.emitted('upload')?.at(-1) as [File[]]
    expect(ev[0].length).toBe(1)
  })
})
