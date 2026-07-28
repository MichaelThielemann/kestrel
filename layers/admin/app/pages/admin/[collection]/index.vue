<script setup lang="ts">
import { resolveLocalized } from '../../../../../ui/app/utils/localized'

// Key on collection + locale ONLY (not the full path): a collection- or locale-change still remounts (which
// resets committed filter/draft/page/selection from the clean target URL), but a sort/page/perPage/filter
// query change must NOT remount — CollectionList derives that state from the URL in place, keeping the filter
// panel open and focus intact. ([id].vue deliberately keeps `route.fullPath` — it needs locale/group/id.)
definePageMeta({
  layout: 'admin',
  middleware: 'admin-auth',
  key: (route) => `${route.params.collection}::${typeof route.query.locale === 'string' ? route.query.locale : ''}`,
})

const route = useRoute()
const collection = route.params.collection as string
const localeParam = computed(() => (typeof route.query.locale === 'string' ? route.query.locale.trim() || undefined : undefined))
const { primary } = useContentLocales()

const { t, lang } = useT()
const { load } = useCollections()
const collections = await load()
const def = collections.find((c) => c.name === collection) ?? null
// The content locale the list browses: the ?locale or the primary, for a translatable collection only.
const listLocale = computed(() => (def?.translatable ? (localeParam.value || primary) : undefined))
</script>

<template>
  <section class="collection">
    <p v-if="!def" class="collection__missing">{{ t('collection.unknown', { name: collection }) }}</p>

    <template v-else-if="def.mode === 'single'">
      <SingletonEditor :collection="collection" :title="resolveLocalized(def.label?.singular, lang) ?? collection" :locale-param="localeParam" />
    </template>

    <template v-else>
      <h1 class="collection__title">{{ resolveLocalized(def.label?.plural, lang) ?? collection }}</h1>
      <CollectionList :schema="def" :locale="listLocale" />
    </template>
  </section>
</template>

<style lang="scss">
// Non-scrolling passthrough: hands its bounded height to whichever branch renders (the singleton
// editor, or the list title + CollectionList). It never scrolls itself — the inner region does.
.collection {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-height: 0;
  overflow: hidden;

  &__title {
    flex: 0 0 auto;
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
    text-transform: capitalize;
  }
  &__missing {
    color: var(--color-text-muted);
  }
}
</style>
