import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import KestrelImg from './KestrelImg.vue'

const media = {
  id: 1, alt: 'Cat', title: null, description: null, mime: 'image/jpeg', width: 800, height: 600, thumbhash: null,
  src: '/uploads/hero.jpg', srcset: [],
  variants: [
    { name: 'w320', format: 'webp', url: '/u/w320.webp', width: 320, height: 240 },
    { name: 'w320', format: 'jpeg', url: '/u/w320.jpeg', width: 320, height: 240 },
    { name: 'w640', format: 'webp', url: '/u/w640.webp', width: 640, height: 480 },
    { name: 'w640', format: 'jpeg', url: '/u/w640.jpeg', width: 640, height: 480 },
  ],
}

describe('KestrelImg', () => {
  it('renders a <picture> with a <source> per format (webp before jpeg) + a fallback <img>', () => {
    const w = mount(KestrelImg, { props: { media, widths: [320, 640], formats: ['webp', 'jpeg'], sizes: '50vw' } })
    const sources = w.findAll('source')
    expect(sources).toHaveLength(2)
    expect(sources[0]!.attributes('type')).toBe('image/webp')
    expect(sources[0]!.attributes('srcset')).toBe('/u/w320.webp 320w, /u/w640.webp 640w')
    expect(sources[1]!.attributes('type')).toBe('image/jpeg')
    const img = w.find('img')
    expect(img.attributes('src')).toBe('/u/w640.jpeg') // largest of the most-compatible format
    expect(img.attributes('sizes')).toBe('50vw')
    expect(img.attributes('loading')).toBe('lazy')
    expect(img.attributes('alt')).toBe('Cat')
  })

  it('marks a priority image eager with high fetchpriority (and no sizes=auto)', () => {
    const w = mount(KestrelImg, { props: { media, widths: [320], formats: ['webp'], priority: true } })
    const img = w.find('img')
    expect(img.attributes('loading')).toBe('eager')
    expect(img.attributes('fetchpriority')).toBe('high')
    expect(img.attributes('sizes')).toBeUndefined()
  })

  it('degrades to no <source>s + the original src when the variants are not generated yet', () => {
    const w = mount(KestrelImg, { props: { media: { ...media, variants: [] }, widths: [320] } })
    expect(w.findAll('source')).toHaveLength(0)
    expect(w.find('img').attributes('src')).toBe('/uploads/hero.jpg')
  })
})

describe('KestrelImg — optional EU AI Act badge', () => {
  const disclosed = { ...media, aiDisclosure: { sourceType: 'trainedAlgorithmicMedia', note: 'Midjourney v7' } }
  const badge = (props: Record<string, unknown>) => mount(KestrelImg, { props: { widths: [320], ...props } }).find('.kestrel-img__ai-badge')

  it('renders NOTHING unless the consumer explicitly asks for it', () => {
    // Kestrel must never surface a disclosure the consumer did not opt into.
    expect(badge({ media: disclosed }).exists()).toBe(false)
    expect(badge({ media: disclosed, aiBadge: false }).exists()).toBe(false)
  })

  it('renders nothing when asked for but the asset carries no disclosure', () => {
    expect(badge({ media, aiBadge: true }).exists()).toBe(false)
    expect(badge({ media: { ...media, aiDisclosure: null }, aiBadge: true }).exists()).toBe(false)
  })

  it('renders the editor note, tagged with the machine-readable source type', () => {
    const el = badge({ media: disclosed, aiBadge: true })
    expect(el.exists()).toBe(true)
    expect(el.attributes('data-ai-source-type')).toBe('trainedAlgorithmicMedia')
    expect(el.text()).toBe('Midjourney v7')
  })

  it('falls back to a readable label when no note was entered', () => {
    const el = badge({ media: { ...media, aiDisclosure: { sourceType: 'algorithmicallyEnhanced', note: null } }, aiBadge: true })
    expect(el.text()).toBe('AI-edited')
  })

  it('carries no inline styling — the consumer\'s stylesheet is the only thing that designs it', () => {
    const el = badge({ media: disclosed, aiBadge: true })
    expect(el.attributes('style')).toBeUndefined()
    // one stable, documented hook to target; no utility/theme classes baked in
    expect(el.classes()).toEqual(['kestrel-img__ai-badge'])
  })

  it('sits inside the <picture>, so it can be positioned over the image', () => {
    const w = mount(KestrelImg, { props: { media: disclosed, widths: [320], aiBadge: true } })
    expect(w.find('picture > .kestrel-img__ai-badge').exists()).toBe(true)
  })
})
