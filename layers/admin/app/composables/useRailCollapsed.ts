/**
 * Collapsed/expanded state for the admin navigation rail.
 * Backed by a cookie so the choice persists across reloads and stays SSR-safe
 * (no hydration mismatch — server and client read the same value).
 */
export function useRailCollapsed() {
  const collapsed = useCookie<boolean>('kestrel-rail-collapsed', { default: () => false })

  function toggle() {
    collapsed.value = !collapsed.value
  }

  return { collapsed, toggle }
}
