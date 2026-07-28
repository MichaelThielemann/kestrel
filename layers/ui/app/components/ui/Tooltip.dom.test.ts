import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UiTooltip from './Tooltip.vue'

// happy-dom does not render Reka's teleported (portaled) tooltip content, and the panel only opens on
// hover/focus anyway — so this is a presence smoke test: the trigger slot renders and mounting the Reka
// Provider/Root/Trigger/Portal stack does not throw. The content rendering is covered by the editor's
// live-ampel behaviour (the load-bearing logic lives in EditorStatus, tested there + in e2e).
describe('UiTooltip', () => {
  it('renders the default (trigger) slot without throwing', () => {
    const w = mount(UiTooltip, { slots: { default: '<button>hover me</button>', content: '<span>tip text</span>' } })
    expect(w.find('button').exists()).toBe(true)
    expect(w.text()).toContain('hover me')
  })

  it('mounts with the default props (closed → no visible content)', () => {
    const w = mount(UiTooltip, { slots: { default: '<button>trigger</button>' } })
    expect(w.find('button').exists()).toBe(true)
  })
})
