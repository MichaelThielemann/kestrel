<script setup lang="ts">
import type { LayoutKey } from '#app'
import type { SiteHead } from '../utils/site-head'

// The record decides its own layout, so route-meta resolution is opted out of and this page renders the
// `<NuxtLayout>` itself. Side effect worth knowing: the layout becomes a CHILD of the page, so it can read
// `usePublicPageState()` during SSR — as its parent it rendered before the page had written it.
definePageMeta({ layout: false })

interface RenderedPage {
  title?: string
  layout?: string | null
  seo?: {
    title?: string
    description?: string
    noindex?: boolean
    $media?: { image?: { src: string; width: number | null; height: number | null } | null }
    author?: string
    publishedDate?: string
    keywords?: string
  }
  content?: unknown[]
  status?: string
}

const route = useRoute()
// Locale routing is config-driven (KESTREL_LOCALES / KESTREL_PRIMARY_LOCALE → runtimeConfig.public), NOT
// hardcoded to en/de — otherwise every non-default locale's prerendered pages 404. Mirrors the server's
// prefix scheme (primary unprefixed, others `/<locale>/…`) via the pure `resolvePublicRoute`.
const { locales, primary, prefixPrimary } = pickPublicLocales(
  useRuntimeConfig().public as { locales?: unknown; primaryLocale?: unknown; prefixPrimary?: unknown },
)
const { locale, path } = resolvePublicRoute(route.path.split('/').filter(Boolean), locales, primary, prefixPrimary)

// Resolve across ALL pageLike collections (not just `pages`) via the generic route resolver, so a
// consumer's own pageLike collection renders to static HTML too. `useRequestFetch` forwards the
// incoming request's cookies to the SSR sub-fetch, so an authenticated admin's session reaches
// `/api/route` and a draft renders at its real URL (the live preview); anonymous + the static render
// stay published-only (the handler enforces it).
const requestFetch = useRequestFetch()
const { data: resolved, error: resolveError } = await useAsyncData(`page:${locale}:${path}`, () =>
  requestFetch('/api/route', {
    query: { path, locale },
  }).then((r) => r as {
    collection: string | null
    page: (RenderedPage & Record<string, unknown>) | null
    alternates?: Array<{ locale: string; path: string }>
    ancestors?: Array<{ path: string; title?: string; locale?: string }>
    site?: SiteHead | null
  }),
)
// Ticket preview (ADR-0008): `?kestrel-preview-token=…` carries the editor's UNSAVED state, so an external
// tab can show work in progress without a save and without publishing. The ticket is admin-only and
// session-bound server-side; an expired/foreign/unknown one reads as null and the saved record renders.
const previewToken = route.query[PREVIEW_TOKEN_QUERY]
const { data: ticket } = typeof previewToken === 'string' && previewToken
  ? await useAsyncData(`kestrel-preview-ticket:${previewToken}`, () =>
      requestFetch('/api/preview', { query: { token: previewToken } })
        .then((r) => r as { payload?: { values?: Record<string, unknown> } } | null)
        .catch(() => null))
  : { data: ref<{ payload?: { values?: Record<string, unknown> } } | null>(null) }
const previewValues = computed(() => ticket.value?.payload?.values ?? null)
const previewingTicket = computed(() => previewValues.value !== null)

const page = computed(() => previewPage(resolved.value?.page ?? null, previewValues.value) as (RenderedPage & Record<string, unknown>) | null)
// `fallback` below only rescues a truthy name that is missing from the layout map, so the empty cases have
// to be coalesced here — see resolvePageLayout. The cast is the one honest bridge in this file: the stored
// name is arbitrary editor data, while `NuxtLayout` types `name` as the union of layouts that existed at
// build time. Narrowing to that union is impossible for a value read from the DB, and `fallback` is exactly
// the runtime guard for a name outside it.
const pageLayout = computed(() => resolvePageLayout(page.value?.layout) as LayoutKey)

