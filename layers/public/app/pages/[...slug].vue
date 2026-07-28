<script setup lang="ts">
interface RenderedPage {
  title?: string
  seo?: {
    title?: string
    description?: string
    noindex?: boolean
    $media?: { image?: { src: string; width: number | null; height: number | null } | null }
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
const { data: resolved } = await useAsyncData(`page:${locale}:${path}`, () =>
  requestFetch('/api/route', {
    query: { path, locale },
  }).then((r) => r as {
    collection: string | null
    page: (RenderedPage & Record<string, unknown>) | null
    alternates?: Array<{ locale: string; path: string }>
  }),
)
const page = computed(() => resolved.value?.page ?? null)

// The layout (language menu & co.) needs the resolved record and its collection; pages and layouts share
// no other channel, so mirror the fetch result into the shared state — reactively, so client-side
// navigations update it too.
const pageState = usePublicPageState()
watchEffect(() => {
  pageState.value = {
    collection: resolved.value?.collection ?? null,
    page: resolved.value?.page ?? null,
  }
})

// A draft only ever resolves here for an authenticated admin (anonymous + the static render are
// published-only), so its presence is an unambiguous "you are previewing an unpublished page" signal.
const isDraftPreview = computed(() => page.value?.status === 'draft')

// Editor live-preview mode: `?kestrel-preview=1` AND an authenticated admin session. The session is
// checked server-side (cookies forwarded, same seam as the draft fetch above) so SSR and hydration
// agree on which branch renders; an anonymous visitor with the query param gets the normal page.
// The bridge component is Lazy — its chunk (message channel + marker chrome) loads only in this mode.
const previewRequested = route.query[PREVIEW_QUERY] === '1'
const { data: previewSession } = previewRequested
  ? await useAsyncData('kestrel-preview-session', () =>
      requestFetch('/api/auth/session').catch(() => ({ authenticated: false })))
  : { data: ref<{ authenticated: boolean } | null>(null) }
const previewActive = computed(() => previewRequested && previewSession.value?.authenticated === true)

// The site root stays reachable (empty document) before a home page is published;
// any other unmatched path is a genuine 404.
if (!page.value && path !== '/') throw createError({ statusCode: 404, statusMessage: 'Page not found' })

// Canonical / Open Graph / twitter card / hreflang: pure model (`buildPageHead`) fed from the resolved
// page + the public runtime config. Absolute-URL emissions (canonical, og:url, hreflang, relative
// og:image) require a configured siteUrl and degrade away without one.
const publicRc = useRuntimeConfig().public as { siteUrl?: string; siteName?: string }
const seo = page.value?.seo ?? {}
const head = buildPageHead({
  siteUrl: typeof publicRc.siteUrl === 'string' ? publicRc.siteUrl : '',
  siteName: typeof publicRc.siteName === 'string' ? publicRc.siteName : '',
  path,
  locale,
  primary,
  prefixPrimary,
  title: seo.title || page.value?.title,
  description: seo.description || undefined,
  image: seo.$media?.image ?? null,
  alternates: resolved.value?.alternates ?? [],
})

// Set the document language from the resolved locale so prerendered /de pages ship <html lang="de">
// (WCAG 2.2 SC 3.1.1); without this every page would carry the build-default language.
// Point AI agents at the generated llms.txt (alongside the robots.txt comment + sitemap) on every page.
useHead({
  htmlAttrs: { lang: locale },
  link: [
    ...(head.canonical ? [{ rel: 'canonical', href: head.canonical }] : []),
    ...head.links,
    { rel: 'alternate', type: 'text/markdown', href: '/llms.txt', title: 'llms.txt' },
  ],
})
useSeoMeta({
  title: seo.title || page.value?.title,
  description: seo.description || undefined,
  robots: seo.noindex ? 'noindex, nofollow' : undefined,
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
  <article>
    <!-- Only ever shown to an authenticated admin previewing an unpublished page (drafts never resolve
         for anonymous visitors or the static render), so it never ships to the public/static site.
         Suppressed inside the editor preview iframe — the editor's own status ampel covers it. -->
    <div v-if="isDraftPreview && !previewActive" class="kestrel-draft-badge" role="status">
      <span class="kestrel-draft-badge__dot" aria-hidden="true" />
      Draft preview — not published
    </div>
    <!-- Editor preview: the bridge swaps in the editor's live (unsaved) tree over postMessage and makes
         blocks selectable; the saved content renders until the first message. Normal path unchanged. -->
    <LazyKestrelPreviewBridge v-if="previewActive" :blocks="(page?.content as any[]) ?? []" v-slot="{ blocks }">
      <BlockRenderer :blocks="(blocks as any[])" />
    </LazyKestrelPreviewBridge>
    <BlockRenderer v-else :blocks="(page?.content as any[]) ?? []" />
  </article>
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
