import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useState } from '#imports'
import { flushPromises } from '@vue/test-utils'
import { readBody } from 'h3'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import RecordPage from './[id].vue'

const thingsSchema = {
  name: 'things', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Thing', plural: 'Things' },
  fields: { title: { type: 'text', required: true, unique: false } },
}
// Carries an explicit `label.new` — the create heading must use it verbatim, not the generic template.
const articlesSchema = {
  name: 'articles', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Article', plural: 'Articles', new: 'Compose article' },
  fields: { title: { type: 'text', required: true, unique: false } },
}
registerEndpoint('/api/collections', () => ({ data: [thingsSchema, articlesSchema] }))
registerEndpoint('/api/articles', () => ({ data: [], total: 0, page: 1, perPage: 25 }))

let patched: Record<string, unknown> | null = null
let posted: Record<string, unknown> | null = null
registerEndpoint('/api/things/1', async (event) => {
  if (event.method === 'PATCH') { patched = await readBody(event); return { id: 1, ...patched } }
  return { id: 1, title: 'Existing' }
})
// A record whose title field is blank — the heading must fall back to the generic "#id" phrase.
registerEndpoint('/api/things/2', () => ({ id: 2, title: '   ' }))
registerEndpoint('/api/things', async (event) => {
  if (event.method === 'POST') { posted = await readBody(event); return { id: 7, ...posted } }
  return { data: [], total: 0, page: 1, perPage: 25 }
})

// The editor's Delete flows through the shared batch endpoint + the referrer-aggregate preview.
let bulkBody: Record<string, unknown> | null = null
registerEndpoint('/api/things/bulk', async (event) => {
  bulkBody = await readBody(event)
  return { action: bulkBody!.action, count: 1, ids: bulkBody!.ids }
})
registerEndpoint('/api/references/referrers', () => ({ counts: {} }))

// Route + navigation are mocked so the page reads collection/id from `h.params` and navigations are captured.
const h = vi.hoisted(() => ({ params: { collection: 'things', id: '1' }, nav: [] as unknown[] }))
mockNuxtImport('useRoute', () => () => ({ params: h.params, query: {}, fullPath: `/admin/${h.params.collection}/${h.params.id}` }))
mockNuxtImport('navigateTo', () => (to: unknown) => { h.nav.push(to); return Promise.resolve() })

beforeEach(() => {
  h.params = { collection: 'things', id: '1' }
  h.nav.length = 0
  patched = null
  posted = null
  bulkBody = null
  useState('kestrel-collections').value = null
  useState('kestrel-blocks').value = null
})

const settle = async () => {
  await new Promise((r) => setTimeout(r, 20))
  await flushPromises()
}

