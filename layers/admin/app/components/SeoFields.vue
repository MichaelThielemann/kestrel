<script setup lang="ts">
import { computed } from 'vue'
import { localePath } from '@michaelthielemann/kestrel-core/client'
import type { FieldDef, SeoMeta } from '@michaelthielemann/kestrel-core'
// The page-level SEO section: edit the meta title/description/noindex (the `seo` system column) with a
// live Google-result preview. Emits the whole merged SeoMeta so the parent routes it through setField.
const props = defineProps<{
  value: SeoMeta
  pageTitle?: string
  path?: string
  locale: string
  disabled?: boolean
  /** `kestrel.seo.articleMeta`. Off (the default) hides author/date/keywords entirely: an installation
   *  that must not attribute content should never be offered the fields, not merely stop publishing
   *  them. Stored values are hidden, never cleared — turning the flag back on restores them. */
  articleMeta?: boolean
}>()
const emit = defineEmits<{ update: [seo: SeoMeta] }>()
const { t } = useT()
const { primary, prefixPrimary } = useContentLocales()

// Soft guidance limits (Google truncates ~ these lengths).
const TITLE_MAX = 60
const DESC_MAX = 160

function patch(next: Partial<SeoMeta>) {
  emit('update', { ...props.value, ...next })
}

const previewTitle = computed(() => props.value.title?.trim() || props.pageTitle?.trim() || t('seo.untitled'))
const previewDesc = computed(() => props.value.description?.trim() || t('seo.noDescription'))

const host = computed(() => {
  try { return useRequestURL().host } catch { return '' }
})
const previewUrl = computed(() => `${host.value}${localePath(props.path || '/', props.locale, primary, prefixPrimary)}`)

const titleLen = computed(() => (props.value.title ?? '').length)
const descLen = computed(() => (props.value.description ?? '').length)

// The social-share image (og:image) rides the standard media widget over a synthetic single-media field
// def — same picker/thumb/remove UX as any media field, stored as `seo.image` (a media id).
const socialImageField = { type: 'media', options: { accept: 'image' } } as FieldDef
</script>

<template>
  <div class="seo-fields">
    <p class="seo-fields__section-label">{{ t('seo.sectionLabel') }}</p>

    <!-- Google SERP-style preview. Decorative (it mirrors the inputs below) → hidden from SRs. -->
    <div class="seo-preview" aria-hidden="true">
      <div class="seo-preview__url">{{ previewUrl }}</div>
      <div class="seo-preview__title">{{ previewTitle }}</div>
      <div class="seo-preview__desc">{{ previewDesc }}</div>
    </div>

    <KestrelUiField class="seo-fields__title" :label="t('seo.metaTitle')" :hint="`${titleLen}/${TITLE_MAX}`">
      <template #default="f">
        <KestrelUiTextInput
          :model-value="value.title ?? ''"
          :placeholder="pageTitle"
          :disabled="disabled"
          v-bind="f"
          @update:model-value="(v) => patch({ title: v ?? '' })"
        />
      </template>
    </KestrelUiField>

    <KestrelUiField class="seo-fields__desc" :label="t('seo.metaDescription')" :hint="`${descLen}/${DESC_MAX}`">
      <template #default="f">
        <KestrelUiTextarea
          :model-value="value.description ?? ''"
          :rows="3"
          :disabled="disabled"
          v-bind="f"
          @update:model-value="(v) => patch({ description: v ?? '' })"
        />
      </template>
    </KestrelUiField>

    <KestrelUiField class="seo-fields__image" :label="t('seo.socialImage')" :hint="t('seo.socialImageHint')">
      <template #default="f">
        <KestrelFieldMedia
          :field="socialImageField"
          name="seoImage"
          :locale="locale"
          :disabled="disabled"
          v-bind="f"
          :model-value="value.image ?? null"
          @update:model-value="(v) => patch({ image: typeof v === 'number' ? v : null })"
        />
      </template>
    </KestrelUiField>

    <!-- Article metadata (schema.org author / datePublished / keywords). Opt-in per installation. -->
    <template v-if="articleMeta">
      <KestrelUiField class="seo-fields__author" :label="t('seo.author')" :hint="t('seo.authorHint')">
        <template #default="f">
          <KestrelUiTextInput
            :model-value="value.author ?? ''"
            :disabled="disabled"
            v-bind="f"
            @update:model-value="(v) => patch({ author: v ?? '' })"
          />
        </template>
      </KestrelUiField>

      <KestrelUiField class="seo-fields__published" :label="t('seo.publishedDate')" :hint="t('seo.publishedDateHint')">
        <template #default="f">
          <KestrelUiDatePicker
            :model-value="value.publishedDate || null"
            precision="date"
            :disabled="disabled"
            :aria-label="t('seo.publishedDate')"
            :describedby="f['aria-describedby']"
            @update:model-value="(v) => patch({ publishedDate: v ?? '' })"
          />
        </template>
      </KestrelUiField>

      <KestrelUiField class="seo-fields__keywords" :label="t('seo.keywords')" :hint="t('seo.keywordsHint')">
        <template #default="f">
          <KestrelUiTextInput
            :model-value="value.keywords ?? ''"
            :disabled="disabled"
            v-bind="f"
            @update:model-value="(v) => patch({ keywords: v ?? '' })"
          />
        </template>
      </KestrelUiField>
    </template>

    <!-- eslint-disable-next-line vuejs-accessibility/label-has-for -- native wrapping label around a custom UiCheckbox; no `for`/`id` pair needed, invisible to static analysis -->
    <label class="seo-fields__noindex">
      <KestrelUiCheckbox
        :model-value="!!value.noindex"
        :disabled="disabled"
        @update:model-value="(v) => patch({ noindex: v })"
      />
      <span>{{ t('seo.noindexLabel') }}</span>
    </label>
  </div>
</template>

<style lang="scss">
.seo-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);

  &__section-label {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-muted);
  }

  &__noindex {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    cursor: pointer;

    input {
      width: 1rem;
      height: 1rem;
      accent-color: var(--color-primary);
    }
  }
}

// A restrained take on a Google result card — enough to gauge truncation, not a pixel-perfect clone.
.seo-preview {
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);

  &__url {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  &__title {
    margin-top: var(--space-1);
    font-size: var(--text-lg);
    line-height: 1.3;
    color: var(--color-link, #1a0dab);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
  }
  &__desc {
    margin-top: var(--space-1);
    font-size: var(--text-sm);
    color: var(--color-text);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
}
</style>
