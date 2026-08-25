import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { defineEventHandler } from 'h3'
import { clearNuxtData } from '#imports'
import PreviewPage from './preview.vue'

const h = vi.hoisted(() => ({ query: {} as Record<string, string>, authenticated: true }))
mockNuxtImport('useRoute', () => () => ({ path: '/__kestrel/preview', query: h.query, meta: {} }))

registerEndpoint('/api/session', defineEventHandler(() => ({ authenticated: h.authenticated })))
registerEndpoint('/api/preview', defineEventHandler(() => ({
  payload: { collection: 'pages', id: null, values: { content: [{ id: 'b1', type: 'hero', props: {} }] } },
})))

beforeEach(() => {
  h.query = {}
  h.authenticated = true
  clearNuxtData() // the session/ticket fetches are keyed asyncData — without this they carry across cases
})

// The fallback preview page is what a record with no public URL (never saved, blank slug, non-pageLike)
// previews in. In an external tab there is no parent window to post content, so the ticket carries it.
describe('__kestrel/preview — ticket content in a tab of its own', () => {
  it('seeds the bridge with the ticket\'s unsaved blocks', async () => {
    h.query = { 'kestrel-preview-token': 'pv_test' }
    const wrapper = await mountSuspended(PreviewPage)
    await flushPromises()
    expect(wrapper.findComponent({ name: 'KestrelPreviewBridge' }).props('blocks')).toEqual([{ id: 'b1', type: 'hero', props: {} }])
  })

  it('renders an empty tree without a ticket — the postMessage bridge fills it in the editor iframe', async () => {
    const wrapper = await mountSuspended(PreviewPage)
    await flushPromises()
    expect(wrapper.findComponent({ name: 'KestrelPreviewBridge' }).props('blocks')).toEqual([])
  })

  it('stays a 404 for anonymous requests — a ticket is not a way in', async () => {
    h.authenticated = false
    h.query = { 'kestrel-preview-token': 'pv_test' }
    await expect(mountSuspended(PreviewPage)).rejects.toMatchObject({ statusCode: 404 })
  })
})
