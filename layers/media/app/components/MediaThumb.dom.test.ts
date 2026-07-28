import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { rgbaToThumbHash } from 'thumbhash'
import MediaThumb from './MediaThumb.vue'

// The blur-up contract hinges on img.complete at mount, and happy-dom's default flipped between
// minors (20.9 false → 20.10 true) — pin it so the tests own the contract, not the environment.
const imgProto = window.HTMLImageElement.prototype
const originalComplete = Object.getOwnPropertyDescriptor(imgProto, 'complete')
beforeEach(() => { Object.defineProperty(imgProto, 'complete', { configurable: true, get: () => false }) })
afterEach(() => {
  if (originalComplete) Object.defineProperty(imgProto, 'complete', originalComplete)
  else Reflect.deleteProperty(imgProto, 'complete')
})

function makeThumbhash(): string {
  const w = 4, h = 4
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 120; rgba[i * 4 + 1] = 160; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 255 }
  let bin = ''
  for (const b of rgbaToThumbHash(w, h, rgba)) bin += String.fromCharCode(b)
  return btoa(bin)
}

describe('MediaThumb', () => {
  it('forwards src/srcset/sizes/alt to a lazy <img>', () => {
    const w = mount(MediaThumb, { props: { src: '/u/a', srcset: '/u/a-320.webp 320w', sizes: '160px', alt: 'A pic' } })
    const img = w.get('img')
    expect(img.attributes('src')).toBe('/u/a')
    expect(img.attributes('srcset')).toBe('/u/a-320.webp 320w')
    expect(img.attributes('sizes')).toBe('160px')
    expect(img.attributes('alt')).toBe('A pic')
    expect(img.attributes('loading')).toBe('lazy')
  })
  it('emits an empty alt (decorative) when alt is omitted', () => {
    expect(mount(MediaThumb, { props: { src: '/u/a' } }).get('img').attributes('alt')).toBe('')
  })
  it('shows the thumbhash placeholder, then drops it once the image loads', async () => {
    const w = mount(MediaThumb, { props: { src: '/u/a', thumbhash: makeThumbhash() } })
    await nextTick() // placeholder is decoded client-side on mount (kept out of SSR HTML)
    expect(w.get('img').attributes('style') ?? '').toContain('background-image')
    await w.get('img').trigger('load')
    expect(w.get('img').attributes('style') ?? '').not.toContain('background-image')
  })
  it('renders no placeholder background when there is no thumbhash', () => {
    expect(mount(MediaThumb, { props: { src: '/u/a' } }).get('img').attributes('style') ?? '').not.toContain('background-image')
  })
  it('does NOT apply the sharpen-in animation class (placeholder-only — no blur bleed between grid tiles)', async () => {
    const w = mount(MediaThumb, { props: { src: '/u/a', thumbhash: makeThumbhash() } })
    await w.get('img').trigger('load')
    expect(w.get('img').classes()).not.toContain('media-image--in')
  })
})
