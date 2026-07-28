import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useState } from '#imports'
import { registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import middleware from './admin-auth'

const { navigateToMock } = vi.hoisted(() => ({ navigateToMock: vi.fn() }))
mockNuxtImport('navigateTo', () => navigateToMock)

let sessionRes: { authenticated: boolean; exp?: number }
registerEndpoint('/api/auth/session', () => sessionRes)

const run = (fullPath: string) => (middleware as any)({ fullPath }, { fullPath: '/' })

beforeEach(() => {
  navigateToMock.mockClear()
  sessionRes = { authenticated: false }
  useState('kestrel-auth').value = { authenticated: false, exp: null, checked: false }
})

describe('admin-auth middleware', () => {
  it('redirects to login (with the intended path) when unauthenticated', async () => {
    await run('/admin/pages')
    expect(navigateToMock).toHaveBeenCalledWith('/admin/login?redirect=%2Fadmin%2Fpages')
  })

  it('passes through when authenticated', async () => {
    sessionRes = { authenticated: true, exp: 9_999_999_999_000 }
    const result = await run('/admin/pages')
    expect(navigateToMock).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })
})
