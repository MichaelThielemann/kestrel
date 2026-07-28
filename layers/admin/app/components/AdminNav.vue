<script setup lang="ts">
import { resolveLocalized } from '../../../ui/app/utils/localized'

const { t, lang } = useT()
const { collections, load } = useCollections()
const { collapsed } = useRailCollapsed()
const route = useRoute()
try {
  await load()
} catch {
  // Nav is non-critical chrome; a failed fetch leaves it empty rather than breaking the layout.
}
</script>

<template>
  <nav class="admin-nav" :aria-label="t('nav.collections')">
    <NuxtLink
      v-for="c in (collections ?? []).filter((c) => c.nav !== false)"
      :key="c.name"
      :to="`/admin/${c.name}`"
      class="admin-nav__link rail__item"
      :class="{ 'router-link-active': isNavItemActive(route.path, `/admin/${c.name}`) }"
      :title="collapsed ? (resolveLocalized(c.label?.plural, lang) ?? c.name) : undefined"
    >
      <UiIcon :name="c.icon ?? 'file-text'" class="rail__icon" size="1.25rem" />
      <span class="rail__label">{{ resolveLocalized(c.label?.plural, lang) ?? c.name }}</span>
    </NuxtLink>
  </nav>
</template>

<style lang="scss">
.admin-nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);

  // Layout, colour and active state come from the shared .rail__item (admin layout).
  // Only the cosmetic capitalisation is nav-specific — kept CSS-only so the rendered
  // text node stays the raw collection name (e.g. "settings").
  &__link {
    text-transform: capitalize;
  }
}
</style>
