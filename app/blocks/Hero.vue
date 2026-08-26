<script setup lang="ts">
import type { LinkValue } from '@michaelthielemann/kestrel-core'
import { defineBlock } from '@michaelthielemann/kestrel-fields/client'

interface ResolvedMedia { src: string; srcset: { url: string; width: number }[]; alt: string | null; width: number | null; height: number | null; thumbhash: string | null }

// The block SCHEMA is these field-factory props — extracted at build into `#kestrel/blocks`. `media` is a
// display-only prop (the server-resolved $media bag BlockRenderer passes), not a schema field. Keep TS out
// of the defineProps ARGUMENT (the extractor evaluates it as plain JS); casts live in the computeds below.
const props = defineProps({
  heading: textField({ required: true }),
  image: mediaField({ accept: 'image' }),
  cta: linkField(),
  media: Object,
})
defineBlock({ label: 'Hero', slots: ['default'], icon: 'image' })

const cta = computed(() => (props.cta ?? null) as LinkValue | null)
const heroImage = computed(() => (props.media as { image?: ResolvedMedia } | undefined)?.image ?? null)
</script>

<template>
  <section class="block-hero">
    <h1 v-if="heading">{{ heading }}</h1>
    <!-- The hero image is the conventional above-the-fold LCP element: load it eagerly and tell the browser
         its rendered width is the full viewport so phones don't over-fetch the largest srcset. -->
    <KestrelMediaImage v-if="heroImage" :media="heroImage" :priority="true" sizes="100vw" />
    <slot />
    <KestrelLink v-if="cta" :value="cta" class="block-hero__cta" />
  </section>
</template>
