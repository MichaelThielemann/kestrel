import { describe, it, expect, beforeEach } from 'vitest'
import { computed, defineComponent, h, provide } from 'vue'
import { useState } from '#imports'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import BlockPreview from './BlockPreview.vue'
import { editorFormContextKey } from '../utils/editor-form-context'
import { PREVIEW_FALLBACK_PATH, PREVIEW_QUERY } from '../../../public/app/utils/preview-protocol'

// The host still resolves media/links (the populated tree is what it POSTS into the iframe), so the
// endpoints stay mocked; rendering itself happens inside the iframe document (covered by the
// KestrelPreviewBridge dom tests + e2e), so these tests assert the host: iframe src + the viewport
// toolbar (refresh, device presets, custom W×H). Scaling is always automatic (two-axis fit) — its pixel
// math + Auto-height fill live in preview-viewport.test.ts; here availW/availH stay 0 (no real layout),
// so Auto height resolves to its 900 fallback and we assert wiring, not pixel scale.
registerEndpoint('/api/blocks', () => ({
  data: [
    { name: 'hero', label: 'Hero', slots: ['default'], fields: { heading: { type: 'text', required: true }, image: { type: 'media', options: { accept: 'image' } } } },
    { name: 'prose', label: 'Prose', fields: { body: { type: 'richtext', required: true } } },
  ],
}))
registerEndpoint('/api/media/resolve', () => ({ data: [] }))

beforeEach(() => {
  useState('kestrel-blocks').value = null
  // The viewport (device/W×H/fit) persists to a cookie — clear it so each test starts at the defaults.
  document.cookie = 'kestrel-preview-viewport=; path=/; max-age=0'
})

// mountSuspended merges `global.provide` with defu, which drops symbol keys — provide via a wrapper
// component instead (only `previewUrl` is read by the host, so a partial context stub suffices).
const HostWithUrl = defineComponent({
  props: { url: { type: String, required: true } },
  setup(props) {
    provide(editorFormContextKey, { previewUrl: computed(() => props.url) } as never)
    return () => h(BlockPreview, { content: [], locale: 'en' })
  },
})

// A reactive `values.layout` stand-in for the shell's context — mirrors the `layout` key read by
// BlockPreview's own reload watcher, nothing else.
const HostWithLayout = defineComponent({
  props: { url: { type: String, required: true }, layout: { type: String, default: '' } },
  setup(props) {
    provide(editorFormContextKey, {
      previewUrl: computed(() => props.url),
      values: { get layout() { return props.layout } },
    } as never)
    return () => h(BlockPreview, { content: [], locale: 'en' })
  },
})

