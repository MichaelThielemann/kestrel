import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Icon from './Icon.vue'

describe('UiIcon', () => {
  it('renders an svg with correct viewBox and stroke', () => {
    const w = mount(Icon, { props: { name: 'trash' } })
    const svg = w.get('svg')
    expect(svg.attributes('viewBox')).toBe('0 0 24 24')
    expect(svg.attributes('stroke')).toBe('currentColor')
  })

  it('trash: svg contains path and line child elements', () => {
    const w = mount(Icon, { props: { name: 'trash' } })
    expect(w.find('path').exists()).toBe(true)
    expect(w.find('line').exists()).toBe(true)
  })

  it('grip: svg contains 6 circle elements', () => {
    const w = mount(Icon, { props: { name: 'grip' } })
    expect(w.findAll('circle').length).toBe(6)
  })

  it('size number → width/height "16px"', () => {
    const w = mount(Icon, { props: { name: 'plus', size: 16 } })
    const svg = w.get('svg')
    expect(svg.attributes('width')).toBe('16px')
    expect(svg.attributes('height')).toBe('16px')
  })

  it('size string passes through', () => {
    const w = mount(Icon, { props: { name: 'plus', size: '1.5rem' } })
    const svg = w.get('svg')
    expect(svg.attributes('width')).toBe('1.5rem')
    expect(svg.attributes('height')).toBe('1.5rem')
  })

  it('default size is "1em"', () => {
    const w = mount(Icon, { props: { name: 'plus' } })
    const svg = w.get('svg')
    expect(svg.attributes('width')).toBe('1em')
    expect(svg.attributes('height')).toBe('1em')
  })

  it('decorative by default: aria-hidden="true", no role, no aria-label', () => {
    const w = mount(Icon, { props: { name: 'x' } })
    const svg = w.get('svg')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('role')).toBeUndefined()
    expect(svg.attributes('aria-label')).toBeUndefined()
  })

  it('caller-supplied role/aria-label fallthrough attrs also suppress aria-hidden (no `label` prop)', () => {
    const w = mount(Icon, {
      props: { name: 'trash' },
      attrs: { role: 'img', 'aria-label': 'Stale reference' },
    })
    const svg = w.get('svg')
    expect(svg.attributes('role')).toBe('img')
    expect(svg.attributes('aria-label')).toBe('Stale reference')
    expect(svg.attributes('aria-hidden')).toBeUndefined()
  })

  it('with label: role="img", aria-label set, no aria-hidden', () => {
    const w = mount(Icon, { props: { name: 'trash', label: 'Delete' } })
    const svg = w.get('svg')
    expect(svg.attributes('role')).toBe('img')
    expect(svg.attributes('aria-label')).toBe('Delete')
    expect(svg.attributes('aria-hidden')).toBeUndefined()
  })

  it('exposes the resolved registry key via data-icon', () => {
    expect(mount(Icon, { props: { name: 'settings' } }).get('svg').attributes('data-icon')).toBe('settings')
  })

  it('renders developer-supplied raw SVG markup, marked data-icon="custom"', () => {
    const w = mount(Icon, { props: { name: '<rect width="4" height="4"/>' } })
    expect(w.find('rect').exists()).toBe(true)
    expect(w.get('svg').attributes('data-icon')).toBe('custom')
  })

  it('strips script-capable content from raw SVG', () => {
    const w = mount(Icon, { props: { name: '<path d="M0 0"/><script>alert(1)</script>' } })
    expect(w.find('path').exists()).toBe(true)
    expect(w.find('script').exists()).toBe(false)
  })
})
