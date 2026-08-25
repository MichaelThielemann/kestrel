import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { createError } from 'h3'
import { useState } from '#imports'
// The plugin lives in plugins/ (Nuxt auto-registers everything there as a plugin), so its integration
// test must sit OUTSIDE that dir or it would be picked up as a plugin instead of a test suite.
import plugin from '../plugins/reauth.client'

const { navigateToMock } = vi.hoisted(() => ({ navigateToMock: vi.fn() }))
mockNuxtImport('navigateTo', () => navigateToMock)

registerEndpoint('/api/secure', () => { throw createError({ statusCode: 401, statusMessage: 'Authentication required' }) })
registerEndpoint('/api/session', () => ({ authenticated: false }))
registerEndpoint('/api/login', () => { throw createError({ statusCode: 401, statusMessage: 'Invalid' }) })

const runPlugin = () => (plugin as unknown as (app: unknown) => void)(useNuxtApp())

beforeEach(() => {
  navigateToMock.mockClear()
  // start "logged in" so the admin route's middleware passes without a session round-trip
  useState('kestrel-auth').value = { authenticated: true, exp: 9_999_999_999_000, checked: true }
})

describe('reauth.client plugin', () => {
  it('wraps $fetch; a guarded /api 401 from an admin route clears auth and redirects to login', async () => {
    await useRouter().push('/admin/posts')
    navigateToMock.mockClear() // ignore anything the route change itself triggered

    const before = globalThis.$fetch
    runPlugin()
    expect(globalThis.$fetch).not.toBe(before) // the interceptor is installed

    await globalThis.$fetch('/api/secure').catch(() => {})
    expect(navigateToMock).toHaveBeenCalledWith('/admin/login?redirect=%2Fadmin%2Fposts')
    expect(useState('kestrel-auth').value.authenticated).toBe(false)
  })

  it('leaves a 401 from the auth endpoints alone (no redirect loop on a bad login)', async () => {
    await useRouter().push('/admin/login')
    navigateToMock.mockClear()
    runPlugin()
    await globalThis.$fetch('/api/login', { method: 'POST' }).catch(() => {})
    expect(navigateToMock).not.toHaveBeenCalled()
  })
})
