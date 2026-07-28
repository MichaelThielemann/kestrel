<script setup lang="ts">
import { computed } from 'vue'
import { useBlurUp } from '../composables/useBlurUp'

interface ResolvedMedia {
  alt: string | null
  width: number | null
  height: number | null
  thumbhash: string | null
  src: string
  srcset: { url: string; width: number }[]
}
// `sizes` lets the consuming layout declare the rendered slot width (e.g.
// `(min-width: 768px) 50vw, 100vw`) so the browser picks an appropriately small
// `srcset` candidate instead of defaulting to 100vw and over-fetching the largest.
// `priority` marks the above-the-fold LCP image: load it eagerly with a high fetch priority instead of
// lazily, so the browser fetches it immediately rather than deferring the most important pixel. Opt-in
// per call site (the editor can't know which block is the LCP one); leave it off for everything else.
const props = defineProps<{ media: ResolvedMedia; sizes?: string; priority?: boolean }>()
// Computed, not a captured const: the live preview REUSES this instance (BlockRenderer keys blocks by id,
// consumer carousels key slides by index), so a media reorder/replace only patches the `media` prop — a
// one-shot const would keep the browser painting the OLD image via its stale `w`-descriptor candidate set.
const srcset = computed(() => props.media.srcset.map((s) => `${s.url} ${s.width}w`).join(', ') || undefined)

// Blur-up: a thumbhash placeholder shows until the raster paints, then a one-shot "sharpen-in" resolves
// the blur into the crisp image (see useBlurUp for the SSR/no-JS/cached-image degradation rules). The
// placeholder is painted as the <img>'s own background, so no wrapper element is introduced — the bare
// <img> keeps the public site's `img` box model (the reset's display:block / max-width:100%) intact.
const { imgEl, animate, placeholderStyle, onLoad } = useBlurUp(() => props.media.thumbhash)
</script>

<template>
  <img
    ref="imgEl"
    :src="media.src"
    :srcset="srcset"
    :sizes="sizes"
    :width="media.width ?? undefined"
    :height="media.height ?? undefined"
    :alt="media.alt ?? ''"
    :class="{ 'media-image--in': animate }"
    :style="placeholderStyle"
    :loading="priority ? 'eager' : 'lazy'"
    :fetchpriority="priority ? 'high' : undefined"
    decoding="async"
    @load="onLoad"
  >
</template>

<style scoped>
/* Sharpen-in: when the real raster finishes loading it briefly starts soft and resolves to crisp, so the
   swap from the thumbhash placeholder reads as a smooth focus pull rather than a hard snap. The class is
   applied by JS only on a genuine async load, so SSR / no-JS / cached loads just show the image. */
@keyframes media-sharpen {
  from {
    filter: blur(8px);
  }
  to {
    filter: blur(0);
  }
}
.media-image--in {
  animation: media-sharpen 0.5s ease-out;
}
@media (prefers-reduced-motion: reduce) {
  .media-image--in {
    animation: none;
  }
}
</style>
