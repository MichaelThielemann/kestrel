<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
const { t } = useT()
</script>

<template>
  <section class="media-page">
    <h1 class="media-page__title">{{ t('media.title') }}</h1>
    <MediaLibrary />
  </section>
</template>

<style lang="scss">
// Non-scrolling page section: the title stays fixed and MediaLibrary's grid owns the scroll.
.media-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-height: 0;
  overflow: hidden;

  &__title {
    flex: 0 0 auto;
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
  }
}
</style>
