import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useState } from '#imports'
import { flushPromises } from '@vue/test-utils'
import { readBody } from 'h3'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import RecordPage from './[id].vue'

// A pageLike, status-bearing collection — the page-builder case the Save/Publish split is for.
const pagesSchema = {
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, seo: false, status: true,
  blocks: { enabled: false }, label: { singular: 'Page', plural: 'Pages' },
  fields: { title: { type: 'text', required: true, translatable: false, unique: false } },
}
registerEndpoint('/api/collections', () => ({ data: [pagesSchema] }))

const calls = vi.hoisted(() => ({
  publishOnSave: false,
  writes: [] as Record<string, unknown>[],
  publishes: [] as Record<string, unknown>[],
  tickets: [] as Record<string, unknown>[],
}))

registerEndpoint('/api/pages/1', async (event) => {
  if (event.method === 'PATCH') {
    const b = await readBody(event)
    calls.writes.push(b)
    return { id: 1, ...b, updatedAt: '2026-08-13T10:00:00.000Z' }
  }
  return { id: 1, title: 'Existing', path: '/existing', status: 'draft', updatedAt: '2026-08-13T09:00:00.000Z' }
})
registerEndpoint('/api/pages', () => ({ data: [], total: 0, page: 1, perPage: 25 }))
registerEndpoint('/api/pages/1/dead-refs', () => [])
registerEndpoint('/api/publish-status', () => ({ route: '/existing', status: 'success', pending: !calls.publishOnSave, generates: true, publishOnSave: calls.publishOnSave, updatedAt: '2026-08-13T09:30:00.000Z' }))
registerEndpoint('/api/publish', async (event) => {
  calls.publishes.push(await readBody(event))
  return { queued: true, generates: true, routes: ['/existing'], pruned: [], drafts: [] }
})
registerEndpoint('/api/preview', async (event) => {
  if (event.method === 'POST') {
    calls.tickets.push(await readBody(event))
    return { token: 'pv_abc', expiresAt: Date.now() + 600_000 }
  }
  return null
})

const h = vi.hoisted(() => ({ params: { collection: 'pages', id: '1' }, nav: [] as unknown[] }))
mockNuxtImport('useRoute', () => () => ({ params: h.params, query: {}, fullPath: `/admin/${h.params.collection}/${h.params.id}` }))
mockNuxtImport('navigateTo', () => (to: unknown) => { h.nav.push(to); return Promise.resolve() })

let opened: Array<{ url: string }>
let lastTab: { location: { replace: (url: string) => void }; close: () => void } | null

beforeEach(() => {
  h.params = { collection: 'pages', id: '1' }
  h.nav.length = 0
  calls.publishOnSave = false
  calls.writes.length = 0
  calls.publishes.length = 0
  calls.tickets.length = 0
  opened = []
  lastTab = null
  useState('kestrel-collections').value = null
  useState('kestrel-blocks').value = null
  vi.spyOn(window, 'open').mockImplementation(((url?: string) => {
    // The real code opens a blank tab synchronously and redirects it once the ticket is minted.
    if (url) { opened.push({ url }); return null }
    lastTab = { location: { replace: (to: string) => opened.push({ url: to }) }, close: () => {} }
    return lastTab as unknown as Window
  }) as typeof window.open)
})

const settle = async () => {
  await new Promise((r) => setTimeout(r, 20))
  await flushPromises()
}
const button = (w: Awaited<ReturnType<typeof mountSuspended>>, label: string) =>
  w.findAll('.ui-button').find((b) => b.text() === label)

describe('record editor — Save and Publish are separate actions', () => {
  it('offers Publish next to Save', async () => {
    const w = await mountSuspended(RecordPage)
    await flushPromises()
    const labels = w.find('.record__actions').findAll('.ui-button').map((b) => b.text()).filter(Boolean)
    expect(labels).toContain('Publish')
    expect(labels.indexOf('Publish')).toBe(labels.indexOf('Save') + 1)
  })

  // `output.publishOnSave` is the way back to the pre-1.8 model, where a save republished on its own.
  it('drops the Publish button when the consumer turned the split off', async () => {
    calls.publishOnSave = true
    const w = await mountSuspended(RecordPage)
    await settle()
    expect(w.find('.record__actions').findAll('.ui-button').map((b) => b.text())).not.toContain('Publish')
  })

  it('Save writes the record and asks for no publish at all', async () => {
    const w = await mountSuspended(RecordPage)
    await flushPromises()
    await w.find('input[type="text"]').setValue('Edited')
    // The header Save is a `type=submit` bound to the form by id — which only the real browser follows.
    await w.find('form.editor').trigger('submit')
    await settle()
    expect(calls.writes).toHaveLength(1)
    expect(calls.writes[0]).toMatchObject({ title: 'Edited', status: 'draft' }) // status untouched by a save
    expect(calls.publishes).toEqual([])
  })

  it('Publish saves first, promotes the draft, and then writes the static output', async () => {
    const w = await mountSuspended(RecordPage)
    await flushPromises()
    await w.find('input[type="text"]').setValue('Ready to go')
    await button(w, 'Publish')!.trigger('click')
    await settle()
    expect(calls.writes[0]).toMatchObject({ title: 'Ready to go', status: 'published' })
    expect(calls.publishes).toEqual([{ collection: 'pages', id: 1 }])
  })
})

describe('record editor — previewing in a new tab', () => {
  it('opens the saved URL directly when there is nothing unsaved', async () => {
    const w = await mountSuspended(RecordPage)
    await flushPromises()
    const preview = w.findAll('.ui-button').find((b) => b.attributes('aria-label') === 'Open in new tab')!
    await preview.trigger('click')
    await settle()
    expect(opened.map((o) => o.url)).toContain('/existing')
    expect(calls.tickets).toEqual([])
  })

  it('mints a ticket for unsaved changes instead of saving them', async () => {
    const w = await mountSuspended(RecordPage)
    await flushPromises()
    await w.find('input[type="text"]').setValue('Not saved')
    await flushPromises()
    const preview = w.findAll('.ui-button').find((b) => b.attributes('aria-label') === 'Preview unsaved changes in a new tab')!
    await preview.trigger('click')
    await settle()
    expect(calls.writes).toEqual([]) // the whole point: no save
    expect(calls.tickets[0]).toMatchObject({ collection: 'pages', id: 1, values: { title: 'Not saved' } })
    expect(opened.at(-1)!.url).toBe('/existing?kestrel-preview-token=pv_abc')
  })
})