// The layout (language menu & co.) needs the resolved record and its collection; pages and layouts share
// no other channel, so mirror the fetch result into the shared state — reactively, so client-side
// navigations update it too.
const pageState = usePublicPageState()
watchEffect(() => {
  pageState.value = {
    collection: resolved.value?.collection ?? null,
    page: page.value,
  }
})

// A draft only ever resolves here for an authenticated admin (anonymous + the static render are
// published-only), so its presence is an unambiguous "you are previewing an unpublished page" signal.
const isDraftPreview = computed(() => page.value?.status === 'draft')

// What this tab is actually showing, when it is not the live page. A ticket outranks the draft notice: the
// content on screen was never saved at all, which is the stronger caveat.
const previewNotice = computed(() => {
  if (previewingTicket.value) return 'Preview — unsaved changes, not published'
  return isDraftPreview.value ? 'Draft preview — not published' : ''
})

// Editor live-preview mode: `?kestrel-preview=1` AND an authenticated admin session. The session is
// checked server-side (cookies forwarded, same seam as the draft fetch above) so SSR and hydration
// agree on which branch renders; an anonymous visitor with the query param gets the normal page.
// The bridge component is Lazy — its chunk (message channel + marker chrome) loads only in this mode.
const previewRequested = route.query[PREVIEW_QUERY] === '1'
const { data: previewSession } = previewRequested
  ? await useAsyncData('kestrel-preview-session', () =>
      requestFetch<{ authenticated: boolean }>('/api/session').catch(() => ({ authenticated: false })))
  : { data: ref<{ authenticated: boolean } | null>(null) }
const previewActive = computed(() => previewRequested && previewSession.value?.authenticated === true)

// `useAsyncData` resolves even when the fetch threw, so the resolver's own failure has to be re-raised here
// or the root's empty document (a 200 WITH a body) reads as a successful render and the publisher bakes it
// over the live page. Unconditional on purpose, not just for `/`: on any other path the failure would fall
// through to the 404 below, which asserts "no such page" from a lookup that never completed — a claim
// crawlers and caches act on, and one the publisher files as a skip instead of the error the editor shows.
if (resolveError.value) throw resolveError.value

// The site root stays reachable (empty document) before a home page is published;
// any other unmatched path is a genuine 404.
if (!page.value && path !== '/') throw createError({ statusCode: 404, statusMessage: 'Page not found' })

// Canonical / Open Graph / twitter card / hreflang: pure model (`buildPageHead`) fed from the resolved
// page + the public runtime config. Absolute-URL emissions (canonical, og:url, hreflang, relative
// og:image) require a configured siteUrl and degrade away without one.
const publicRc = useRuntimeConfig().public as { siteUrl?: string; siteName?: string; seoArticleMeta?: boolean }
const seo = page.value?.seo ?? {}
const siteHead = resolved.value?.site ?? null
const fallbacks = siteHeadFallbacks(seo, siteHead)
// og:title stays the bare page title (og:site_name already carries the site); only <title> is composed.
const pageTitle = seo.title || page.value?.title
const documentTitle = composeTitle(pageTitle, siteHead)
const head = buildPageHead({
  siteUrl: typeof publicRc.siteUrl === 'string' ? publicRc.siteUrl : '',
  siteName: typeof publicRc.siteName === 'string' ? publicRc.siteName : '',
  path,
  locale,
  primary,
  prefixPrimary,
  title: pageTitle,
  description: fallbacks.description,
  image: fallbacks.image,
  alternates: resolved.value?.alternates ?? [],
})

