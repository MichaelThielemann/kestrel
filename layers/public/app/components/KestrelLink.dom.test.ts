import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import KestrelLink from './KestrelLink.vue'

describe('KestrelLink', () => {
  it('renders an external link with href, label, and a safe target/rel', () => {
    const w = mount(KestrelLink, { props: { value: { type: 'external', url: 'https://x.io', label: 'Home' } } })
    const a = w.get('a')
    expect(a.attributes('href')).toBe('https://x.io')
    expect(a.text()).toBe('Home')
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toContain('noopener')
  })

  it('renders an email link without target/rel', () => {
    const w = mount(KestrelLink, { props: { value: { type: 'email', email: 'a@b.io' } } })
    expect(w.get('a').attributes('href')).toBe('mailto:a@b.io')
    expect(w.get('a').attributes('target')).toBeUndefined()
  })

  it('renders nothing for a null value', () => {
    const w = mount(KestrelLink, { props: { value: null } })
    expect(w.find('a').exists()).toBe(false)
  })

  it('lets a default slot override the label', () => {
    const w = mount(KestrelLink, { props: { value: { type: 'external', url: 'https://x.io' } }, slots: { default: 'Custom' } })
    expect(w.get('a').text()).toBe('Custom')
  })

  it('renders nothing for an unresolved internal link with no label (no accessible name)', () => {
    const w = mount(KestrelLink, { props: { value: { type: 'internal', collection: 'pages', id: 1 } } })
    expect(w.find('a').exists()).toBe(false)
  })

  it('still renders an unresolved internal link when it has an explicit label', () => {
    const w = mount(KestrelLink, { props: { value: { type: 'internal', collection: 'pages', id: 1, label: 'About' } } })
    const a = w.get('a')
    expect(a.attributes('href')).toBe('#')
    expect(a.text()).toBe('About')
  })

  it('still renders an unresolved internal link when the caller supplies slot content', () => {
    const w = mount(KestrelLink, { props: { value: { type: 'internal', collection: 'pages', id: 1 } }, slots: { default: 'Custom' } })
    expect(w.get('a').text()).toBe('Custom')
  })
})
