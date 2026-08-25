import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { rgbaToThumbHash } from 'thumbhash'
import MediaImage from './MediaImage.vue'

// The blur-up contract hinges on img.complete at mount, and happy-dom's default flipped between
// minors (20.9 false → 20.10 true) — pin it so the tests own the contract, not the environment.
const imgProto = window.HTMLImageElement.prototype
const originalComplete = Object.getOwnPropertyDescriptor(imgProto, 'complete')
beforeEach(() => { Object.defineProperty(imgProto, 'complete', { configurable: true, get: () => false }) })
afterEach(() => {
  if (originalComplete) Object.defineProperty(imgProto, 'complete', originalComplete)
  else Reflect.deleteProperty(imgProto, 'complete')
})

// A real thumbhash (base64), exactly as the server stores it (derive.ts). The colour is parameterised so
// a test can produce a DISTINCT hash (a different image) to exercise the reactive media swap.
function makeThumbhash(r = 120, g = 160, b = 200): string {
  const w = 4, h = 4
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255 }
  const bytes = rgbaToThumbHash(w, h, rgba)
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin)
}

const base = {
  id: 1, mime: 'image/webp', title: null, description: null, thumbhash: null,
  width: 1280, height: 720, src: '/uploads/a/hero.webp',
  srcset: [
    { url: '/uploads/a/hero-640.webp', width: 640 },
    { url: '/uploads/a/hero-1280.webp', width: 1280 },
  ],
}

