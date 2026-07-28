import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import Hero from './Hero.vue'
import Prose from './Prose.vue'

// Block SFCs use auto-imported field factories + defineBlock, so they mount only in a Nuxt context — this
// test doubles as the check that that auto-import path works. MediaImage is stubbed to keep the image
// assertion simple; KestrelLink resolves for real (the CTA rendering is genuine).
const MediaImageStub = { name: 'MediaImage', props: ['media'], template: '<img class="stub" :src="media.src">' }
const opts = { global: { stubs: { MediaImage: MediaImageStub } } }

describe('Hero block SFC', () => {
  it('renders the heading', async () => {
    const w = await mountSuspended(Hero, { props: { heading: 'Welcome' }, ...opts })
    expect(w.get('h1').text()).toBe('Welcome')
    expect(w.find('img').exists()).toBe(false)
  })

  it('renders a MediaImage when the resolved media bag has an image', async () => {
    const w = await mountSuspended(Hero, {
      props: { heading: 'Hi', image: 7, media: { image: { src: '/uploads/x.webp' } } },
      ...opts,
    })
    expect(w.get('img.stub').attributes('src')).toBe('/uploads/x.webp')
  })

  it('renders default slot content (its declared "default" slot, for nested blocks)', async () => {
    const w = await mountSuspended(Hero, { props: { heading: 'Hi' }, slots: { default: () => 'child' }, ...opts })
    expect(w.text()).toContain('child')
  })

  it('renders a CTA <a href> from a resolved internal link value', async () => {
    const w = await mountSuspended(Hero, {
      props: { heading: 'Hi', cta: { type: 'internal', collection: 'pages', id: 5, label: 'About', href: '/about' } },
      ...opts,
    })
    const a = w.get('a.kestrel-link')
    expect(a.attributes('href')).toBe('/about')
    expect(a.text()).toBe('About')
  })

  it('renders no CTA link when cta is absent', async () => {
    const w = await mountSuspended(Hero, { props: { heading: 'Hi' }, ...opts })
    expect(w.find('a.kestrel-link').exists()).toBe(false)
  })
})

describe('Prose block SFC', () => {
  it('renders sanitized body html', async () => {
    const w = await mountSuspended(Prose, { props: { body: '<p>Hello <strong>world</strong></p>' } })
    expect(w.get('.block-prose').html()).toContain('<strong>world</strong>')
  })
})
