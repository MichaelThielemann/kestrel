import { describe, it, expect, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { useState } from '#imports'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AdminLayout from './admin.vue'

beforeEach(() => {
  useState('kestrel-auth').value = { authenticated: false, exp: null, checked: false }
})

function authenticate() {
  useState('kestrel-auth').value = { authenticated: true, exp: 9_999_999_999_000, checked: true }
}

describe('admin layout', () => {
  it('hides the account control (home of sign-out) when unauthenticated', async () => {
    // Sign-out lives inside the account menu, which is teleported and not rendered in happy-dom;
    // the avatar trigger stands in as the auth-gated proxy.
    const w = await mountSuspended(AdminLayout)
    expect(w.find('button.rail-account__trigger').exists()).toBe(false)
  })

  it('shows the account control (home of sign-out) when authenticated', async () => {
    authenticate()
    const w = await mountSuspended(AdminLayout)
    expect(w.find('button.rail-account__trigger').exists()).toBe(true)
  })

  it('hides the navigation rail entirely when unauthenticated', async () => {
    const w = await mountSuspended(AdminLayout)
    expect(w.find('aside.admin__rail').exists()).toBe(false)
    expect(w.text()).not.toContain('Dashboard')
    expect(w.text()).not.toContain('Media')
  })

  it('renders the rail with a Dashboard link and a collapse toggle when authenticated', async () => {
    authenticate()
    const w = await mountSuspended(AdminLayout)
    expect(w.find('aside.admin__rail').exists()).toBe(true)

    const dashboard = w.find('a.rail__item--dashboard')
    expect(dashboard.exists()).toBe(true)
    expect(dashboard.attributes('href')).toBe('/admin')
    expect(dashboard.text()).toContain('Dashboard')

    expect(w.find('button.rail__toggle').exists()).toBe(true)
  })

  it('sets a document title fallback (a route with no title of its own is not left blank)', async () => {
    await mountSuspended(AdminLayout)
    await flushPromises()
    await new Promise((r) => setTimeout(r, 50))
    expect(document.title).toBeTruthy()
  })

  it('toggles the collapsed state when the toggle is activated', async () => {
    authenticate()
    const w = await mountSuspended(AdminLayout)
    const before = w.find('.admin').classes().includes('admin--rail-collapsed')
    await w.find('button.rail__toggle').trigger('click')
    const after = w.find('.admin').classes().includes('admin--rail-collapsed')
    expect(after).toBe(!before)
  })
})
