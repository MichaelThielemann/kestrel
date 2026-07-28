import { describe, it, expect } from 'vitest'
import { registerEndpoint, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import MediaPicker from './MediaPicker.vue'

registerEndpoint('/api/media/library', () => ({ folder: '', folders: [], files: [{ id: 7, filename: 'a.png', mime: 'image/png', folder: '', size: 1, src: '/u/a' }], total: 1, page: 1, perPage: 60 }))

describe('MediaPicker', () => {
  it('renders the library when open and relays confirm', async () => {
    const w = await mountSuspended(MediaPicker, { props: { open: true, multiple: true } })
    await flushPromises()
    await w.find('[data-file-id="7"]').trigger('click')
    const use = w.findAll('button').find((b) => /use selected/i.test(b.text()))
    await use!.trigger('click')
    expect((w.emitted('confirm')?.at(-1) as number[][])[0]).toEqual([7])
    expect(w.emitted('update:open')?.at(-1)).toEqual([false])
  })
})
