import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { useState } from '#imports'
import { createError } from 'h3'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import LoginPage from './login.vue'

const { navigateToMock } = vi.hoisted(() => ({ navigateToMock: vi.fn() }))
mockNuxtImport('navigateTo', () => navigateToMock)

let loginStatus: number
registerEndpoint('/api/login', () => {
  if (loginStatus) throw createError({ statusCode: loginStatus })
  return { ok: true, exp: 9_999_999_999_000 }
})

async function submitWith(pw: string) {
  const w = await mountSuspended(LoginPage)
  await w.get('input').setValue(pw)
  await w.get('form').trigger('submit')
  await flushPromises()
  return w
}

beforeEach(() => {
  navigateToMock.mockClear()
  loginStatus = 0
  useState('kestrel-auth').value = { authenticated: false, exp: null, checked: false }
})

describe('login page', () => {
  it('navigates to /admin on a successful login', async () => {
    await submitWith('pw')
    expect(navigateToMock).toHaveBeenCalledWith('/admin')
  })

  it('shows "Invalid credentials" and does not navigate on a 401', async () => {
    loginStatus = 401
    const w = await submitWith('wrong')
    expect(w.text()).toContain('Invalid credentials')
    expect(navigateToMock).not.toHaveBeenCalled()
  })

  it('shows a generic error (not "Invalid credentials") on a non-401 failure', async () => {
    loginStatus = 503
    const w = await submitWith('pw')
    expect(w.text()).toContain('Something went wrong')
    expect(w.text()).not.toContain('Invalid credentials')
    expect(navigateToMock).not.toHaveBeenCalled()
  })

  it('shows the kestrel brand on the login screen', async () => {
    const w = await mountSuspended(LoginPage)
    expect(w.text()).toContain('kestrel')
  })
})
