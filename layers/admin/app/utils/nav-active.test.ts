import { describe, it, expect } from 'vitest'
import { isNavItemActive } from './nav-active'

describe('isNavItemActive', () => {
  it('matches the exact base path', () => {
    expect(isNavItemActive('/admin/posts', '/admin/posts')).toBe(true)
  })

  it('matches descendant routes (record edit pages)', () => {
    expect(isNavItemActive('/admin/posts/1', '/admin/posts')).toBe(true)
    expect(isNavItemActive('/admin/posts/new', '/admin/posts')).toBe(true)
  })

  it('does not match a different collection', () => {
    expect(isNavItemActive('/admin/pages', '/admin/posts')).toBe(false)
    expect(isNavItemActive('/admin', '/admin/posts')).toBe(false)
  })

  it('does not match on a shared prefix that is not a path boundary', () => {
    expect(isNavItemActive('/admin/postsmenu', '/admin/posts')).toBe(false)
  })
})
