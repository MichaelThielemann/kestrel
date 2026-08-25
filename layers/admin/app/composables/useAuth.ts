interface AuthState {
  authenticated: boolean
  exp: number | null
  checked: boolean
}

export function useAuth() {
  const state = useState<AuthState>('kestrel-auth', () => ({
    authenticated: false,
    exp: null,
    checked: false,
  }))

  const expired = () => state.value.exp !== null && state.value.exp <= Date.now()

  async function checkSession() {
    // Fail closed: a transient session-endpoint failure (5xx, offline) must read as
    // "not authenticated" so the route guard redirects to login instead of throwing an error page.
    try {
      const r = await $fetch<{ authenticated: boolean; exp?: number }>('/api/session')
      state.value = { authenticated: r.authenticated, exp: r.exp ?? null, checked: true }
    } catch {
      state.value = { authenticated: false, exp: null, checked: true }
    }
    return state.value.authenticated
  }

  async function ensureSession() {
    if (!state.value.checked || expired()) await checkSession()
    return state.value.authenticated && !expired()
  }

  async function login(password: string) {
    const r = await $fetch<{ ok: true; exp: number }>('/api/login', {
      method: 'POST',
      body: { password },
    })
    state.value = { authenticated: true, exp: r.exp, checked: true }
    return r
  }

  /** Drop the local session without a server round-trip — used by the re-auth interceptor on a 401. */
  function reset() {
    state.value = { authenticated: false, exp: null, checked: true }
  }

  async function logout() {
    // The desired end state is "logged out" regardless of the response: an expired/rotated
    // session makes the guarded logout endpoint 401, but the local session is still cleared.
    try {
      await $fetch('/api/logout', { method: 'POST' })
    } catch {
      // already invalid server-side — nothing to clear there
    }
    state.value = { authenticated: false, exp: null, checked: true }
    await navigateTo('/admin/login')
  }

  return {
    authenticated: computed(() => state.value.authenticated && !expired()),
    exp: computed(() => state.value.exp),
    checkSession,
    ensureSession,
    login,
    logout,
    reset,
  }
}