// schema.org JSON-LD — the one grounding signal every major answer engine documents. Same inputs as the
// head above, so the two can never disagree; it degrades away without a siteUrl and is suppressed for a
// noindex page or an unsaved ticket preview. Article metadata is published ONLY with `seo.articleMeta`
// on: the fields may hold values (the column always round-trips them) that this installation must not
// disclose, so the flag gates emission, not storage.
const jsonLd = buildJsonLd({
  siteUrl: typeof publicRc.siteUrl === 'string' ? publicRc.siteUrl : '',
  siteName: typeof publicRc.siteName === 'string' ? publicRc.siteName : '',
  canonical: head.canonical,
  locale,
  primary,
  prefixPrimary,
  title: pageTitle,
  description: fallbacks.description,
  imageUrl: head.meta.ogImage,
  noindex: previewingTicket.value || seo.noindex,
  ancestors: resolved.value?.ancestors ?? [],
  article: publicRc.seoArticleMeta === true
    ? { author: seo.author, publishedDate: seo.publishedDate, keywords: seo.keywords }
    : null,
})

// Set the document language from the resolved locale so prerendered /de pages ship <html lang="de">
// (WCAG 2.2 SC 3.1.1); without this every page would carry the build-default language.
// Point AI agents at the generated llms.txt (alongside the robots.txt comment + sitemap) on every page.
useHead({
  htmlAttrs: { lang: locale },
  // `textContent` (not innerHTML) is unhead's XSS-safe arm for a data script: it takes the object and
  // serializes it itself, so editor-authored strings can never close the <script>.
  script: jsonLd ? [{ type: 'application/ld+json' as const, textContent: jsonLd }] : [],
  link: [
    // `rel` needs the literal type: unhead keys its link union on it, and inside an array literal that
    // reaches `link:` through a spread there is no contextual type to stop TS widening it to `string`.
    ...(head.canonical ? [{ rel: 'canonical' as const, href: head.canonical }] : []),
    ...head.links,
    { rel: 'alternate' as const, type: 'text/markdown', href: '/llms.txt', title: 'llms.txt' },
  ],
})
useSeoMeta({
  title: documentTitle,
  description: fallbacks.description,
  // A ticket preview is unsaved content at a real URL — never indexable, whatever the record's own SEO says.
  robots: previewingTicket.value || seo.noindex ? 'noindex, nofollow' : undefined,
  ogTitle: head.meta.ogTitle,
  ogDescription: head.meta.ogDescription,
  ogUrl: head.meta.ogUrl,
  ogType: head.meta.ogType,
  ogSiteName: head.meta.ogSiteName,
  ogImage: head.meta.ogImage,
  ogImageWidth: head.meta.ogImageWidth,
  ogImageHeight: head.meta.ogImageHeight,
  twitterCard: head.meta.twitterCard,
})
</script>

<template>
  <NuxtLayout :name="pageLayout" fallback="default">
    <article>
      <!-- Only ever shown to an authenticated admin previewing an unpublished page (drafts never resolve
           for anonymous visitors or the static render), so it never ships to the public/static site.
           Suppressed inside the editor preview iframe — the editor's own status ampel covers it. -->
      <div v-if="previewNotice && !previewActive" class="kestrel-draft-badge" role="status">
        <span class="kestrel-draft-badge__dot" aria-hidden="true" />
        {{ previewNotice }}
      </div>
      <!-- Editor preview: the bridge swaps in the editor's live (unsaved) tree over postMessage and makes
           blocks selectable; the saved content renders until the first message. Normal path unchanged. -->
      <LazyKestrelPreviewBridge v-if="previewActive" :blocks="(page?.content as any[]) ?? []" v-slot="{ blocks }">
        <KestrelBlockRenderer :blocks="(blocks as any[])" />
      </LazyKestrelPreviewBridge>
      <KestrelBlockRenderer v-else :blocks="(page?.content as any[]) ?? []" />
    </article>
  </NuxtLayout>
</template>

<style scoped>
/* Self-contained (no token dependency) so it renders identically whatever layout the consumer ships. */
.kestrel-draft-badge {
  position: fixed;
  inset-block-start: 0.75rem;
  inset-inline-end: 0.75rem;
  z-index: 2147483647;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.7rem;
  border-radius: 999px;
  background: #1e293b;
  color: #fff;
  font: 600 0.78rem/1 ui-sans-serif, system-ui, sans-serif;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  pointer-events: none;
}
.kestrel-draft-badge__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: #fbbf24;
}
</style>
