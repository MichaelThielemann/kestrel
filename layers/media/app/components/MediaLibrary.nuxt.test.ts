import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { setResponseStatus, getQuery, getRequestHeader, readBody } from 'h3'
import { nextTick } from 'vue'
import MediaLibrary from './MediaLibrary.vue'
import { useMediaClipboard } from '../composables/useMediaClipboard'
import { useToast } from '../../../ui/app/composables/useToast'

let shouldFail = false
let lastLibraryFolder = ''
registerEndpoint('/api/media/library', (event) => {
  lastLibraryFolder = String(getQuery(event).folder ?? '')
  if (shouldFail) throw createError({ statusCode: 500, statusMessage: 'boom' })
  return {
    folder: '', folders: [{ path: 'pics', name: 'pics', size: 0 }],
    files: [
      { id: 1, filename: 'a.png', mime: 'image/png', folder: '', size: 1, src: '/u/a', srcset: '/u/a-320.webp 320w', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, filename: 'b.png', mime: 'image/png', folder: '', size: 1, src: '/u/b' },
    ],
    total: 2, page: 1, perPage: 60,
  }
})

let folderPosts = 0
registerEndpoint('/api/media/folders', () => { folderPosts++; return { path: 'created' } })
let mediaPosts = 0
let mediaFail = false
let mediaFailBlank = false
registerEndpoint('/api/media', (event) => {
  mediaPosts++
  // A failure with a blank reason phrase (HTTP/2) and no body message — exercises the localized fallback.
  if (mediaFailBlank) { setResponseStatus(event, 500, ''); return { ok: false } }
  if (mediaFail) throw createError({ statusCode: 413, statusMessage: 'Payload too large' })
  return { id: 99, filename: 'n.png', folder: '', size: 1, src: '/u/n' }
})

let lastPatchHeader: string | undefined
let lastPatchBody: Record<string, unknown> | undefined
registerEndpoint('/api/media/1', {
  method: 'PATCH',
  handler: async (event) => {
    lastPatchHeader = getRequestHeader(event, 'x-kestrel-if-unmodified-since')
    lastPatchBody = await readBody(event)
    return { id: 1 }
  },
})

