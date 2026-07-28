import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UiMenu from './Menu.vue'

describe('UiMenu', () => {
  it('renders the right-clickable trigger slot', () => {
    const w = mount(UiMenu, {
      props: { items: [{ label: 'Delete', value: 'delete', danger: true }] },
      slots: { default: '<div data-test="area">area</div>' },
    })
    expect(w.find('[data-test="area"]').exists()).toBe(true)
  })
})
