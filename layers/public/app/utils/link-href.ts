import type { LinkValue } from '@kestrel/core'

// The server link populator (depth > 0) resolves an internal link's localized target path and attaches
// it as `href`. Until that populator runs (or for a not-yet-resolved value), internal links fall back
// to '#'. external / email / tel are self-contained and need no resolution.
type WithHref<T> = T & { href?: string }

/** Turn any `LinkValue` into an `href`. external → the url; email → `mailto:`; tel → `tel:`; internal →
 *  the populated `href` (localized target path), or '#' when unresolved. Empty string for no value. */
export function linkToHref(value: WithHref<LinkValue> | null | undefined): string {
  if (!value) return ''
  switch (value.type) {
    case 'external':
      return value.url
    case 'email':
      return `mailto:${value.email}`
    case 'tel':
      return `tel:${value.tel}`
    case 'internal': {
      const base = value.href ?? '#'
      // An unresolved internal (draft/missing target) stays '#'; don't fabricate a fragment-only link
      // out of its hash. A resolved path gets `#<hash>` appended when present.
      return base !== '#' && value.hash ? `${base}#${value.hash}` : base
    }
    default:
      return ''
  }
}

/** A human label for a link: its explicit `label`, else a scheme-appropriate default (the target). */
export function linkLabel(value: WithHref<LinkValue> | null | undefined): string {
  if (!value) return ''
  if (value.label) return value.label
  switch (value.type) {
    case 'external':
      return value.url
    case 'email':
      return value.email
    case 'tel':
      return value.tel
    case 'internal':
      return value.href ?? ''
    default:
      return ''
  }
}
