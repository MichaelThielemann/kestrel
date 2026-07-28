import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import MediaPage from './media.vue'

registerEndpoint('/api/media/library', () => ({ folder: '', folders: [], files: [], total: 0, page: 1, perPage: 60 }))

describe('/admin/media', () => {
  it('renders the MediaLibrary', async () => {
    const w = await mountSuspended(MediaPage)
    await flushPromises(); await nextTick()
    expect(w.find('.media-library').exists()).toBe(true)
  })
})