describe('MediaImage', () => {
  it('renders src, joined srcset, dimensions and alt', () => {
    const w = mount(MediaImage, { props: { media: { ...base, alt: 'A hero' } } })
    const img = w.get('img')
    expect(img.attributes('src')).toBe('/uploads/a/hero.webp')
    expect(img.attributes('srcset')).toBe('/uploads/a/hero-640.webp 640w, /uploads/a/hero-1280.webp 1280w')
    expect(img.attributes('width')).toBe('1280')
    expect(img.attributes('height')).toBe('720')
    expect(img.attributes('alt')).toBe('A hero')
    expect(img.attributes('loading')).toBe('lazy')
  })
  it('emits an empty alt (decorative) when alt is null', () => {
    const w = mount(MediaImage, { props: { media: { ...base, alt: null } } })
    expect(w.get('img').attributes('alt')).toBe('')
  })
  it('omits srcset when there are no derivatives', () => {
    const w = mount(MediaImage, { props: { media: { ...base, alt: null, srcset: [] } } })
    expect(w.get('img').attributes('srcset')).toBeUndefined()
  })
  it('recomputes srcset when the media prop is swapped (reactive — the live preview reuses this instance)', async () => {
    // The public BlockRenderer (reused in the admin preview) keys blocks by id and carousels key slides by
    // index, so a media reorder/replace only patches `media`. A captured-const srcset would keep the
    // browser painting the OLD image via its stale candidate set; a computed must re-derive it.
    const w = mount(MediaImage, { props: { media: { ...base, alt: null } } })
    expect(w.get('img').attributes('srcset')).toBe('/uploads/a/hero-640.webp 640w, /uploads/a/hero-1280.webp 1280w')
    await w.setProps({ media: { ...base, alt: null, src: '/uploads/b/hero.webp', srcset: [{ url: '/uploads/b/hero-640.webp', width: 640 }] } })
    expect(w.get('img').attributes('srcset')).toBe('/uploads/b/hero-640.webp 640w')
  })
  it('passes a layout-supplied sizes through to the img', () => {
    const w = mount(MediaImage, { props: { media: { ...base, alt: 'A hero' }, sizes: '(min-width: 768px) 50vw, 100vw' } })
    expect(w.get('img').attributes('sizes')).toBe('(min-width: 768px) 50vw, 100vw')
  })
  it('omits sizes when the layout does not supply one', () => {
    const w = mount(MediaImage, { props: { media: { ...base, alt: null } } })
    expect(w.get('img').attributes('sizes')).toBeUndefined()
  })
  it('renders a thumbhash blur-up placeholder when thumbhash is set', async () => {
    const w = mount(MediaImage, { props: { media: { ...base, alt: null, thumbhash: makeThumbhash() } } })
    await nextTick() // placeholder is decoded client-side on mount (kept out of SSR HTML)
    const style = w.get('img').attributes('style') ?? ''
    expect(style).toContain('background-image')
    expect(style).toContain('data:image/png')
  })
  it('renders no placeholder background when thumbhash is null', () => {
    const w = mount(MediaImage, { props: { media: { ...base, alt: null, thumbhash: null } } })
    const style = w.get('img').attributes('style') ?? ''
    expect(style).not.toContain('background-image')
  })
  it('defaults to lazy loading with no fetchpriority (below-the-fold)', () => {
    const img = mount(MediaImage, { props: { media: { ...base, alt: null } } }).get('img')
    expect(img.attributes('loading')).toBe('lazy')
    expect(img.attributes('fetchpriority')).toBeUndefined()
  })
  it('priority: eager loading + fetchpriority=high (the LCP / above-the-fold image)', () => {
    const img = mount(MediaImage, { props: { media: { ...base, alt: null }, priority: true } }).get('img')
    expect(img.attributes('loading')).toBe('eager')
    expect(img.attributes('fetchpriority')).toBe('high')
  })
  it('sharpens in on a real (async) load: no animation class before load, present after, placeholder dropped', async () => {
    const w = mount(MediaImage, { props: { media: { ...base, alt: null, thumbhash: makeThumbhash() } } })
    await nextTick() // the thumbhash placeholder is decoded client-side on mount (kept out of SSR HTML)
    expect(w.get('img').classes()).not.toContain('media-image--in')
    expect(w.get('img').attributes('style') ?? '').toContain('background-image')
    // A genuine async load triggers the one-shot sharpen-in and drops the placeholder.
    await w.get('img').trigger('load')
    expect(w.get('img').classes()).toContain('media-image--in')
    expect(w.get('img').attributes('style') ?? '').not.toContain('background-image')
  })
  it('restarts the blur-up when the image is swapped (reactive media change, e.g. the live preview)', async () => {
    // The public BlockRenderer (reused in the admin preview) keys blocks by id, so editing a block's
    // image reuses this MediaImage instance instead of remounting — the blur-up must reset for the new image.
    const w = mount(MediaImage, { props: { media: { ...base, alt: null, thumbhash: makeThumbhash() } } })
    await w.get('img').trigger('load')
    expect(w.get('img').classes()).toContain('media-image--in')
    await w.setProps({ media: { ...base, alt: null, src: '/uploads/b/other.webp', thumbhash: makeThumbhash(200, 90, 40) } })
    await flushPromises()
    expect(w.get('img').classes()).not.toContain('media-image--in')
    expect(w.get('img').attributes('style') ?? '').toContain('background-image')
  })
  it('does NOT sharpen a cached image (already complete at mount) — no blur flash on revisit', async () => {
    // Override the suite-wide complete=false pin: force true so onMounted takes the cached short-circuit.
    const proto = window.HTMLImageElement.prototype
    const orig = Object.getOwnPropertyDescriptor(proto, 'complete')
    Object.defineProperty(proto, 'complete', { configurable: true, get: () => true })
    try {
      const w = mount(MediaImage, { props: { media: { ...base, alt: null, thumbhash: makeThumbhash() } } })
      await flushPromises()
      expect(w.get('img').attributes('style') ?? '').not.toContain('background-image')
      await w.get('img').trigger('load') // a cached image may still fire load — must not arm the animation
      expect(w.get('img').classes()).not.toContain('media-image--in')
    } finally {
      if (orig) Object.defineProperty(proto, 'complete', orig)
      else Reflect.deleteProperty(proto, 'complete')
    }
  })
})
