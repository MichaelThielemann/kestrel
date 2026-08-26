import type { Localized } from '@michaelthielemann/kestrel-core'

/**
 * Resolve a (possibly localized) label for the active admin language. A plain string is returned as-is
 * (language-agnostic); a `{ <lang>: string }` map resolves to the requested language, then `en`, then any
 * present value. Returns `undefined` when there is nothing to show, so callers fall back (e.g. to the
 * collection/block name). One source of label resolution for the nav, list, editor and block panes.
 */
export function resolveLocalized(value: Localized | undefined, lang: string): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  return value[lang] ?? value.en ?? Object.values(value)[0]
}
