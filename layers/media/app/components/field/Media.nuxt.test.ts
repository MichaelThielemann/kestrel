import { describe, it, expect, beforeEach } from 'vitest'
import { useCookie } from '#imports'
import { getQuery } from 'h3'
import { registerEndpoint, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import FieldMedia from './Media.vue'

// Keyed by id so each test can resolve a record with a specific mime: an image renders a thumbnail,
// a non-image (pdf) the file badge + filename.
const RECORDS: Record<number, { id: number; src: string; alt: string | null; mime: string; srcset: { url: string; width: number }[] }> = {
  7: { id: 7, src: '/u/7', alt: 'a pic', mime: 'image/png', srcset: [{ url: '/u/7-320.webp', width: 320 }] },
  9: { id: 9, src: '/u/9', alt: 'pic 9', mime: 'image/png', srcset: [] },
  42: { id: 42, src: '/u/report.pdf', alt: null, mime: 'application/pdf', srcset: [] },
}
registerEndpoint('/api/media/resolve', (event) => {
  const ids = String(getQuery(event).ids ?? '').split(',').filter(Boolean).map(Number)
  return { data: ids.map((id) => RECORDS[id]).filter(Boolean) }
})

beforeEach(() => {
  // Each test starts from the source admin language; the i18n test opts into `de`.
  useCookie<string>('kestrel-admin-lang').value = 'en'
})

describe('FieldMedia', () => {
  it('resolves the model id and renders a thumbnail', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media' }, name: 'Hero', modelValue: 7 } })
    await flushPromises()
    const img = w.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/u/7')
  })
  it('renders a non-image file as a badge + filename, not an <img>', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media' }, name: 'Doc', modelValue: 42 } })
    await flushPromises()
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('.field-media__badge').exists()).toBe(true)
    expect(w.text()).toContain('PDF')
    expect(w.text()).toContain('report.pdf')
  })
  it('emits the picked id on confirm (single) and clears on remove', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media' }, name: 'Hero', modelValue: null } })
    await flushPromises()
    ;(w.vm as unknown as { onConfirm: (ids: number[]) => void }).onConfirm([7])
    await flushPromises()
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([7])
  })
  it('multiple: onConfirm replaces with the picked set (deduped)', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media', options: { multiple: true } }, name: 'Gallery', modelValue: [7] } })
    await flushPromises()
    ;(w.vm as unknown as { onConfirm: (ids: number[]) => void }).onConfirm([7, 9])
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([[7, 9]])
  })
  it('multiple: onConfirm REPLACES (an unchecked item is removed, not merged back)', async () => {
    // The managed picker returns the full desired set, so confirming [9] over a current [7] drops 7.
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media', options: { multiple: true } }, name: 'Gallery', modelValue: [7] } })
    await flushPromises()
    ;(w.vm as unknown as { onConfirm: (ids: number[]) => void }).onConfirm([9])
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([[9]])
  })
  it('multiple: drag-reorders the model (drop item 0 onto item 1)', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media', options: { multiple: true } }, name: 'Gallery', modelValue: [7, 9] } })
    await flushPromises()
    const items = w.findAll('.field-media__item')
    expect(items.length).toBe(2)
    const dt = { setData: () => {}, effectAllowed: '' }
    await items[0]!.trigger('dragstart', { dataTransfer: dt })
    await items[1]!.trigger('drop', { dataTransfer: dt })
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([[9, 7]])
  })
  it('multiple: dropping an item on itself does not emit a change', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media', options: { multiple: true } }, name: 'Gallery', modelValue: [7, 9] } })
    await flushPromises()
    const items = w.findAll('.field-media__item')
    const dt = { setData: () => {}, effectAllowed: '' }
    await items[1]!.trigger('dragstart', { dataTransfer: dt })
    await items[1]!.trigger('drop', { dataTransfer: dt })
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
  it('multiple: keyboard move-later reorders and announces via the live region', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media', options: { multiple: true } }, name: 'Gallery', modelValue: [7, 9] } })
    await flushPromises()
    // item 0 is id 7 (alt 'a pic'); its "move later" button pushes it to position 2.
    await w.find('[aria-label="Move a pic later"]').trigger('click')
    await nextTick(); await nextTick()
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([[9, 7]])
    const live = w.find('.field-media__live')
    expect(live.attributes('aria-live')).toBe('polite')
    expect(live.text()).toBe('Moved a pic to position 2 of 2')
  })
  it('gives each item a DISTINCT accessible name when images lack alt (filename, not the shared "media")', async () => {
    // 42 (report.pdf) and 7 (a pic) — 42 has no alt, so its buttons name it by filename, not "media".
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media', options: { multiple: true } }, name: 'Gallery', modelValue: [42, 7] } })
    await flushPromises()
    expect(w.find('[aria-label="Remove report.pdf"]').exists()).toBe(true) // filename fallback, unique
    expect(w.find('[aria-label="Remove a pic"]').exists()).toBe(true)     // alt when present
    expect(w.find('[aria-label="Remove media"]').exists()).toBe(false)    // never the generic shared noun
  })
  it('multiple: maps a resolved index back to the model index when a dangling id is present', async () => {
    // 999 has no record → it drops out of `resolved`, so resolved index 1 (id 9) is model index 2.
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media', options: { multiple: true } }, name: 'Gallery', modelValue: [7, 999, 9] } })
    await flushPromises()
    const items = w.findAll('.field-media__item')
    expect(items.length).toBe(2)
    const dt = { setData: () => {}, effectAllowed: '' }
    await items[1]!.trigger('dragstart', { dataTransfer: dt }) // id 9
    await items[0]!.trigger('drop', { dataTransfer: dt }) // onto id 7
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([[9, 7, 999]])
  })
  it('multiple + disabled: items are not draggable and expose no move/remove controls', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media', options: { multiple: true } }, name: 'Gallery', modelValue: [7, 9], disabled: true } })
    await flushPromises()
    expect(w.find('.field-media__item').attributes('draggable')).not.toBe('true')
    expect(w.find('.field-media__move').exists()).toBe(false)
    expect(w.find('.field-media__remove').exists()).toBe(false)
  })
  it('single mode: the item is not draggable and has no move buttons', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media' }, name: 'Hero', modelValue: 7 } })
    await flushPromises()
    expect(w.find('.field-media__item').attributes('draggable')).not.toBe('true')
    expect(w.find('.field-media__move').exists()).toBe(false)
  })
  it('single mode: the remove button carries a non-empty aria-label', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media' }, name: 'Hero', modelValue: 7 } })
    await flushPromises()
    expect(w.find('.field-media__remove').attributes('aria-label')).toBe('Remove a pic')
  })
  it('marks a required media field with the required indicator (like every other widget)', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media', required: true }, name: 'Hero', modelValue: null } })
    await flushPromises()
    expect(w.find('.ui-field__required').exists()).toBe(true)
  })
  it('shows no required indicator on an optional media field', async () => {
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media' }, name: 'Hero', modelValue: null } })
    await flushPromises()
    expect(w.find('.ui-field__required').exists()).toBe(false)
  })
  it('localizes its labels via the admin-UI language (de)', async () => {
    useCookie<string>('kestrel-admin-lang').value = 'de'
    const w = await mountSuspended(FieldMedia, { props: { field: { type: 'media' }, name: 'Hero', modelValue: null } })
    await flushPromises()
    expect(w.text()).toContain('Keine Medien ausgewählt.')
    expect(w.text()).toContain('Medien auswählen')
  })
})
