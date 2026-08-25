import { describe, it, expect } from 'vitest'
import { htmlKeyForRoute } from '../../../../src/server/utils/publish/route-keys.js'

describe('htmlKeyForRoute', () => {
  it('maps a route to its <path>/index.html static key', () => {
    expect(htmlKeyForRoute('/')).toBe('index.html')
    expect(htmlKeyForRoute('/about')).toBe('about/index.html')
    expect(htmlKeyForRoute('/de/ueber-uns')).toBe('de/ueber-uns/index.html')
  })

  it('collapses leading/trailing slashes', () => {
    expect(htmlKeyForRoute('/about/')).toBe('about/index.html')
    expect(htmlKeyForRoute('//about//')).toBe('about/index.html')
  })

  it('throws on an unsafe route (traversal / query / fragment / backslash)', () => {
    expect(() => htmlKeyForRoute('/a/../b')).toThrow()
    expect(() => htmlKeyForRoute('/a?b=1')).toThrow()
    expect(() => htmlKeyForRoute('/a#x')).toThrow()
    expect(() => htmlKeyForRoute('/a\\b')).toThrow()
  })
})
