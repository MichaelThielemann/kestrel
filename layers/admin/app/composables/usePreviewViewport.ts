import { computed } from 'vue'
import type { Dim } from '../utils/preview-viewport'

/**
 * Persisted page-builder preview viewport: the target width/height as `Dim`s (a fixed px, or `'auto'`
 * which fills the pane). Cookie-backed so the choice survives reloads and stays SSR-safe (server + client
 * read the same value — no hydration mismatch), the same pattern as `useRailCollapsed`. Defaults to the
 * config-driven desktop width with an `'auto'` height (fills the pane, no container scroll).
 *
 * Each setter reassigns the whole object (rather than mutating a field) so Nuxt's cookie watcher always
 * re-serialises. Note: the seeded default only applies when the cookie is absent — if a project later
 * changes `preview.desktopWidth`, an existing cookie keeps its `w` until the Desktop preset is clicked. A
 * stale cookie from before Auto height (a numeric `h`, plus a now-ignored `fit`) is tolerated: it just
 * reads as a fixed custom height until Desktop is re-selected.
 */
export interface PreviewViewport {
  w: Dim
  h: Dim
}

export function usePreviewViewport(desktopWidth: number) {
  const state = useCookie<PreviewViewport>('kestrel-preview-viewport', {
    default: () => ({ w: desktopWidth, h: 'auto' }),
  })

  const width = computed({ get: () => state.value.w, set: (v: Dim) => { state.value = { ...state.value, w: v } } })
  const height = computed({ get: () => state.value.h, set: (v: Dim) => { state.value = { ...state.value, h: v } } })

  return { width, height }
}
