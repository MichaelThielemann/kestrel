export type ThemeName = 'light' | 'dark'

/**
 * The initial admin theme: an explicit stored choice wins; otherwise follow the OS
 * `prefers-color-scheme`; default to light. Pure so it can be unit-tested without a DOM.
 */
export function resolveInitialTheme(opts: { stored?: string | null; prefersDark?: boolean }): ThemeName {
  if (opts.stored === 'light' || opts.stored === 'dark') return opts.stored
  return opts.prefersDark ? 'dark' : 'light'
}

/**
 * Admin colour theme (light/dark). The explicit choice is cookie-backed so it persists and is
 * SSR-safe (server and client read the same value — no hydration mismatch). Until a choice is made
 * the theme follows the OS preference, picked up client-side. The admin layout binds `theme` onto
 * `<html data-theme>`; `_tokens.scss` keys the palette off that attribute.
 */
export function useTheme() {
  const stored = useCookie<ThemeName | null>('kestrel-admin-theme', { default: () => null })
  const prefersDark = ref(false)
  let mq: MediaQueryList | null = null
  const onChange = (e: MediaQueryListEvent) => { prefersDark.value = e.matches }

  onMounted(() => {
    mq = window.matchMedia('(prefers-color-scheme: dark)')
    prefersDark.value = mq.matches
    mq.addEventListener('change', onChange)
  })
  onUnmounted(() => mq?.removeEventListener('change', onChange))

  const theme = computed<ThemeName>(() => resolveInitialTheme({ stored: stored.value, prefersDark: prefersDark.value }))
  const setTheme = (t: ThemeName) => { stored.value = t }
  const toggle = () => setTheme(theme.value === 'dark' ? 'light' : 'dark')

  return { theme, toggle, setTheme }
}
