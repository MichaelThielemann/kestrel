import { describe, it, expect } from 'vitest'
import { safeRedirect } from './safe-redirect'

describe('safeRedirect', () => {
  it('accepts local /admin targets', () => {
    expect(safeRedirect('/admin')).toBe('/admin')
    expect(safeRedirect('/admin/pages')).toBe('/admin/pages')
    expect(safeRedirect('/admin?tab=media')).toBe('/admin?tab=media')
  })

  it('rejects external and protocol-relative urls', () => {
    expect(safeRedirect('https://evil.example')).toBeNull()
    expect(safeRedirect('//evil.example')).toBeNull()
    expect(safeRedirect('/other')).toBeNull()
    expect(safeRedirect('/adminize')).toBeNull()
  })

  it('rejects the login route (no redirect loop)', () => {
    expect(safeRedirect('/admin/login')).toBeNull()
    expect(safeRedirect('/admin/login?redirect=/admin')).toBeNull()
  })

  it('rejects non-strings', () => {
    expect(safeRedirect(undefined)).toBeNull()
    expect(safeRedirect(42)).toBeNull()
    expect(safeRedirect(['/admin'])).toBeNull()
  })
})
