import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import MediaViewer from './MediaViewer.vue'
import type { LibraryFile } from '../utils/library'

const img: LibraryFile = { id: 5, filename: 'p.png', mime: 'image/png', folder: 'a', size: 2048, width: 800, height: 600, src: '/u/p', srcset: '/u/p-320.webp 320w', alt: 'old', createdAt: '2026-01-01T00:00:00.000Z' }
const pdf: LibraryFile = { id: 6, filename: 'doc.pdf', mime: 'application/pdf', folder: '', size: 1024, src: '/u/doc' }

describe('MediaViewer', () => {
  it('shows general info + a prefilled alt input for an image and emits save with the edited alt', async () => {
    const w = await mountSuspended(MediaViewer, { props: { open: true, file: img } })
    await flushPromises()
    expect(w.text()).toContain('image/png')
    expect(w.text()).toContain('2.0 KB')
    expect(w.text()).toContain('800×600')
    const input = w.find('.media-viewer__details input')
    expect((input.element as HTMLInputElement).value).toBe('old')
    await input.setValue('new alt')
    await w.findAll('button').find((b) => b.text() === 'Save')!.trigger('click')
    expect(w.emitted('save')?.at(-1)).toEqual(['new alt'])
  })
  it('offers no alt editing for a non-image file', async () => {
    const w = await mountSuspended(MediaViewer, { props: { open: true, file: pdf } })
    await flushPromises()
    expect(w.find('.media-viewer__details input').exists()).toBe(false)
    expect(w.text()).toContain('application/pdf')
    expect(w.findAll('button').some((b) => b.text() === 'Close')).toBe(true) // still closable via the footer
  })
})
