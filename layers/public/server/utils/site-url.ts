import { resolveServerKestrel, serverRuntimeConfig } from '../../../core/server/utils/server-config'
import { normalizeBase } from './sitemap'

/**
 * Absolute site origin for emitted artifacts (sitemap `<loc>`, robots `Sitemap:`).
 * Configured via `kestrel.siteUrl` (or `KESTREL_SITE_URL`); empty when unset, in which case callers
 * fall back to relative paths and omit the robots `Sitemap:` directive.
 */
export function siteBaseUrl(): string {
  // Prefer the siteUrl the kestrel module resolved from the consumer's `kestrel: {}` (via runtimeConfig);
  // fall back to Kestrel's own config file + env for non-Nitro callers. Mirrors `useDb`'s db-path handling.
  const fromRc = serverRuntimeConfig()?.kestrel as { siteUrl?: string } | undefined
  return normalizeBase(fromRc?.siteUrl ?? resolveServerKestrel().siteUrl)
}

/** Human site name for `llms.txt` — config/env, else the siteUrl host, else 'Website'. */
export function siteName(): string {
  const fromRc = serverRuntimeConfig()?.kestrel as { siteName?: string } | undefined
  const name = (fromRc?.siteName ?? resolveServerKestrel().siteName)?.trim()
  if (name) return name
  const base = siteBaseUrl()
  if (base) {
    try { return new URL(base).host } catch { /* not a parseable URL — fall through */ }
  }
  return 'Website'
}

/** One-line site description for `llms.txt` (empty when unset). */
export function siteDescription(): string {
  const fromRc = serverRuntimeConfig()?.kestrel as { siteDescription?: string } | undefined
  return (fromRc?.siteDescription ?? resolveServerKestrel().siteDescription ?? '').trim()
}

/** Whether `/llms-full.txt` is served, prerendered and published (`kestrel.seo.llmsFull`, default off).
 *  Read the same two-tier way as every other server setting, so a consumed layer sees the CONSUMER's
 *  config rather than Kestrel's own. */
export function llmsFullEnabled(): boolean {
  const fromRc = serverRuntimeConfig()?.kestrel as { seo?: { llmsFull?: boolean } } | undefined
  return (fromRc?.seo?.llmsFull ?? resolveServerKestrel().seo.llmsFull) === true
}
