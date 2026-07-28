<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-auth' })

// The global broken-references report: every record that links to a deleted or unpublished target. The
// referrer keeps its last published output (the stale link stays live) until it is re-edited — this is
// the editor's queue for fixing those. Derived on read, so an entry clears once the link is fixed or the
// target restored. Admin-only (the `references` API resource is outside the public set).
interface BrokenRow {
  source: { collection: string; id: number }
  target: { collection: string; id: number }
  reason: 'missing' | 'unpublished'
}

const { t } = useT()
const broken = ref<BrokenRow[]>([])
// Distinguish "the check ran and found nothing" from "the check failed": a failed fetch must NOT render
// the green all-clear (that would imply a verified-clean site when nothing was actually verified).
const loadError = ref(false)
try {
  broken.value = await $fetch<BrokenRow[]>('/api/references/broken')
} catch {
  loadError.value = true
}
</script>

<template>
  <section class="refs">
    <NuxtLink to="/admin" class="refs__back">
      <UiIcon name="arrow-left" :size="16" />
      <span>{{ t('nav.dashboard') }}</span>
    </NuxtLink>
    <h1 class="refs__title">{{ t('refs.title') }}</h1>
    <p class="refs__lede">{{ t('refs.lede') }}</p>

    <UiAlert v-if="loadError" variant="error" class="refs__error">{{ t('refs.loadError') }}</UiAlert>
    <UiEmptyState
      v-else-if="!broken.length"
      icon="check"
      :title="t('refs.empty.title')"
      :description="t('refs.empty.desc')"
    />
    <!-- The report table is the one scroll region; the back link, title and lede stay fixed above it. -->
    <div v-else class="refs__scroll">
      <table class="refs__table">
        <thead>
          <tr>
            <th>{{ t('refs.colReferrer') }}</th>
            <th>{{ t('refs.colTarget') }}</th>
            <th>{{ t('refs.colReason') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(b, i) in broken" :key="i">
            <td>
              <NuxtLink :to="`/admin/${b.source.collection}/${b.source.id}`" class="refs__link">{{ b.source.collection }} #{{ b.source.id }}</NuxtLink>
            </td>
            <td class="refs__target">{{ b.target.collection }} #{{ b.target.id }}</td>
            <td>
              <span class="refs__reason" :class="`refs__reason--${b.reason}`">{{ t(`refs.reason.${b.reason}`) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style lang="scss">
// Non-scrolling section: the back link, title and lede stay fixed; the report table scrolls in .refs__scroll.
.refs {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
  overflow: hidden;

  &__back,
  &__title,
  &__lede {
    flex: 0 0 auto;
  }

  &__scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  &__back {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    align-self: flex-start;
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    text-decoration: none;

    &:hover {
      color: var(--color-text);
    }
  }
  &__title {
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
  }
  &__lede {
    color: var(--color-text-muted);
  }
  &__table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);

    th,
    td {
      text-align: start;
      padding: var(--space-2) var(--space-3);
      border-bottom: 1px solid var(--color-border);
    }
  }
  &__link {
    color: var(--color-primary);
    text-decoration: none;
    text-transform: capitalize;
  }
  &__target {
    color: var(--color-text-muted);
    text-transform: capitalize;
  }
  &__reason {
    display: inline-flex;
    padding: 1px var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    background: transparent;
    border: 1px solid var(--color-warning);
    color: var(--color-warning-text); /* warning conveyed as TEXT → needs 4.5:1, not the 3:1 icon accent */

    &--missing {
      background: var(--color-danger-solid);
      color: var(--color-on-danger);
    }
  }
}
</style>
