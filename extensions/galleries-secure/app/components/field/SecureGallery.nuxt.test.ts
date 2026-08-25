import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import SecureGallery from './SecureGallery.vue'

describe('SecureGallery Enter handling', () => {
  // The widget renders inside the record-editor <form>; the binding must act on keydown and swallow the
  // default so Enter in its password inputs never fires the form's implicit submission.
  it('create phase: Enter in the password input runs create() and never submits the surrounding form', async () => {
    const w = await mountSuspended(SecureGallery, { props: { name: 'Gallery', modelValue: null } })
    const input = w.find('input[type="password"]')
    expect(input.exists()).toBe(true)
    await input.setValue('x') // too short → create() bails with the min-length notice, no crypto/network
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input.element.dispatchEvent(e)
    await flushPromises()
    expect(e.defaultPrevented).toBe(true)
    expect(w.text()).toContain('Use a password of at least')
  })
})