describe('MediaLibrary', () => {
  it('renders the listing (folder + file) after mount', async () => {
    const w = await mountSuspended(MediaLibrary)
    await flushPromises(); await nextTick()
    expect(w.text()).toContain('pics')
    expect(w.find('img').exists()).toBe(true)
  })
  it('switches to the table view when toggled', async () => {
    const w = await mountSuspended(MediaLibrary)
    await flushPromises(); await nextTick()
    const tableBtn = w.findAll('button').find((b) => /table/i.test(b.text()))
    expect(tableBtn).toBeTruthy()
    await tableBtn!.trigger('click')
    await nextTick()
    expect(w.find('table').exists()).toBe(true)
  })
  it('shows an error alert when the library fails to load', async () => {
    shouldFail = true
    const w = await mountSuspended(MediaLibrary)
    await flushPromises(); await nextTick()
    expect(w.find('.ui-alert--error').exists()).toBe(true)
    expect(w.find('table').exists()).toBe(false)
    expect(w.find('img').exists()).toBe(false)
    shouldFail = false
  })

  it('opens the new-folder dialog from the toolbar', async () => {
    const w = await mountSuspended(MediaLibrary)
    await flushPromises(); await nextTick()
    expect(w.text()).not.toContain('New folder name')
    await w.findAll('button').find((b) => /new folder/i.test(b.text()))!.trigger('click')
    await nextTick()
    const nameInput = w.findAll('input').find((i) => i.attributes('placeholder')?.includes('holiday'))
    expect(nameInput).toBeTruthy()
  })

  it('creates a folder via the new-folder dialog and refreshes', async () => {
    const before = folderPosts
    const w = await mountSuspended(MediaLibrary)
    await flushPromises(); await nextTick()
    await w.findAll('button').find((b) => /new folder/i.test(b.text()))!.trigger('click')
    await nextTick()
    const nameInput = w.findAll('input').find((i) => i.attributes('placeholder')?.includes('holiday'))
    await nameInput!.setValue('newdir')
    await w.findAll('button').find((b) => /^create$/i.test(b.text().trim()))!.trigger('click')
    await flushPromises(); await nextTick()
    expect(folderPosts).toBe(before + 1)
    // Dialog closed → its name input is gone.
    expect(w.findAll('input').find((i) => i.attributes('placeholder')?.includes('holiday'))).toBeUndefined()
  })

  it('uploads selected files via the toolbar (POST /api/media)', async () => {
    const before = mediaPosts
    const w = await mountSuspended(MediaLibrary)
    await flushPromises(); await nextTick()
    const fileInput = w.find('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { value: [new File([], 'x.png')], configurable: true })
    await fileInput.trigger('change')
    await flushPromises(); await nextTick()
    expect(mediaPosts).toBe(before + 1)
  })

  it('surfaces an upload failure reason as an error toast (not just a count)', async () => {
    const toast = useToast()
    toast.items.splice(0, toast.items.length)
    mediaFail = true
    const w = await mountSuspended(MediaLibrary)
    await flushPromises(); await nextTick()
    const fileInput = w.find('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { value: [new File([], 'big.png')], configurable: true })
    await fileInput.trigger('change')
    await flushPromises(); await nextTick()
    expect(toast.items.some((t) => t.type === 'error' && /Payload too large/.test(t.message) && /big\.png/.test(t.message))).toBe(true)
    mediaFail = false
  })

  it('falls back to a localized reason when a failure carries no message (no dangling colon)', async () => {
    const toast = useToast()
    toast.items.splice(0, toast.items.length)
    mediaFailBlank = true
    const w = await mountSuspended(MediaLibrary)
    await flushPromises(); await nextTick()
    const fileInput = w.find('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { value: [new File([], 'x.png')], configurable: true })
    await fileInput.trigger('change')
    await flushPromises(); await nextTick()
    const errs = toast.items.filter((t) => t.type === 'error')
    expect(errs.some((t) => /Upload failed/.test(t.message) && /x\.png/.test(t.message))).toBe(true)
    expect(errs.some((t) => /x\.png:\s*$/.test(t.message))).toBe(false)
    mediaFailBlank = false
  })

  it('shows the drop overlay while an OS-file drag is over the library', async () => {
    const w = await mountSuspended(MediaLibrary)
    await flushPromises()
    // the upload overlay only appears for file drags (an internal item-drag shows no overlay)
    await w.find('.media-library').trigger('dragenter', { dataTransfer: { types: ['Files'] } })
    expect(w.find('.media-library__dropzone').exists()).toBe(true)
    await w.find('.media-library').trigger('dragleave')
    expect(w.find('.media-library__dropzone').exists()).toBe(false)
  })

  it('renders a file with data-file-id and right-clicking it does not crash; delete dialog closed by default', async () => {
    const w = await mountSuspended(MediaLibrary)
    await flushPromises()
    const fileEl = w.find('[data-file-id]')
    expect(fileEl.exists()).toBe(true)
    await fileEl.trigger('contextmenu')
    expect(w.text()).not.toContain('published content')
  })

  it('renders without crashing with the rename dialog wired (closed by default)', async () => {
    const w = await mountSuspended(MediaLibrary)
    await flushPromises()
    expect(w.findAll('h2,h3,[role="heading"]').some((h) => /rename/i.test(h.text()))).toBe(false)
  })

  it('shows the clipboard indicator after items are cut, and hides it when cleared', async () => {
    const { cut, clear } = useMediaClipboard()
    clear()
    const w = await mountSuspended(MediaLibrary)
    await flushPromises()
    expect(w.find('.media-library__clipboard').exists()).toBe(false)
    cut([{ type: 'file', id: 1 }])
    await flushPromises()
    expect(w.find('.media-library__clipboard').exists()).toBe(true)
    clear()
    await flushPromises()
    expect(w.find('.media-library__clipboard').exists()).toBe(false)
  })

  it('mirrors the clipboard message into a permanent aria-live region present before the first cut', async () => {
    const { cut, clear } = useMediaClipboard()
    clear()
    const w = await mountSuspended(MediaLibrary)
    await flushPromises()
    // The region must already be in the DOM at mount (idle, empty text) so a screen reader has
    // something to diff against — a v-if-mounted region's first text is never announced.
    const region = w.find('.media-library__sr-status')
    expect(region.exists()).toBe(true)
    expect(region.attributes('aria-live')).toBe('polite')
    expect(region.text()).toBe('')
    cut([{ type: 'file', id: 1 }])
    await flushPromises()
    expect(w.find('.media-library__sr-status').text()).toContain('1')
    clear()
    await flushPromises()
  })

  it('saving alt text sends the row\'s updatedAt as the If-Unmodified-Since precondition (lost-update guard)', async () => {
    lastPatchHeader = undefined
    const w = await mountSuspended(MediaLibrary)
    await flushPromises()
    await w.find('[data-file-id="1"]').trigger('dblclick')
    await flushPromises()
    const input = w.find('.media-viewer__details input')
    await input.setValue('new alt')
    await w.findAll('button').find((b) => b.text() === 'Save')!.trigger('click')
    await flushPromises()
    expect(lastPatchHeader).toBe(String(new Date('2026-01-01T00:00:00.000Z').getTime()))
  })

  it('omits the AI-disclosure keys entirely while the feature is off, so an alt save cannot clear one', async () => {
    lastPatchBody = undefined
    const w = await mountSuspended(MediaLibrary)
    await flushPromises()
    await w.find('[data-file-id="1"]').trigger('dblclick')
    await flushPromises()
    await w.find('.media-viewer__details input').setValue('new alt')
    await w.findAll('button').find((b) => b.text() === 'Save')!.trigger('click')
    await flushPromises()
    expect(lastPatchBody).toEqual({ translations: { en: { alt: 'new alt' } } })
  })

  it('starting an item drag does not crash (marker/payload covered by unit tests)', async () => {
    const w = await mountSuspended(MediaLibrary)
    await flushPromises()
    // happy-dom's synthetic dragstart carries no real dataTransfer; the selection-aware payload +
    // marker logic is covered by the useMediaDnd + effectiveTargets unit tests. Assert no crash.
    await w.find('[data-file-id]').trigger('dragstart')
    expect(w.find('.media-library').exists()).toBe(true)
  })

  it('pick mode shows the confirm bar and emits confirm with the selected file ids', async () => {
    const w = await mountSuspended(MediaLibrary, { props: { pick: true, multiple: true } })
    await flushPromises()
    await w.find('[data-file-id="1"]').trigger('click')
    const use = w.findAll('button').find((b) => /use selected/i.test(b.text()))
    expect(use).toBeTruthy()
    await use!.trigger('click')
    expect((w.emitted('confirm')?.at(-1) as number[][])[0]).toEqual([1])
  })

  it('without pick there is no confirm bar (page mode unchanged)', async () => {
    const w = await mountSuspended(MediaLibrary)
    await flushPromises()
    expect(w.findAll('button').some((b) => /use selected/i.test(b.text()))).toBe(false)
  })

  it('single-pick keeps exactly one even on a modifier click', async () => {
    const w = await mountSuspended(MediaLibrary, { props: { pick: true } }) // multiple omitted → single
    await flushPromises()
    await w.find('[data-file-id="1"]').trigger('click')
    await w.find('[data-file-id="2"]').trigger('click', { ctrlKey: true })
    await w.findAll('button').find((b) => /use selected/i.test(b.text()))!.trigger('click')
    expect((w.emitted('confirm')?.at(-1) as number[][])[0]).toEqual([2])
  })

  it('managed multi-pick: seeds the checked set from initialSelected and confirms it without a click', async () => {
    const w = await mountSuspended(MediaLibrary, { props: { pick: true, multiple: true, initialSelected: [1] } })
    await flushPromises()
    expect(w.find('[data-file-id="1"]').attributes('aria-selected')).toBe('true')
    await w.findAll('button').find((b) => /use selected/i.test(b.text()))!.trigger('click')
    expect((w.emitted('confirm')?.at(-1) as number[][])[0]).toEqual([1])
  })

  it('managed multi-pick: clicking a pre-checked file toggles it off before confirm', async () => {
    const w = await mountSuspended(MediaLibrary, { props: { pick: true, multiple: true, initialSelected: [1, 2] } })
    await flushPromises()
    await w.find('[data-file-id="1"]').trigger('click')
    await nextTick()
    expect(w.find('[data-file-id="1"]').attributes('aria-selected')).toBe('false')
    expect(w.find('[data-file-id="2"]').attributes('aria-selected')).toBe('true')
    await w.findAll('button').find((b) => /use selected/i.test(b.text()))!.trigger('click')
    expect((w.emitted('confirm')?.at(-1) as number[][])[0]).toEqual([2])
  })

  it('managed multi-pick: seeds the library folder from initialFolder', async () => {
    await mountSuspended(MediaLibrary, { props: { pick: true, multiple: true, initialFolder: 'pics' } })
    await flushPromises()
    expect(lastLibraryFolder).toBe('pics')
  })
})
