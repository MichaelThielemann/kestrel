import { localePath } from '@michaelthielemann/kestrel-core/client'

export interface PageHeadImage { src: string; width?: number | null; height?: number | null }
export interface PageHeadAlternate { locale: string; path: string }

export interface PageHeadInput {
  /** Absolute site origin ('' when unconfigured — canonical/hreflang/og:url are omitted then). */
  siteUrl: string
  siteName?: string
  /** The page's unprefixed path + its locale (the emitter locale-prefixes via `localePath`). */
  path: string
  locale: string
  primary: string
  prefixPrimary: boolean
  title?: string
  description?: string
  image?: PageHeadImage | null
  /** Published translation siblings (self included); [] / omitted → no hreflang set. */
  alternates?: PageHeadAlternate[]
}

/** A type alias, not an interface: unhead's `link` entries require an implicit `data-*` index signature,
 *  which TS derives for aliases but never for interfaces. */
export type PageHeadLink = { rel: 'alternate'; hreflang: string; href: string }

export interface PageHead {
  canonical?: string
  links: PageHeadLink[]
  meta: {
    ogTitle?: string
    ogDescription?: string
    ogUrl?: string
    ogType: 'website'
    ogSiteName?: string
    ogImage?: string
    ogImageWidth?: number
    ogImageHeight?: number
    twitterCard: 'summary' | 'summary_large_image'
  }
}

const isAbsolute = (src: string) => /^https?:\/\//.test(src)

/**
 * The head model for a rendered public page: canonical, Open Graph / twitter card, and the hreflang
 * alternate set — pure, so the emission rules are unit-testable outside a Nuxt context. Everything that
 * requires an absolute URL (canonical, og:url, hreflang, a relative og:image) degrades away when
 * `siteUrl` is unconfigured; `x-default` points at the primary-locale variant when it is present
 * (mirrors the sitemap's rules, so page heads and sitemap never disagree).
 */
export function buildPageHead(input: PageHeadInput): PageHead {
  const base = input.siteUrl ? input.siteUrl.replace(/\/+$/, '') : ''
  const abs = (path: string, locale: string) => `${base}${localePath(path, locale, input.primary, input.prefixPrimary)}`
  const canonical = base ? abs(input.path, input.locale) : undefined

  const links: PageHeadLink[] = []
  if (base && input.alternates?.length) {
    for (const a of input.alternates) links.push({ rel: 'alternate', hreflang: a.locale, href: abs(a.path, a.locale) })
    const primary = input.alternates.find((a) => a.locale === input.primary)
    if (primary) links.push({ rel: 'alternate', hreflang: 'x-default', href: abs(primary.path, primary.locale) })
  }

  let ogImage: string | undefined
  if (input.image?.src) {
    if (isAbsolute(input.image.src)) ogImage = input.image.src
    else if (base) ogImage = `${base}${input.image.src}`
  }

  return {
    canonical,
    links,
    meta: {
      ogTitle: input.title || undefined,
      ogDescription: input.description || undefined,
      ogUrl: canonical,
      ogType: 'website',
      ogSiteName: input.siteName || undefined,
      ogImage,
      ogImageWidth: ogImage && input.image?.width ? input.image.width : undefined,
      ogImageHeight: ogImage && input.image?.height ? input.image.height : undefined,
      twitterCard: ogImage ? 'summary_large_image' : 'summary',
    },
  }
}
