<script setup lang="ts">
import { useBlurUp } from '../composables/useBlurUp'
import { useMediaVariant } from '../composables/useMediaVariant'
import type { ResolvedMedia } from '../../server/utils/resolve'
import type { VariantFit, VariantFormat } from '../../../core/server/utils/kestrel-config'

// The engine's responsive-image component: it renders a <picture> from the media's generated derivatives
// AND its usage declares (to the generate-time scan) which sizes/formats are actually needed — "not in the
// code ⇒ not generated". One usage may declare MULTIPLE `widths` (proportional) and/or a fixed `crop`, plus
// named config `preset`s, crossed with `formats`. `priority` marks the LCP image (eager + high fetchpriority;
// no `sizes=auto`, which only applies to lazy images). `sizes="auto"` degrades gracefully (see resolveSizes).
const props = defineProps<{
  media: ResolvedMedia | null | undefined
  widths?: number[]
  crop?: { width: number; height: number; fit?: VariantFit }
  preset?: string | string[]
  formats?: VariantFormat[]
  sizes?: string
  priority?: boolean
}>()

const { model } = useMediaVariant(
  () => props.media,
  () => ({ widths: props.widths, crop: props.crop, preset: props.preset, formats: props.formats, sizes: props.sizes }),
  { priority: () => props.priority ?? false },
)
const { imgEl, animate, placeholderStyle, onLoad } = useBlurUp(() => props.media?.thumbhash)
</script>

<template>
  <picture v-if="model">
    <source v-for="s in model.sources" :key="s.type" :type="s.type" :srcset="s.srcset" :sizes="model.sizes">
    <img
      ref="imgEl"
      :src="model.src"
      :sizes="model.sizes"
      :width="model.width ?? undefined"
      :height="model.height ?? undefined"
      :alt="model.alt"
      :class="{ 'kestrel-img--in': animate }"
      :style="placeholderStyle"
      :loading="priority ? 'eager' : 'lazy'"
      :fetchpriority="priority ? 'high' : undefined"
      decoding="async"
      @load="onLoad"
    >
  </picture>
</template>

<style scoped>
/* Sharpen-in: one-shot blur→crisp on a genuine async load (JS-driven, so SSR / no-JS / cached just show
   the image). Same treatment as the demo MediaImage. */
@keyframes kestrel-img-sharpen {
  from { filter: blur(8px); }
  to { filter: blur(0); }
}
.kestrel-img--in {
  animation: kestrel-img-sharpen 0.5s ease-out;
}
@media (prefers-reduced-motion: reduce) {
  .kestrel-img--in {
    animation: none;
  }
}
</style>
