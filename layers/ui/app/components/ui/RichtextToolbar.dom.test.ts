import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RichtextToolbar from './RichtextToolbar.vue'

// A chainable mock editor that records the command names invoked on it. It proves the toolbar ISSUES a
// command, never that a real editor honours it — a command the schema rejects is recorded identically.
// Anything about the resulting document belongs in `richtext.dom.test.ts`, which drives a real instance.
type ChainMock = Record<string, (...args: unknown[]) => ChainMock>

function createMockEditor(attrs: Record<string, unknown> = {}) {
  const calls: string[] = []
  const chain: ChainMock = new Proxy({} as ChainMock, {
    get(_t, prop) {
      if (prop === 'run') return () => { calls.push('run') }
      return (...args: unknown[]) => {
        calls.push(String(prop) + (args.length ? `:${JSON.stringify(args)}` : ''))
        return chain
      }
    },
  })
  return {
    calls,
    isActive: () => false,
    can: () => ({ undo: () => true, redo: () => true }),
    getAttributes: () => attrs,
    chain: () => chain,
    on: () => {},
    off: () => {},
  }
}

describe('RichtextToolbar', () => {
  it('renders nothing without an editor', () => {
    const w = mount(RichtextToolbar, { props: { editor: undefined } })
    expect(w.find('.ui-rt-toolbar').exists()).toBe(false)
  })

  it('renders the controls when given an editor', () => {
    const w = mount(RichtextToolbar, { props: { editor: createMockEditor() as never } })
    expect(w.find('[aria-label="Block type"]').exists()).toBe(true)
    expect(w.find('[aria-label="Bold"]').exists()).toBe(true)
    expect(w.find('[aria-label="Highlight"]').exists()).toBe(true)
    expect(w.find('[aria-label="Align center"]').exists()).toBe(true)
    expect(w.find('[aria-label="Undo"]').exists()).toBe(true)
  })

  it('runs the bold command on click', async () => {
    const e = createMockEditor()
    const w = mount(RichtextToolbar, { props: { editor: e as never } })
    await w.find('[aria-label="Bold"]').trigger('click')
    expect(e.calls).toContain('toggleBold')
    expect(e.calls).toContain('run')
  })

  it('sets text alignment on click', async () => {
    const e = createMockEditor()
    const w = mount(RichtextToolbar, { props: { editor: e as never } })
    await w.find('[aria-label="Align center"]').trigger('click')
    expect(e.calls.some((c) => c.startsWith('setTextAlign'))).toBe(true)
  })

  it('changes the block type via the select', async () => {
    const e = createMockEditor()
    const w = mount(RichtextToolbar, { props: { editor: e as never } })
    await w.find('[aria-label="Block type"]').setValue('h2')
    expect(e.calls.some((c) => c.startsWith('toggleHeading'))).toBe(true)
  })

  // The internal-link picker is teleported/$fetch-driven (not renderable in happy-dom), so stub it and
  // assert the load-bearing glue: a picked record becomes a `kestrel:` marker on a normal link mark.
  const PickerStub = {
    name: 'LinkInternalPicker',
    props: ['collection', 'recordId', 'collections', 'locale', 'disabled', 'inputId', 'invalid', 'describedby', 'required'],
    emits: ['update:collection', 'update:recordId'],
    template: `<button class="pick" @click="$emit('update:collection','pages'); $emit('update:recordId', 5)">pick</button>`,
  }

  it('reveals an internal-link picker and inserts a kestrel: marker on apply', async () => {
    const e = createMockEditor()
    const w = mount(RichtextToolbar, { props: { editor: e as never, locale: 'en' }, global: { stubs: { LinkInternalPicker: PickerStub } } })
    expect(w.find('[aria-label="Internal link"]').exists()).toBe(true)
    await w.find('[aria-label="Internal link"]').trigger('click')
    expect(w.find('.pick').exists()).toBe(true)
    await w.find('.pick').trigger('click')
    await w.findAll('button').find((b) => b.text() === 'Apply')!.trigger('click')
    expect(e.calls).toContain('setLink:[{"href":"kestrel:pages:5"}]')
    expect(e.calls).toContain('extendMarkRange:["link"]')
  })

  it('prefills the picker from the marker under the cursor when re-editing an internal link', async () => {
    const e = createMockEditor({ href: 'kestrel:posts:9' })
    const w = mount(RichtextToolbar, { props: { editor: e as never, locale: 'en' }, global: { stubs: { LinkInternalPicker: PickerStub } } })
    await w.find('[aria-label="Internal link"]').trigger('click')
    const picker = w.findComponent(PickerStub)
    expect(picker.props('collection')).toBe('posts')
    expect(picker.props('recordId')).toBe(9)
  })

  it('opens the picker blank for an external/absent link', async () => {
    const e = createMockEditor({ href: 'https://x.io' })
    const w = mount(RichtextToolbar, { props: { editor: e as never, locale: 'en' }, global: { stubs: { LinkInternalPicker: PickerStub } } })
    await w.find('[aria-label="Internal link"]').trigger('click')
    const picker = w.findComponent(PickerStub)
    expect(picker.props('collection')).toBeNull()
    expect(picker.props('recordId')).toBeNull()
  })
})