describe('BlockPreview (iframe live-preview host)', () => {
  it('mounts an iframe on the dedicated fallback page (with locale) when the record has no public URL', async () => {
    const w = await mountSuspended(BlockPreview, { props: { content: [], locale: 'de' } })
    await flushPromises()
    const frame = w.find('iframe.block-preview__frame')
    expect(frame.exists()).toBe(true)
    expect(frame.attributes('src')).toBe(`${PREVIEW_FALLBACK_PATH}?${PREVIEW_QUERY}=1&locale=de`)
  })

  it('mounts the iframe on the record public URL (preview-flagged) when the shell provides one', async () => {
    const w = await mountSuspended(HostWithUrl, { props: { url: '/about' } })
    await flushPromises()
    expect(w.find('iframe').attributes('src')).toBe(`/about?${PREVIEW_QUERY}=1`)
  })

  it('forces a fresh navigation when the page-fields layout changes (the layout wraps the frame, out of the postMessage bridge\'s reach)', async () => {
    const w = await mountSuspended(HostWithLayout, { props: { url: '/about', layout: '' } })
    await flushPromises()
    const before = w.find('iframe').attributes('src')
    expect(before).toBe(`/about?${PREVIEW_QUERY}=1`)

    await w.setProps({ layout: 'alt' })
    await flushPromises()
    const after = w.find('iframe').attributes('src')
    expect(after).not.toBe(before)
    expect(after).toMatch(new RegExp(`^/about\\?${PREVIEW_QUERY}=1&_r=\\d+$`))
  })

  it('renders the frame at a preset resolution (real px) when a device is quick-selected', async () => {
    const w = await mountSuspended(BlockPreview, { props: { content: [] } })
    await flushPromises()
    const presets = w.findAll('.block-preview__group[role="group"] .ui-button')
    expect(presets).toHaveLength(3)
    const style = () => w.find('iframe').attributes('style') ?? ''
    // default desktop preset = config default 1440 × 900
    expect(style()).toContain('width: 1440px')
    expect(style()).toContain('height: 900px')
    await presets[1]!.trigger('click') // tablet
    expect(style()).toContain('width: 768px')
    expect(style()).toContain('height: 1024px')
    await presets[2]!.trigger('click') // mobile
    expect(style()).toContain('width: 390px')
    expect(style()).toContain('height: 844px')
  })

  it('renders a refresh button (no aria-pressed) leading the toolbar cluster', async () => {
    const w = await mountSuspended(BlockPreview, { props: { content: [] } })
    await flushPromises()
    // Refresh is the leading button in the tools cluster; reloading is a no-op in the test env (no live
    // iframe document) but the try/catch must swallow it and the click must not throw.
    const refresh = w.find('.block-preview__bar .ui-button')
    expect(refresh.attributes('aria-label')).toBe('Refresh preview')
    expect(refresh.attributes('aria-pressed')).toBeUndefined()
    await refresh.trigger('click')
  })

  it('highlights the active preset (scaling is automatic — no fit toggle button)', async () => {
    const w = await mountSuspended(BlockPreview, { props: { content: [] } })
    await flushPromises()
    // Bar buttons = 1 refresh + 3 presets (scale is always automatic).
    expect(w.findAll('.block-preview__bar .ui-button')).toHaveLength(4)
    const presets = () => w.findAll('.block-preview__group[role="group"] .ui-button')
    const pressed = () => presets().map((b) => b.attributes('aria-pressed'))
    expect(pressed()).toEqual(['true', 'false', 'false']) // desktop active by default
    await presets()[2]!.trigger('click') // select mobile
    expect(pressed()).toEqual(['false', 'false', 'true'])
  })

  it('seeds the W×H inputs from the resolution; committing a custom size drives the frame + de-selects presets', async () => {
    const w = await mountSuspended(BlockPreview, { props: { content: [] } })
    await flushPromises()
    const inputs = w.findAll('.block-preview__dims input')
    expect(inputs).toHaveLength(2)
    // Desktop: width is the fixed config breakpoint; height is Auto (fills the pane) → the field is empty
    // with an "Auto" placeholder rather than a number.
    expect((inputs[0]!.element as HTMLInputElement).value).toBe('1440')
    expect((inputs[1]!.element as HTMLInputElement).value).toBe('')
    expect(inputs[1]!.attributes('placeholder')).toBe('Auto')
    // type a custom width and commit on change (blur/Enter)
    await inputs[0]!.setValue('1024')
    await inputs[0]!.trigger('change')
    await flushPromises()
    expect(w.find('iframe').attributes('style') ?? '').toContain('width: 1024px')
    // 1024×900 matches no preset → every quick-select button is unpressed
    const presetPressed = w.findAll('.block-preview__group[role="group"] .ui-button').map((b) => b.attributes('aria-pressed'))
    expect(presetPressed).toEqual(['false', 'false', 'false'])
  })

  it('clearing a dim field returns that axis to Auto (so the presets are not the only way back)', async () => {
    const w = await mountSuspended(BlockPreview, { props: { content: [] } })
    await flushPromises()
    const inputs = w.findAll('.block-preview__dims input')
    const pressed = () => w.findAll('.block-preview__group[role="group"] .ui-button').map((b) => b.attributes('aria-pressed'))

    // Pin the height → 1440×800 is a custom size, no preset matches.
    await inputs[1]!.setValue('800')
    await inputs[1]!.trigger('change')
    await flushPromises()
    expect((inputs[1]!.element as HTMLInputElement).value).toBe('800')
    expect(pressed()).toEqual(['false', 'false', 'false'])

    // Emptying it hands the axis back to Auto → 1440 × auto is the Desktop preset again.
    await inputs[1]!.setValue('')
    await inputs[1]!.trigger('change')
    await flushPromises()
    expect((inputs[1]!.element as HTMLInputElement).value).toBe('')
    expect(inputs[1]!.attributes('placeholder')).toBe('Auto')
    expect(pressed()).toEqual(['true', 'false', 'false'])

    // The width axis behaves the same way.
    await inputs[0]!.setValue('')
    await inputs[0]!.trigger('change')
    await flushPromises()
    expect((inputs[0]!.element as HTMLInputElement).value).toBe('')
    expect(inputs[0]!.attributes('placeholder')).toBe('Auto')
  })
})
