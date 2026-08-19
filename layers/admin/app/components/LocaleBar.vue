<script setup lang="ts">
// Pruvious-style content-locale switcher for the record editor. Shows every configured website locale:
// the active one as a label, an existing sibling as a pen (edit) + copy control, a missing one as a
// "+" (create) link. Content locales only — not the admin-UI language.
const props = defineProps<{
  collection: string
  id: string
  mode: 'single' | 'multi'
  current: string
  translations: Record<string, number | null>
  group?: string
}>()
const emit = defineEmits<{ copyFrom: [locale: string] }>()

const { locales } = useContentLocales()

/** Existing sibling row id for a locale (multi only), or null when there is no translation yet. */
function existingId(loc: string): number | null {
  const v = props.translations[loc]
  return typeof v === 'number' ? v : null
}
function createLink(loc: string): string {
  const q = new URLSearchParams({ locale: loc })
  if (props.group) q.set('group', props.group)
  return `/admin/${props.collection}/new?${q.toString()}`
}
const up = (s: string) => s.toUpperCase()
const { t } = useT()
</script>

<template>
  <div class="locale-bar" role="group" :aria-label="t('localeBar.groupLabel')">
    <template v-for="loc in locales" :key="loc">
      <span v-if="loc === current" class="locale-bar__item locale-bar__item--active" aria-current="true">{{ up(loc) }}</span>

      <NuxtLink
        v-else-if="mode === 'single'"
        class="locale-bar__item locale-bar__btn"
        :to="`/admin/${collection}?locale=${loc}`"
        :aria-label="t('localeBar.editLocale', { loc: up(loc) })"
      >{{ up(loc) }}<KestrelUiIcon name="pencil" :size="14" /></NuxtLink>

      <span v-else-if="existingId(loc) !== null" class="locale-bar__item">
        <NuxtLink class="locale-bar__btn" :to="`/admin/${collection}/${existingId(loc)}?locale=${loc}`" :aria-label="t('localeBar.editLocale', { loc: up(loc) })">{{ up(loc) }}<KestrelUiIcon name="pencil" :size="14" /></NuxtLink>
        <button type="button" class="locale-bar__btn locale-bar__btn--copy" :aria-label="t('localeBar.copyInto', { loc: up(loc), current: up(current) })" @click="emit('copyFrom', loc)"><KestrelUiIcon name="copy" :size="14" /></button>
      </span>

      <NuxtLink
        v-else
        class="locale-bar__item locale-bar__btn locale-bar__btn--add"
        :to="createLink(loc)"
        :aria-label="t('localeBar.createTranslation', { loc: up(loc) })"
      >{{ up(loc) }}<KestrelUiIcon name="plus" :size="14" /></NuxtLink>
    </template>
  </div>
</template>

<style lang="scss">
.locale-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);

  &__item {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);

    &--active {
      padding: var(--space-1) var(--space-2);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
    }
  }
  &__btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted);
    text-decoration: none;
    cursor: pointer;

    &:hover {
      border-color: var(--color-text-muted);
      color: var(--color-text);
    }
    &--add {
      border-style: solid;
      border-color: var(--color-border);
      color: var(--color-text-muted);
    }
    &--copy {
      padding: var(--space-1);
    }
  }
}
</style>
