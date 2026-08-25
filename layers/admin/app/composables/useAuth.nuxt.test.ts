import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useState } from '#imports'
import { createError } from 'h3'
import { registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useAuth } from './useAuth'

const { navigateToMock } = vi.hoisted(() => ({ navigateToMock: vi.fn() }))
mockNuxtImport('navigateTo', () => navigateToMock)

let sessionRes: { authenticated: boolean; exp?: number }
let sessionFails: boolean
let loginOk: boolean
const loginExp = 9_999_999_999_000

registerEndpoint('/api/session', () => {
  if (sessionFails) throw createError({ statusCode: 503, statusMessage: 'Service unavailable' })
  return sessionRes
})
registerEndpoint('/api/login', () => {
  if (!loginOk) throw createError({ statusCode: 401, statusMessage: 'Invalid credentials' })
  return { ok: true, exp: loginExp }
})
registerEndpoint('/api/logout', () => ({ ok: true }))

beforeEach(() => {
  navigateToMock.mockClear()
  sessionRes = { authenticated: false }
  sessionFails = false
  loginOk = true
  useState('kestrel-auth').value = { authenticated: false, exp: null, checked: false }
})

describe('useAuth', () => {
  it('checkSession reflects an authenticated session', async () => {
    sessionRes = { authenticated: true, exp: loginExp }
    const auth = useAuth()
    await auth.checkSession()
    expect(auth.authenticated.value).toBe(true)
    expect(auth.exp.value).toBe(loginExp)
  })

  it('login sets state and exp', async () => {
    const auth = useAuth()
    const r = await auth.login('pw')
    expect(r.ok).toBe(true)
    expect(auth.authenticated.value).toBe(true)
    expect(auth.exp.value).toBe(loginExp)
  })

  it('a 401 login rejects and leaves state unauthenticated', async () => {
    loginOk = false
    const auth = useAuth()
    await expect(auth.login('wrong')).rejects.toMatchObject({ statusCode: 401 })
    expect(auth.authenticated.value).toBe(false)
  })

  it('logout resets state and navigates to login', async () => {
    sessionRes = { authenticated: true, exp: loginExp }
    const auth = useAuth()
    await auth.checkSession()
    await auth.logout()
    expect(auth.authenticated.value).toBe(false)
    expect(navigateToMock).toHaveBeenCalledWith('/admin/login')
  })

  it('reset() drops the local session without a server round-trip', async () => {
    sessionRes = { authenticated: true, exp: loginExp }
    const auth = useAuth()
    await auth.checkSession()
    expect(auth.authenticated.value).toBe(true)
    auth.reset()
    expect(auth.authenticated.value).toBe(false)
  })

  it('ensureSession refetches when unchecked', async () => {
    sessionRes = { authenticated: true, exp: loginExp }
    expect(await useAuth().ensureSession()).toBe(true)
  })

  it('treats an expired session as not authenticated', async () => {
    sessionRes = { authenticated: true, exp: Date.now() - 1000 }
    const auth = useAuth()
    await auth.checkSession()
    expect(auth.authenticated.value).toBe(false)
  })

  it('fails closed when the session endpoint errors (no throw, ensureSession → false)', async () => {
    sessionFails = true
    const auth = useAuth()
    await expect(auth.checkSession()).resolves.toBe(false)
    expect(auth.authenticated.value).toBe(false)
    expect(await auth.ensureSession()).toBe(false)
  })
})
