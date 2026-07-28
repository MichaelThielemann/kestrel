<script setup lang="ts">
/**
 * Dedicated editor live-preview page for records WITHOUT a public URL — a new/unsaved record, a blank
 * slug, or a blocks-enabled non-pageLike collection. It renders the real public app (default layout,
 * the consumer's CSS/fonts/breakpoints) around an empty BlockRenderer that the editor fills over the
 * postMessage bridge. Saved pageLike records preview at their REAL URL instead (higher fidelity);
 * this page is the graceful fallback so previews never regress to "save first".
 *
 * Admin-gated server-side: `useRequestFetch` forwards the incoming cookies to `/api/auth/session`
 * (the same seam the catch-all uses for draft rendering), and anonymous requests get a 404 — the
 * page's existence is not advertised. It is never linked, prerendered, or published (the publisher
 * enumerates DB page rows only), and carries noindex as belt-and-braces.
 */
const requestFetch = useRequestFetch()
const { data: session } = await useAsyncData('kestrel-preview-session', () =>
  requestFetch('/api/auth/session').catch(() => ({ authenticated: false })),
)
if (!session.value?.authenticated) throw createError({ statusCode: 404, statusMessage: 'Page not found' })

// Content locale from the editor (drives <html lang> for faithful per-locale rendering).
const route = useRoute()
const lang = typeof route.query.locale === 'string' && route.query.locale ? route.query.locale : undefined
useHead({
  title: 'Preview',
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
  ...(lang ? { htmlAttrs: { lang } } : {}),
})
</script>

<template>
  <KestrelPreviewBridge v-slot="{ blocks }">
    <BlockRenderer :blocks="(blocks as any[])" />
  </KestrelPreviewBridge>
</template>
