import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, inject, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import KestrelPreviewBridge from './KestrelPreviewBridge.vue'
import { blockEditKey } from '../utils/block-edit-context'
import { contentMessage, selectedMessage } from '../utils/preview-protocol'

// A probe standing in for BlockRenderer: shows the received tree + the injected edit context, and
// exercises the click paths (a marker-style select button + a plain anchor for the nav interception).
const Probe = defineComponent({
  props: { blocks: { type: Array, default: () => [] } },
  setup(props) {
    const edit = inject(blockEditKey, null)
    return () =>
      h('div', [
        h('p', { class: 'probe-blocks' }, JSON.stringify(props.blocks)),
        h('p', { class: 'probe-selected' }, String(edit?.selectedId.value ?? 'none')),
        h('button', { class: 'probe-select', onClick: () => edit?.select('b1') }, 'select'),
        h('a', { class: 'probe-link', href: '/somewhere' }, 'nav'),
      ])
  },
})

const mountBridge = (blocks: unknown[] = []) =>
  mount(KestrelPreviewBridge, {
    props: { blocks },
    slots: { default: (p: { blocks: unknown[] }) => h(Probe, { blocks: p.blocks }) },
    attachTo: document.body,
  })

// Dispatch as the embedding editor would arrive: same origin, source = window.parent (== window here).
const dispatch = (data: unknown) =>
  window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin, source: window }))

describe('KestrelPreviewBridge', () => {
  it('renders the initial (server) blocks until the first content message, then the live tree', async () => {
    const w = mountBridge([{ id: 's', type: 'hero', props: { heading: 'saved' } }])
    expect(w.find('.probe-blocks').text()).toContain('saved')
    dispatch(contentMessage([{ id: 's', type: 'hero', props: { heading: 'live!' } }], null))
    await nextTick()
    expect(w.find('.probe-blocks').text()).toContain('live!')
    expect(w.find('.probe-blocks').text()).not.toContain('saved')
    w.unmount()
  })

  it('ignores foreign-origin and foreign-shape messages', async () => {
    const w = mountBridge([{ id: 's', type: 'hero', props: { heading: 'saved' } }])
    window.dispatchEvent(new MessageEvent('message', {
      data: contentMessage([{ id: 'x', type: 'hero', props: { heading: 'evil' } }], null),
      origin: 'https://evil.example', source: window,
    }))
    dispatch({ type: 'vite:ping' })
    await nextTick()
    expect(w.find('.probe-blocks').text()).toContain('saved')
    w.unmount()
  })

  it('applies a selection message to the provided edit context', async () => {
    const w = mountBridge()
    expect(w.find('.probe-selected').text()).toBe('none')
    dispatch(selectedMessage('b7'))
    await nextTick()
    expect(w.find('.probe-selected').text()).toBe('b7')
    dispatch(selectedMessage(null))
    await nextTick()
    expect(w.find('.probe-selected').text()).toBe('none')
    w.unmount()
  })

  it('posts ready on mount and select up to the parent when a block is clicked', async () => {
    const posted: unknown[] = []
    const spy = vi.spyOn(window, 'postMessage').mockImplementation(((msg: unknown) => { posted.push(msg) }) as never)
    const w = mountBridge()
    expect(posted).toContainEqual({ kestrel: 'preview:ready' })
    await w.find('.probe-select').trigger('click')
    expect(posted).toContainEqual({ kestrel: 'preview:select', id: 'b1' })
    // the click also highlights locally, without waiting for the editor echo
    expect(w.find('.probe-selected').text()).toBe('b1')
    w.unmount()
    spy.mockRestore()
  })

  it('swallows link navigation (capture-phase preventDefault) so the preview never navigates away', () => {
    const w = mountBridge()
    const a = w.find('.probe-link').element as HTMLAnchorElement
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    w.unmount()
  })

  it('swallows form submission the same way (a consumer form must not navigate the canvas)', () => {
    const w = mountBridge()
    const form = document.createElement('form')
    document.body.appendChild(form)
    const ev = new Event('submit', { bubbles: true, cancelable: true })
    form.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    form.remove()
    w.unmount()
  })
})
