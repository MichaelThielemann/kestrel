<script setup lang="ts">
import { useBlurUp } from '../composables/useBlurUp'
import { useMediaVariant } from '../composables/useMediaVariant'
import { aiSourceTypeLabel } from '../utils/ai-disclosure'
import type { ResolvedMedia } from '@kestrel/media'
import type { VariantFit, VariantFormat } from '@kestrel/core'

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
  /** Opt into a structurally-present but UNSTYLED EU AI Act disclosure badge (`.kestrel-img__ai-badge`),
   *  rendered only when `media.aiDisclosure` is set. Off by default: Kestrel must never publish a claim
   *  the consumer did not ask for, in a place/language/style it cannot know. The alternative escape hatch
   *  is to read `media.aiDisclosure` and render your own element — see docs/guide/ai-disclosure.md. */
  aiBadge?: boolean
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
    <span
      v-if="aiBadge && media?.aiDisclosure"
      class="kestrel-img__ai-badge"
      :data-ai-source-type="media.aiDisclosure.sourceType"
    >{{ media.aiDisclosure.note ?? aiSourceTypeLabel(media.aiDisclosure.sourceType) }}</span>
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

<!-- Deliberately UNSCOPED: a scoped rule carries the `[data-v-*]` attribute selector, which out-specifies
     a consumer stylesheet targeting `.kestrel-img__ai-badge` and would make the badge un-restylable.
     Layout only — no color, background, border, radius or font — so nothing is visible as a "badge" until
     the consumer's own CSS says so. Scoped to pictures that actually contain one, so a consumer who never
     sets `ai-badge` gets no rule at all. -->
<style>
picture:has(> .kestrel-img__ai-badge) {
  position: relative;
  display: inline-block;
}
.kestrel-img__ai-badge {
  position: absolute;
  inset-block-end: 0;
  inset-inline-start: 0;
  pointer-events: none;
}
</style>
