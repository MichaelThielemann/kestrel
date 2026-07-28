/**
 * The admin-UI language preference (chrome strings), cookie-backed so it persists and is SSR-safe.
 * Deliberately distinct from the content locale (`useContentLocales` / the editor LocaleBar): one is
 * the language of the dashboard, the other is the language of the content being edited.
 */
export function useAdminLang() {
  return useCookie<string>('kestrel-admin-lang', { default: () => 'en' })
}
