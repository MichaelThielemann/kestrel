<script setup lang="ts">
import { resolveLocalized } from '../../../../ui/app/utils/localized'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })

const { t, lang } = useT()
const { load } = useCollections()
const collections = ref<Awaited<ReturnType<typeof load>>>([])
try {
  // Match AdminNav: hide nav:false system collections (e.g. media_settings, the machine-managed variant
  // registry) — they are config stores, not content, and must not appear as clickable dashboard cards.
  collections.value = (await load()).filter((c) => c.nav !== false)
} catch {
  // a transient /api/collections failure degrades to an empty dashboard, not an error page
}

// Broken-reference count for the alert banner — fire-and-forget so it never delays the dashboard, and a
// failure (or a not-yet-built index) simply shows no banner.
const brokenCount = ref(0)
$fetch<unknown[]>('/api/references/broken')
  .then((r) => { brokenCount.value = r.length })
  .catch(() => { brokenCount.value = 0 })
</script>

<template>
  <section class="dash">
    <h1 class="dash__title">{{ t('dash.title') }}</h1>
    <p class="dash__lede">{{ t('dash.lede') }}</p>
    <NuxtLink v-if="brokenCount" to="/admin/references" class="dash__alert">
      <UiIcon name="triangle-alert" :size="18" />
      <span>{{ t('refs.dashAlert', { n: brokenCount }) }}</span>
    </NuxtLink>
    <UiEmptyState
      v-if="!collections.length"
      icon="file-text"
      :title="t('dash.empty.title')"
      :description="t('dash.empty.desc')"
    />
    <ul v-else class="dash__grid">
      <li v-for="c in collections" :key="c.name">
        <NuxtLink :to="`/admin/${c.name}`" class="dash__card">
          <UiIcon :name="c.icon ?? 'file-text'" class="dash__icon" size="1.5rem" />
          <span class="dash__name">{{ resolveLocalized(c.label?.plural, lang) ?? c.name }}</span>
          <span class="dash__mode">{{ c.mode === 'single' ? t('dash.mode.singleton') : t('dash.mode.collection') }}</span>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>

<style lang="scss">
.dash {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  overflow-y: auto;

  &__title {
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
  }
  &__lede {
    color: var(--color-text-muted);
  }
  // Stale-reference alert: a warning banner linking to the broken-references report (only when non-zero).
  &__alert {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    align-self: flex-start;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-warning);
    border-radius: var(--radius-md);
    color: var(--color-warning-text); /* banner TEXT → 4.5:1 (the border keeps the 3:1 amber accent) */
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-decoration: none;
  }
  &__grid {
    list-style: none;
    margin: var(--space-3) 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: var(--space-4);
  }
  &__card {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    text-decoration: none;
    color: var(--color-text);
    transition: border-color var(--motion-fast) var(--ease-standard);

    &:hover {
      border-color: var(--color-border-strong);
    }
    &:focus-visible {
      border-color: var(--color-primary);
    }
  }
  &__icon {
    color: var(--color-primary);
  }
  &__name {
    font-weight: var(--weight-medium);
    text-transform: capitalize;
  }
  &__mode {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }
}
</style>
