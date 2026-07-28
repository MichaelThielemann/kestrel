import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import FieldJson from './Json.vue'

const base = { name: 'Data', locale: 'en', field: { type: 'json' as const } }

describe('FieldJson', () => {
  it('reseeds and clears a parse error when the model changes externally while invalid text is shown', async () => {
    const w = mount(FieldJson, { props: { ...base, modelValue: { a: 1 } } })
    const ta = w.get('textarea')
    await ta.setValue('{ not valid json') // parse error; model is deliberately NOT updated
    expect(w.text()).toContain('Invalid JSON')

    // an external action (applyFrom / copy-from-locale / form reset) changes the model in place
    await w.setProps({ modelValue: { b: 2 } })
    await nextTick()

    // the textarea must follow the new model and the now-phantom error must clear (otherwise the user
    // sees stale invalid text + an error over a value that has actually changed, and saves it unseen)
    expect((ta.element as HTMLTextAreaElement).value).toContain('"b": 2')
    expect(w.text()).not.toContain('Invalid JSON')
  })

  it('does not clobber an in-progress VALID edit that already equals the model', async () => {
    const w = mount(FieldJson, { props: { ...base, modelValue: { a: 1 } } })
    const ta = w.get('textarea')
    await ta.setValue('{ "a": 1, "c": 3 }') // valid → model updates to {a:1,c:3}
    await nextTick()
    // a reactive echo of the same value must not reset the user's formatting/caret
    await w.setProps({ modelValue: { a: 1, c: 3 } })
    await nextTick()
    expect((ta.element as HTMLTextAreaElement).value).toBe('{ "a": 1, "c": 3 }')
  })

  it('blanking the textarea emits null, not undefined (undefined is dropped by JSON.stringify and never reaches the save)', async () => {
    const w = mount(FieldJson, { props: { ...base, modelValue: { a: 1 } } })
    const ta = w.get('textarea')
    await ta.setValue('')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([null])
  })

  it('a null model renders as an empty textarea, not the string "null"', () => {
    const w = mount(FieldJson, { props: { ...base, modelValue: null } })
    const ta = w.get('textarea')
    expect((ta.element as HTMLTextAreaElement).value).toBe('')
  })
})
