<script setup lang="ts">
// One SFC is one block type: the filename names it, defineProps is its schema. Add a sibling to add one.
defineProps({
  body: richtextField({ required: true }),
})
defineBlock({ label: { en: 'Prose' }, icon: 'file-text' })
</script>

<template>
  <!-- richtext is sanitized server-side on write -->
  <div class="block-prose" v-html="body" />
</template>
