<script setup lang="ts">
// Recursive renderer for the decrypted folder/file tree. Self-references by name (Nuxt auto-import) to walk
// arbitrary folder depth. A per-image scoped slot (`#image="{ image }"`) lets a consumer/extension overlay
// each photo (e.g. the proofing extension's colour flags) — forwarded through the recursion ONLY when the
// caller actually provides it, so the default <img> still renders at every level otherwise. Plain HTML +
// scoped CSS (public site, no admin design tokens).
import type { GalleryNode } from '../utils/tree'

defineProps<{ nodes: GalleryNode[] }>()
// Typed so the recursively-forwarded scoped slot doesn't infer `any` (the self-reference would otherwise
// make `slotProps` implicitly any).
defineSlots<{ image?: (props: { image: GalleryNode }) => unknown }>()
</script>

<template>
  <div class="sg-nodes">
    <template v-for="node in nodes" :key="node.type === 'folder' ? `f:${node.path}` : `i:${node.blobKey}`">
      <section v-if="node.type === 'folder'" class="sg-folder">
        <h3 class="sg-folder__name">{{ node.name }}</h3>
        <SecureGalleryNodes :nodes="node.children">
          <template v-if="$slots.image" #image="slotProps"><slot name="image" v-bind="slotProps" /></template>
        </SecureGalleryNodes>
      </section>
      <figure v-else class="sg-image">
        <slot name="image" :image="node">
          <img v-if="!node.failed" :src="node.src" :alt="node.name" :title="node.name" loading="lazy" />
          <span v-else class="sg-image__fail">Could not decrypt this image.</span>
        </slot>
      </figure>
    </template>
  </div>
</template>

<style scoped>
.sg-nodes { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.75rem; }
.sg-folder { grid-column: 1 / -1; }
.sg-folder__name { margin: 1rem 0 0.5rem; font-size: 1.05rem; }
.sg-image { margin: 0; }
.sg-image img { width: 100%; height: auto; border-radius: 0.375rem; display: block; }
.sg-image__fail { display: grid; place-items: center; aspect-ratio: 1; background: #faf0f0; color: crimson; border-radius: 0.375rem; font-size: 0.8rem; text-align: center; padding: 0.5rem; }
</style>
