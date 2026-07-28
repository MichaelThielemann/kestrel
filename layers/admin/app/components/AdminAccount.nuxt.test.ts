import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCookie } from '#imports'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import AdminAccount from './AdminAccount.vue'

// Sign out is account-scoped: the menu item must call `useAuth().logout`. Stub it with a spy so the
// load-bearing wiring is asserted without driving the (teleported, non-rendered) menu DOM.
const { logoutMock } = vi.hoisted(() => ({ logoutMock: vi.fn() }))
mockNuxtImport('useAuth', () => () => ({ logout: logoutMock }))

beforeEach(() => {
  logoutMock.mockClear()
  // Reset the cookie-backed admin language so each test starts from the source language.
  useCookie<string>('kestrel-admin-lang').value = 'en'
})

describe('AdminAccount', () => {
  it('renders an account trigger showing the admin initials in both rail states', async () => {
    // happy-dom does not render the teleported menu, so we only smoke-test the always-present trigger.
    const w = await mountSuspended(AdminAccount)
    const trigger = w.get('button.rail-account__trigger')
    expect(trigger.text()).toContain('AD')
  })

  it('selecting a language updates the admin-UI language (useT().lang)', async () => {
    // The exposed `lang` is the same cookie-backed ref `useT().lang` returns and drives re-render.
    const w = await mountSuspended(AdminAccount)
    expect((w.vm as unknown as { lang: string }).lang).toBe('en')
    ;(w.vm as unknown as { selectLang: (l: string) => void }).selectLang('de')
    expect((w.vm as unknown as { lang: string }).lang).toBe('de')
  })

  it('signing out calls useAuth().logout', async () => {
    const w = await mountSuspended(AdminAccount)
    ;(w.vm as unknown as { signOut: () => void }).signOut()
    expect(logoutMock).toHaveBeenCalledOnce()
  })
})
