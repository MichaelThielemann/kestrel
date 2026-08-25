import { getResolvedKestrelConfig } from '@kestrel/core'
import { normalizeBase } from './sitemap.js'

/**
 * Absolute site origin for emitted artifacts (sitemap `<loc>`, robots `Sitemap:`).
 * Configured via `kestrel.siteUrl` (or `KESTREL_SITE_URL`); empty when unset, in which case callers
 * fall back to relative paths and omit the robots `Sitemap:` directive. Reads the config the boot-time
 * wiring plugin resolved once (see `resolveServerKestrelConfig` in `server-config.ts`).
 * @public
 */
export function siteBaseUrl(): string {
  return normalizeBase(getResolvedKestrelConfig().siteUrl)
}

/** Human site name for `llms.txt` — config/env, else the siteUrl host, else 'Website'. */
/** @public */
export function siteName(): string {
  const name = getResolvedKestrelConfig().siteName?.trim()
  if (name) return name
  const base = siteBaseUrl()
  if (base) {
    try { return new URL(base).host } catch { /* not a parseable URL — fall through */ }
  }
  return 'Website'
}

/** One-line site description for `llms.txt` (empty when unset). */
/** @public */
export function siteDescription(): string {
  return (getResolvedKestrelConfig().siteDescription ?? '').trim()
}

/** Whether `/llms-full.txt` is served, prerendered and published (`kestrel.seo.llmsFull`, default off). */
/** @public */
export function llmsFullEnabled(): boolean {
  return getResolvedKestrelConfig().seo.llmsFull === true
}
