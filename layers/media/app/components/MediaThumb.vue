<script setup lang="ts">
import { useBlurUp } from '../composables/useBlurUp'

// An admin media-library thumbnail: a plain <img> with a thumbhash blur-up placeholder so the library
// grid + the media field picker fill with soft previews instead of blank tiles that pop in. Product
// (AdminUI) — distinct from the demo public `MediaImage`. Takes ready-made src/srcset strings (the
// library API and the media resolver already build them). Placeholder-only on purpose: no sharpen
// animation, so adjacent tiles in the grid never overlap with a filter-blur halo.
const props = defineProps<{ src: string; srcset?: string; sizes?: string; alt?: string; thumbhash?: string | null }>()
const { imgEl, placeholderStyle, onLoad } = useBlurUp(() => props.thumbhash ?? null)
</script>

<template>
  <img
    ref="imgEl"
    :src="src"
    :srcset="srcset"
    :sizes="sizes"
    :alt="alt ?? ''"
    :style="placeholderStyle"
    loading="lazy"
    decoding="async"
    @load="onLoad"
  >
</template>
