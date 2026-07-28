import { describe, it, expect, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import UiDialog from './Dialog.vue'

// `useT` is provided globally to the dom project via test/setup.dom.ts (backed by the en catalog).
// Every mount is attached to the document because reka's dialog wiring is document-based: the accessible
// name is resolved by `getElementById`, and the overlay walks the body to mark siblings aria-hidden. A
// detached tree makes both misfire — reka then reports as missing the DialogTitle this component renders.
const mountDialog = (props: InstanceType<typeof UiDialog>['$props'], slots?: Record<string, string>) =>
  mount(UiDialog, { props, slots, attachTo: document.body })

enableAutoUnmount(afterEach)

describe('UiDialog', () => {
  it('renders title + body when open', () => {
    const w = mountDialog({ open: true, title: 'Hello' }, { default: '<p>Body here</p>' })
    expect(w.text()).toContain('Hello')
    expect(w.text()).toContain('Body here')
  })
  // reka points `aria-labelledby` at the DialogTitle by id, so the accessible name only exists if that
  // id resolves in the document — the same lookup screen readers and reka's own dev check perform.
  it('names the dialog by its title through an id that resolves in the document', () => {
    const w = mountDialog({ open: true, title: 'Hello' }, { default: '<p>Body here</p>' })
    const labelledBy = w.find('[role="dialog"]').attributes('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Hello')
  })

  it('does not render the body when closed', () => {
    const w = mountDialog({ open: false, title: 'Hidden' }, { default: '<p>SecretBody</p>' })
    expect(w.text()).not.toContain('SecretBody')
  })
  it('emits update:open=false when the close button is clicked', async () => {
    const w = mountDialog({ open: true, title: 'X' })
    await w.find('[data-test="dialog-close"]').trigger('click')
    expect(w.emitted('update:open')?.at(-1)).toEqual([false])
  })
  it('applies the lg size class when size="lg"', () => {
    const w = mountDialog({ open: true, title: 'X', size: 'lg' }, { default: '<p>body</p>' })
    expect(w.find('.ui-dialog__content--lg').exists()).toBe(true)
  })
  it('defaults to the md size class (existing dialogs unchanged)', () => {
    const w = mountDialog({ open: true, title: 'X' }, { default: '<p>body</p>' })
    expect(w.find('.ui-dialog__content--md').exists()).toBe(true)
  })

  // The dialog renders in place, so its inputs are form-associated with any ancestor form (the record
  // editor): Enter in a text input would implicitly submit it — saving the half-edited record from
  // inside a picker. The dialog swallows that default; Enter on buttons must keep working.
  it('prevents Enter in text-entry inputs from implicitly submitting an ancestor form', () => {
    const w = mountDialog(
      { open: true, title: 'X' },
      { default: '<input data-test="inner-text" type="text"><input data-test="inner-search" type="search">' },
    )
    for (const sel of ['[data-test="inner-text"]', '[data-test="inner-search"]']) {
      const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      w.find(sel).element.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(true)
    }
  })

  it('leaves Enter alone on buttons and non-text inputs', () => {
    const w = mountDialog(
      { open: true, title: 'X' },
      { default: '<button data-test="inner-btn" type="button">ok</button><input data-test="inner-check" type="checkbox">' },
    )
    for (const sel of ['[data-test="inner-btn"]', '[data-test="inner-check"]']) {
      const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      w.find(sel).element.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)
    }
  })
})
