import { describe, it, expect, afterEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import MediaViewer from './MediaViewer.vue'
import type { LibraryFile } from '../utils/library'

const img: LibraryFile = { id: 5, filename: 'p.png', mime: 'image/png', folder: 'a', size: 2048, width: 800, height: 600, src: '/u/p', srcset: '/u/p-320.webp 320w', alt: 'old', createdAt: '2026-01-01T00:00:00.000Z' }
const pdf: LibraryFile = { id: 6, filename: 'doc.pdf', mime: 'application/pdf', folder: '', size: 1024, src: '/u/doc' }

/** The disclosure controls are gated on the public runtime flag the kestrel module publishes. */
function withAiDisclosure(enabled: boolean) {
  const rc = useRuntimeConfig()
  const previous = rc.public.aiDisclosureEnabled
  ;(rc.public as Record<string, unknown>).aiDisclosureEnabled = enabled
  return () => { (rc.public as Record<string, unknown>).aiDisclosureEnabled = previous }
}

const restores: (() => void)[] = []
afterEach(() => { restores.splice(0).forEach((r) => r()) })
const enableAiDisclosure = (on: boolean) => { restores.push(withAiDisclosure(on)) }

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
    // alt stays the FIRST positional argument — `extensions/galleries-secure` handles `(alt: string)`
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

describe('MediaViewer — EU AI Act disclosure section', () => {
  it('renders nothing extra while the feature is off (the default)', async () => {
    enableAiDisclosure(false)
    const file = { ...img, aiDisclosure: { sourceType: 'trainedAlgorithmicMedia', note: 'Midjourney v7' } }
    const w = await mountSuspended(MediaViewer, { props: { open: true, file } })
    await flushPromises()
    expect(w.find('.media-viewer__ai').exists()).toBe(false)
    // …and a save carries NO disclosure payload, so an alt-only edit can never clear a recorded one
    await w.find('.media-viewer__details input').setValue('new alt')
    await w.findAll('button').find((b) => b.text() === 'Save')!.trigger('click')
    expect(w.emitted('save')?.at(-1)).toEqual(['new alt'])
  })

  it('renders a source-type select + a note input when the feature is on, prefilled from the file', async () => {
    enableAiDisclosure(true)
    const file = { ...img, aiDisclosure: { sourceType: 'algorithmicallyEnhanced', note: 'upscaled' } }
    const w = await mountSuspended(MediaViewer, { props: { open: true, file } })
    await flushPromises()
    const select = w.find('.media-viewer__ai select')
    expect((select.element as HTMLSelectElement).value).toBe('algorithmicallyEnhanced')
    // the empty leading option is what makes "no disclosure" selectable/clearable
    expect(w.findAll('.media-viewer__ai option').map((o) => (o.element as HTMLOptionElement).value))
      .toEqual(['', 'trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia', 'algorithmicallyEnhanced'])
    const note = w.findAll('.media-viewer__ai input').at(-1)!
    expect((note.element as HTMLInputElement).value).toBe('upscaled')
  })

  it('emits alt AND the disclosure together, mapping the empty option back to null', async () => {
    enableAiDisclosure(true)
    const file = { ...img, aiDisclosure: { sourceType: 'trainedAlgorithmicMedia', note: 'Midjourney v7' } }
    const w = await mountSuspended(MediaViewer, { props: { open: true, file } })
    await flushPromises()
    await w.find('.media-viewer__ai select').setValue('')
    await w.findAll('button').find((b) => b.text() === 'Save')!.trigger('click')
    expect(w.emitted('save')?.at(-1)).toEqual(['old', { aiSourceType: null, aiNote: 'Midjourney v7' }])
  })

  it('treats a disclosure edit alone as dirty (Save is not gated on the alt text changing)', async () => {
    enableAiDisclosure(true)
    const w = await mountSuspended(MediaViewer, { props: { open: true, file: img } })
    await flushPromises()
    const saveButton = () => w.findAll('button').find((b) => b.text() === 'Save')!
    expect((saveButton().element as HTMLButtonElement).disabled).toBe(true)
    await w.find('.media-viewer__ai select').setValue('trainedAlgorithmicMedia')
    expect((saveButton().element as HTMLButtonElement).disabled).toBe(false)
  })

  it('never shows the section for a non-image file, flag or not', async () => {
    enableAiDisclosure(true)
    const w = await mountSuspended(MediaViewer, { props: { open: true, file: pdf } })
    await flushPromises()
    expect(w.find('.media-viewer__ai').exists()).toBe(false)
  })
})
