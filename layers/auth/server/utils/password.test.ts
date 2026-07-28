import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('password', () => {
  it('hashPassword returns a self-describing scrypt string', async () => {
    const h = await hashPassword('correct horse')
    expect(h.split('$')).toHaveLength(6)
    expect(h.startsWith('scrypt$131072$8$1$')).toBe(true)
  })

  it('verifyPassword accepts the correct password and rejects wrong ones', async () => {
    const h = await hashPassword('correct horse')
    expect(await verifyPassword('correct horse', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
  })

  it('verifyPassword rejects a tampered or malformed hash string', async () => {
    const h = await hashPassword('pw')
    expect(await verifyPassword('pw', h.slice(0, -4) + 'AAAA')).toBe(false)
    expect(await verifyPassword('pw', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('pw', 'scrypt$x$8$1$AAAA$AAAA')).toBe(false)
  })

  it('two hashes of the same password differ (random salt)', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })
})
