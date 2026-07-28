import { describe, it, expect, beforeEach } from 'vitest'
import { useState } from '#imports'
import { flushPromises } from '@vue/test-utils'
import { readBody } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import SingletonEditor from './SingletonEditor.vue'

const settingsSchema = {
  name: 'settings', mode: 'single', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Settings', plural: 'Settings' },
  fields: { siteName: { type: 'text', required: false, translatable: false, unique: false } },
}
registerEndpoint('/api/collections', () => ({ data: [settingsSchema] }))

let put: Record<string, unknown> | null = null
registerEndpoint('/api/settings', async (event) => {
  if (event.method === 'PUT') { put = await readBody(event); return { id: 1, ...put } }
  return { id: 1, siteName: 'Hello' } // singleton GET returns the row directly (not wrapped)
})

beforeEach(() => {
  useState('kestrel-collections').value = null
  put = null
})

const settle = async () => {
  await new Promise((r) => setTimeout(r, 20))
  await flushPromises()
}

describe('SingletonEditor', () => {
  it('renders the title and a header Save button wired to the editor form', async () => {
    const w = await mountSuspended(SingletonEditor, { props: { collection: 'settings', title: 'Settings' } })
    await flushPromises()
    expect(w.find('.singleton__title').text()).toBe('Settings')
    const save = w.findAll('.singleton__head .ui-button').find((b) => b.text() === 'Save')!
    expect(save.attributes('type')).toBe('submit')
    expect(save.attributes('form')).toBe('singleton-editor')
    expect(w.find('form.editor').attributes('id')).toBe('singleton-editor')
    // no inline editor actions row — Save lives in the header
    expect(w.find('.editor__actions').exists()).toBe(false)
  })

  it('PUTs the singleton when the form is submitted', async () => {
    const w = await mountSuspended(SingletonEditor, { props: { collection: 'settings', title: 'Settings' } })
    await flushPromises()
    await w.find('input').setValue('Changed')
    await w.find('form.editor').trigger('submit')
    await settle()
    expect(put).toMatchObject({ siteName: 'Changed' })
  })
})
