import { describe, it, expect } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import MediaPathBar from './MediaPathBar.vue'

registerEndpoint('/api/media/library', () => ({
  folder: '', folders: [{ path: 'pics/sub', name: 'sub', size: 0 }, { path: 'pics/shots', name: 'shots', size: 0 }], files: [], total: 0, page: 1, perPage: 200,
}))

describe('MediaPathBar', () => {
  it('renders clickable ancestor segments and emits navigate on click', async () => {
    const w = await mountSuspended(MediaPathBar, { props: { folder: 'pics/sub' } })
    const seg = w.findAll('button').find((b) => b.text() === 'pics')
    expect(seg).toBeTruthy()
    await seg!.trigger('click')
    expect(w.emitted('navigate')?.at(-1)).toEqual(['pics'])
  })
  it('renders the root as "/" (navigating to the media root) and prefills the edit field with the display path', async () => {
    const w = await mountSuspended(MediaPathBar, { props: { folder: 'pics/sub' } })
    const root = w.findAll('button').find((b) => b.text() === '/')
    expect(root).toBeTruthy()
    await root!.trigger('click')
    expect(w.emitted('navigate')?.at(-1)).toEqual([''])
    expect(w.text()).toContain('pics')
    await w.find('[data-test="path-edit"]').trigger('click')
    expect((w.find('input').element as HTMLInputElement).value).toBe('/pics/sub/')
  })
  it('parses a typed display path back to the internal folder on Enter', async () => {
    const w = await mountSuspended(MediaPathBar, { props: { folder: '' } })
    await w.find('[data-test="path-edit"]').trigger('click')
    const input = w.find('input')
    await input.setValue('/test123/')
    await input.trigger('keydown.enter')
    expect(w.emitted('navigate')?.at(-1)).toEqual(['test123'])
  })
  it('navigates to a typed path on Enter', async () => {
    const w = await mountSuspended(MediaPathBar, { props: { folder: '' } })
    await w.find('[data-test="path-edit"]').trigger('click')
    const input = w.find('input')
    await input.setValue('pics/sub')
    await input.trigger('keydown.enter')
    expect(w.emitted('navigate')?.at(-1)).toEqual(['pics/sub'])
  })
  it('suggests child folders matching the trailing fragment', async () => {
    const w = await mountSuspended(MediaPathBar, { props: { folder: '' } })
    await w.find('[data-test="path-edit"]').trigger('click')
    const input = w.find('input')
    await input.setValue('pics/sh')
    await nextTick(); await new Promise((r) => setTimeout(r, 200)); await nextTick()
    expect(w.text()).toContain('shots')
  })
})
