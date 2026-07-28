<script setup lang="ts">
// Schema: a single required richtext field (extracted at build). No display-only props needed.
defineProps({
  body: richtextField({ required: true }),
})
defineBlock({ label: { en: 'Prose', de: 'Fließtext' }, icon: 'file-text' })
</script>

<template>
  <!-- body is sanitized server-side on write (richtext field) -->
  <div class="block-prose" v-html="body" />
</template>
