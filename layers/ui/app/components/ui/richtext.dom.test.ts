import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Richtext from './Richtext.vue'

// Smoke only: ProseMirror's editing surface is not reliable under happy-dom, so
// editor interaction is verified manually. We assert the component mounts and the
// toolbar/content shell render.
describe('UiRichtext', () => {
  it('mounts the editor shell with a toolbar', async () => {
    const w = mount(Richtext, { props: { modelValue: '<p>Hi</p>' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(w.find('.ui-richtext').exists()).toBe(true)
    expect(w.find('.ui-rt-toolbar').exists()).toBe(true)
    w.unmount()
  })

  // An echoed emit reaches the edit form as a user edit: it clears the redo stack (Undo kills Redo) and
  // lands '' where the restored value was null, leaving the form dirty after a full revert.
  it('applies an external model write without emitting it back', async () => {
    const w = mount(Richtext, { props: { modelValue: '<p>Hi</p>' } })
    await new Promise((r) => setTimeout(r, 0))

    await w.setProps({ modelValue: null })
    await new Promise((r) => setTimeout(r, 0))
    expect(w.emitted('update:modelValue')).toBeUndefined()

    await w.setProps({ modelValue: '<p>Other</p>' })
    await new Promise((r) => setTimeout(r, 0))
    expect(w.emitted('update:modelValue')).toBeUndefined()
    expect(w.find('.tiptap').text()).toContain('Other')

    w.unmount()
  })
})