describe('record editor page header', () => {
  it('merges Save, Cancel and Delete into the record head, each with an icon', async () => {
    const w = await mountSuspended(RecordPage)
    await flushPromises()

    const head = w.find('.record__head')
    expect(head.exists()).toBe(true)
    const buttons = head.findAll('.ui-button')
    expect(buttons.map((b) => b.text())).toEqual(expect.arrayContaining(['Save', 'Cancel', 'Delete']))
    for (const b of buttons) expect(b.find('.ui-icon').exists()).toBe(true)
    expect(w.find('.editor__actions').exists()).toBe(false)

    // Cancel carries real button chrome — it sits beside the solid Delete/Save, not as bare text…
    expect(buttons.find((b) => b.text() === 'Cancel')!.classes()).toContain('ui-button--secondary')
    // …while the icon-only tools (undo/redo/open) stay quiet ghosts.
    const iconOnly = buttons.filter((b) => b.text() === '')
    expect(iconOnly.length).toBeGreaterThan(0)
    for (const b of iconOnly) expect(b.classes()).toContain('ui-button--ghost')
  })

  it('titles the header with the singular label, not the raw (plural) route param', async () => {
    h.params = { collection: 'things', id: 'new' }
    const wNew = await mountSuspended(RecordPage)
    await flushPromises()
    expect(wNew.find('.record__title').text()).toBe('New Thing')
    expect(wNew.find('.record__back').text()).toContain('Things')
    // The generic phrase is title-cased; a real record title would not be.
    expect(wNew.find('.record__title').classes()).toContain('record__title--generic')
  })

  it('keeps the back link on the heading row (one line, so the panes keep the vertical space)', async () => {
    const w = await mountSuspended(RecordPage)
    await flushPromises()
    expect(w.find('.record__head .record__back').exists()).toBe(true)
  })

  it('titles a saved record with its own title — an id means nothing to an editor', async () => {
    h.params = { collection: 'things', id: '1' }
    const wEdit = await mountSuspended(RecordPage)
    await settle()
    expect(wEdit.find('.record__title').text()).toBe('Existing')
    expect(wEdit.find('.record__title').classes()).not.toContain('record__title--generic')
  })

  it('falls back to "Edit {collection} #{id}" when the record has no usable title', async () => {
    h.params = { collection: 'things', id: '2' }
    const wEdit = await mountSuspended(RecordPage)
    await settle()
    expect(wEdit.find('.record__title').text()).toBe('Edit Thing #2')
    expect(wEdit.find('.record__title').classes()).toContain('record__title--generic')
  })

  it('uses the collection\'s explicit label.new for the create heading (no generic "New X")', async () => {
    h.params = { collection: 'articles', id: 'new' }
    const w = await mountSuspended(RecordPage)
    await flushPromises()
    expect(w.find('.record__title').text()).toBe('Compose article')
  })

  it('wires the header Save button to submit the editor form', async () => {
    const w = await mountSuspended(RecordPage)
    await flushPromises()
    const save = w.findAll('.record__head .ui-button').find((b) => b.text() === 'Save')!
    expect(save.attributes('type')).toBe('submit')
    expect(save.attributes('form')).toBe('record-editor')
    expect(w.find('form.editor').attributes('id')).toBe('record-editor')
  })

  it('shows the back link with a centered SVG arrow (no text arrow glyph)', async () => {
    const w = await mountSuspended(RecordPage)
    await flushPromises()
    const back = w.find('.record__back')
    expect(back.exists()).toBe(true)
    expect(back.find('.ui-icon').exists()).toBe(true)
    expect(back.text()).not.toContain('←')
  })

  it('saving an existing record stays on the page — Save only saves', async () => {
    const w = await mountSuspended(RecordPage)
    await flushPromises()
    await w.find('form.editor').trigger('submit')
    await settle()
    expect(patched).toMatchObject({ title: 'Existing' })
    expect(h.nav).toEqual([])
  })

  it('saving a NEW record moves to its own editor, not back to the list', async () => {
    h.params = { collection: 'things', id: 'new' }
    const w = await mountSuspended(RecordPage)
    await flushPromises()
    await w.findAll('input')[0]!.setValue('Fresh')
    await w.find('form.editor').trigger('submit')
    await settle()
    expect(posted).toMatchObject({ title: 'Fresh' })
    // navigates to the created record's editor (id 7), never to the list path
    expect(h.nav).toContain('/admin/things/7')
    expect(h.nav).not.toContain('/admin/things')
  })

  it('deletes through the confirm dialog (shared batch op) and navigates back to the list', async () => {
    const w = await mountSuspended(RecordPage)
    await settle()
    // the header Delete opens the dialog rather than window.confirm
    const del = w.findAll('.record__head .ui-button').find((b) => b.text() === 'Delete')!
    await del.trigger('click')
    await settle()
    expect(w.find('.ui-dialog__content').exists()).toBe(true)
    // confirming posts the bulk delete for this one id and then navigates to the list
    const confirm = w.findAll('.ui-dialog__content .ui-button').find((b) => /^delete$/i.test(b.text().trim()))!
    await confirm.trigger('click')
    await settle()
    expect(bulkBody).toEqual({ action: 'delete', ids: [1] })
    expect(h.nav).toContain('/admin/things')
  })

  it('a native beforeunload (tab close / reload) is blocked only while there are unsaved changes', async () => {
    const w = await mountSuspended(RecordPage)
    await flushPromises()

    // pristine → unload is NOT blocked
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)

    // edit a field → dirty → unload IS blocked (browser shows its native prompt)
    await w.findAll('input')[0]!.setValue('Changed')
    await settle()
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)

    // unmounting removes the listener (no leak across pages)
    w.unmount()
    const afterUnmount = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterUnmount)
    expect(afterUnmount.defaultPrevented).toBe(false)
  })
})
