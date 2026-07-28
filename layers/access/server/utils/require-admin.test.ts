import { describe, it, expect } from 'vitest'
import { requireAdmin } from './require-admin'

const ev = (role?: string) => ({ context: { principal: role ? { userId: 'u', role } : undefined } }) as never

describe('requireAdmin — write-authorization backstop', () => {
  it('allows the admin principal', () => {
    expect(() => requireAdmin(ev('admin'))).not.toThrow()
  })
  it('rejects renderer, anonymous, and a missing principal (the guard-bypass case)', () => {
    for (const role of ['renderer', 'anonymous', undefined]) {
      expect(() => requireAdmin(ev(role))).toThrowError(/Unauthorized/)
    }
  })
})
