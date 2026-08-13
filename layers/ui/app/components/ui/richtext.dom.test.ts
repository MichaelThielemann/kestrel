import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import Richtext from './Richtext.vue'

/** The live TipTap instance behind the wrapper — the only way to drive a REAL edit under happy-dom. */
const editorOf = (w: VueWrapper) =>
  (w.vm as unknown as { editor: { commands: { insertContent: (s: string) => boolean } } }).editor

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

  // `disabled` is bound to the edit form's `saving` flag, so this fires around every save — and TipTap
  // emits `update` for a bare editability change. The value must be in the SANITIZER's serialization
  // (`<br />`, what the server stores) rather than TipTap's (`<br>`): an identical re-emit is swallowed
  // by Vue's useModel setter, so a TipTap-form value would pass even unguarded.
  it('does not emit when only the editable state is toggled', async () => {
    const w = mount(Richtext, { props: { modelValue: '<p>Zeile eins<br />Zeile zwei</p>' } })
    await new Promise((r) => setTimeout(r, 0))

    await w.setProps({ disabled: true })
    await new Promise((r) => setTimeout(r, 0))
    await w.setProps({ disabled: false })
    await new Promise((r) => setTimeout(r, 0))

    expect(w.emitted('update:modelValue')).toBeUndefined()
    w.unmount()
  })

  it('still emits a real content change, including right after an external write', async () => {
    const w = mount(Richtext, { props: { modelValue: '<p>Hi</p>' } })
    await new Promise((r) => setTimeout(r, 0))

    await w.setProps({ modelValue: '<p>Other</p>' })
    await new Promise((r) => setTimeout(r, 0))
    expect(w.emitted('update:modelValue')).toBeUndefined()

    editorOf(w).commands.insertContent('!')
    await new Promise((r) => setTimeout(r, 0))

    const emits = w.emitted('update:modelValue')
    expect(emits).toBeTruthy()
    expect(String(emits!.at(-1)![0])).toContain('Other!')
    w.unmount()
  })
})
