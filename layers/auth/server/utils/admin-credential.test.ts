import { describe, it, expect, vi } from 'vitest'
import type { H3Error } from 'h3'
import { adminPasswordHash, requireAdminHash } from './admin-credential'

describe('admin-credential', () => {
  it('adminPasswordHash returns the hash when set, undefined when unset or empty', () => {
    expect(adminPasswordHash({ KESTREL_ADMIN_PASSWORD_HASH: 'scrypt$x' })).toBe('scrypt$x')
    expect(adminPasswordHash({})).toBeUndefined()
    expect(adminPasswordHash({ KESTREL_ADMIN_PASSWORD_HASH: '' })).toBeUndefined()
  })

  it('requireAdminHash returns the configured hash without warning', () => {
    const warn = vi.fn()
    expect(requireAdminHash({ KESTREL_ADMIN_PASSWORD_HASH: 'scrypt$x' }, warn)).toBe('scrypt$x')
    expect(warn).not.toHaveBeenCalled()
  })

  it('requireAdminHash throws a distinct 503 (not 401) and warns once when not configured', () => {
    const warn = vi.fn()
    let caught: H3Error | undefined
    try {
      requireAdminHash({}, warn)
    } catch (e) {
      caught = e
    }
    expect(caught?.statusCode).toBe(503)
    expect(caught?.message).toMatch(/not configured/i)
    expect(caught?.message).toMatch(/KESTREL_ADMIN_PASSWORD_HASH/)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
