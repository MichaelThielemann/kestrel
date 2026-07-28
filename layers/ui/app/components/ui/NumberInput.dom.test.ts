import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NumberInput from './NumberInput.vue'

// happy-dom skips the number input's value sanitization: a real browser reports '' from `.value` while
// the field holds text that is not a valid floating-point number ('1.'), yet keeps that text on screen.
// Typing a decimal only round-trips through the model because of that, so model it here.
function sanitizeLikeBrowser(el: HTMLInputElement) {
  let text = el.value
  Object.defineProperty(el, 'value', {
    get: () => (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text) ? text : ''),
    set: (v: string) => { text = String(v) },
    configurable: true,
  })
  return { press: (ch: string) => { text += ch }, text: () => text }
}

describe('UiNumberInput', () => {
  it('renders the model value and emits numbers', async () => {
    const w = mount(NumberInput, { props: { modelValue: 3 } })
    const input = w.get('input')
    expect((input.element as HTMLInputElement).value).toBe('3')
    await input.setValue('7')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([7])
  })

  it('emits null for an empty value', async () => {
    const w = mount(NumberInput, { props: { modelValue: 5 } })
    await w.get('input').setValue('')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([null])
  })

  it('leaves in-progress decimal text alone while the model echoes back the parsed number', async () => {
    const emitted: (number | null)[] = []
    const w = mount(NumberInput, {
      attachTo: document.body,
      props: {
        modelValue: null,
        step: 0.01,
        'onUpdate:modelValue': (v: number | null) => {
          emitted.push(v)
          w.setProps({ modelValue: v })
        },
      },
    })
    const input = w.get('input')
    const el = input.element as HTMLInputElement
    el.focus()
    const field = sanitizeLikeBrowser(el)

    // Keystroke by keystroke: '1.0' parses to 1, and echoing that back over the field's text would drop
    // the trailing zero, so the next digit would land on '1' and 1.05 would be saved as 15.
    for (const ch of '1.05') {
      field.press(ch)
      await input.trigger('input')
    }
    expect(field.text()).toBe('1.05')
    expect(emitted.at(-1)).toBe(1.05)

    w.unmount()
  })

  it('applies type=number and min/max/step', () => {
    const w = mount(NumberInput, { props: { min: 1, max: 9, step: 'any' } })
    const input = w.get('input')
    expect(input.attributes('type')).toBe('number')
    expect(input.attributes('min')).toBe('1')
    expect(input.attributes('max')).toBe('9')
    expect(input.attributes('step')).toBe('any')
  })

  it('snaps unparsable text back to the model on blur (badInput guard)', async () => {
    const w = mount(NumberInput, { props: { modelValue: 5 } })
    const input = w.get('input').element as HTMLInputElement
    Object.defineProperty(input, 'validity', { value: { badInput: true } })
    input.value = '1e'
    await w.get('input').trigger('blur')
    expect(input.value).toBe('5')
  })

  it('clears unparsable text on blur when the model is null', async () => {
    const w = mount(NumberInput, { props: { modelValue: null } })
    const input = w.get('input').element as HTMLInputElement
    Object.defineProperty(input, 'validity', { value: { badInput: true } })
    // '1e' is retained by the DOM (unlike '-', which sanitizes to '' at assignment and would make this
    // assertion hold with or without the guard); the null-model branch must actively clear it.
    input.value = '1e'
    await w.get('input').trigger('blur')
    expect(input.value).toBe('')
  })

  it('leaves a parsable value untouched on blur (does not emit or clobber a valid value)', async () => {
    const w = mount(NumberInput, { props: { modelValue: 5 } })
    await w.get('input').setValue('7')
    const emitsBeforeBlur = w.emitted('update:modelValue')!.length
    await w.get('input').trigger('blur')
    // The guard must skip a valid value: no snap-back write, and crucially no spurious model emit.
    expect(w.emitted('update:modelValue')!.length).toBe(emitsBeforeBlur)
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual([7])
    expect((w.get('input').element as HTMLInputElement).value).toBe('7')
  })

  it('Enter on unparsable text suppresses implicit submit and snaps back (no blur fires)', () => {
    const w = mount(NumberInput, { props: { modelValue: 5 } })
    const input = w.get('input').element as HTMLInputElement
    Object.defineProperty(input, 'validity', { value: { badInput: true } })
    input.value = '1e'
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(input.value).toBe('5')
  })

  it('Enter on a valid value does not suppress submit', () => {
    const w = mount(NumberInput, { props: { modelValue: 5 } })
    const input = w.get('input').element as HTMLInputElement
    Object.defineProperty(input, 'validity', { value: { badInput: false } })
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })

  it('renders no suffix adornment by default (bare input path unchanged)', () => {
    const w = mount(NumberInput, { props: { modelValue: 3 } })
    expect(w.find('.ui-number-wrap').exists()).toBe(false)
    expect(w.get('input').classes()).toContain('ui-number')
  })

  it('renders a suffix adornment and still emits numbers when suffix is set', async () => {
    const w = mount(NumberInput, { props: { modelValue: 3, suffix: 'rem' } })
    expect(w.find('.ui-number-wrap').exists()).toBe(true)
    expect(w.get('.ui-number-wrap__suffix').text()).toBe('rem')
    const input = w.get('input')
    expect(input.classes()).toContain('ui-number-wrap__input')
    expect((input.element as HTMLInputElement).value).toBe('3')
    await input.setValue('7')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([7])
  })

  it('is not slim by default, and marks the slim variant on both the bare and the suffix path', () => {
    expect(mount(NumberInput, { props: { modelValue: 3 } }).get('input').classes()).not.toContain('ui-number--slim')

    const bareSlim = mount(NumberInput, { props: { modelValue: 3, slim: true } })
    expect(bareSlim.get('input').classes()).toContain('ui-number--slim')

    const suffixSlim = mount(NumberInput, { props: { modelValue: 3, suffix: 'rem', slim: true } })
    expect(suffixSlim.get('.ui-number-wrap').classes()).toContain('ui-number-wrap--slim')
    // The slim modifier is chrome only — the value contract is untouched.
    expect((suffixSlim.get('input').element as HTMLInputElement).value).toBe('3')
  })

  it('with a suffix, id/aria-* land on the inner input (not the wrapper) so the label stays linked', () => {
    const w = mount(NumberInput, {
      props: { modelValue: null, suffix: 'rem' },
      attrs: { id: 'pad', 'aria-invalid': 'true' },
    })
    expect(w.get('.ui-number-wrap').attributes('id')).toBeUndefined()
    const input = w.get('input')
    expect(input.attributes('id')).toBe('pad')
    expect(input.attributes('aria-invalid')).toBe('true')
  })

  it('passes id and aria-* through to the input', () => {
    const w = mount(NumberInput, {
      props: { modelValue: null },
      attrs: { id: 'age', 'aria-invalid': 'true' },
    })
    const input = w.get('input')
    expect(input.attributes('id')).toBe('age')
    expect(input.attributes('aria-invalid')).toBe('true')
  })
})
