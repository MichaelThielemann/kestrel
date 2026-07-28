import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createError } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import LinkInternalPicker from './LinkInternalPicker.vue'

// A failing /api/collections must not throw an unhandled rejection or leave the picker silently dead.
registerEndpoint('/api/collections', () => {
  throw createError({ statusCode: 500, statusMessage: 'boom' })
})

describe('LinkInternalPicker (collections fetch fails)', () => {
  it('surfaces an error instead of rendering an empty, inoperable picker', async () => {
    const w = await mountSuspended(LinkInternalPicker, {
      props: { locale: 'en', collection: null, recordId: null },
    })
    await flushPromises()
    expect(w.text()).toContain('Could not load collections')
    expect(w.find('select').exists()).toBe(false)
  })
})
