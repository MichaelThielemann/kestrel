import { makeReauthInterceptor } from '../utils/reauth'

/**
 * Global re-auth interceptor. When a guarded `/api` call 401s mid-session (the cookie expired or was
 * rotated server-side), an ofetch `onResponseError` hook clears the stale local auth and bounces to the
 * login screen with a redirect back to the current page. Client-only: the static renderer never runs
 * client plugins, so the prerender principal is unaffected; non-admin/public locations are filtered out
 * in `reauthTarget`.
 */
export default defineNuxtPlugin(() => {
  const auth = useAuth()
  const router = useRouter()
  const onResponseError = makeReauthInterceptor({
    currentPath: () => router.currentRoute.value.fullPath,
    reset: () => auth.reset(),
    navigate: (to) => { navigateTo(to) },
  })
  // Wrap the auto-imported `$fetch` so every call (incl. useFetch/useAsyncData) runs through the hook.
  globalThis.$fetch = globalThis.$fetch.create({ onResponseError }) as typeof globalThis.$fetch
})
