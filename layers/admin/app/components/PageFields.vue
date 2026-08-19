<script setup lang="ts">
import type { FieldDef } from '../../../core/server/utils/defineCollection'
import type { LayoutNode } from '../../../core/server/utils/field-layout'
import type { SeoMeta } from '../../../core/server/utils/seo'

// The collection (page) field list — delegates to the shared <KestrelFieldLayout> renderer (rows / groups /
// widths, or one field per row when the collection declares no layout), shared by the flat-collection
// form and the 3-pane editor's root-selected pane so the wiring lives in exactly one place. pageLike
// collections also get their routable `path` (slug); seo-enabled ones get the SEO section — both as
// page-level system fields bracketing the collection fields.
const props = defineProps<{
  fields: Record<string, FieldDef>
  /** Normalized admin editor layout (from the serialized collection). Absent → one field per row. */
  fieldLayout?: LayoutNode[]
  values: Record<string, unknown>
  errors: Record<string, string>
  /** Root field keys holding a stale reference — shown as a non-blocking warning note. */
  deadFields?: Set<string>
  locale: string
  pageLike?: boolean
  seo?: boolean
  status?: boolean
  disabled?: boolean
}>()
const emit = defineEmits<{ update: [name: string, value: unknown] }>()
const { t } = useT()

// A project with a single layout has nothing to choose, so the control stays out of the pane entirely
// rather than offering one dead option.
const layoutOptions = computed(() => layoutSelectOptions(useOfferableLayouts(), t('pageSettings.layoutDefault')))
const showLayout = computed(() => !!props.pageLike && layoutOptions.value.length > 1)

// Article metadata is an installation-wide policy (`kestrel.seo.articleMeta`), not a per-collection one,
// so it comes from runtimeConfig rather than the serialized collection schema.
const articleMeta = computed(() => (useRuntimeConfig().public as { seoArticleMeta?: boolean }).seoArticleMeta === true)

// Live preview of the slug the server will auto-generate from the title while the field is left blank
// (the server slugifies the title on save). Falls back to '/' when there is no title yet.
const slugPlaceholder = computed(() => {
  const s = slugify(recordTitle(props.fields, props.values))
  return s ? `/${s}` : '/'
})
</script>

<template>
  <!-- Publish gate (the `status` system column). The primary page-level control, so it leads the pane:
       Draft keeps the page out of the generated site; Published renders + auto-publishes it. -->
  <KestrelUiField
    v-if="status"
    class="page-settings__status"
    :label="t('pageSettings.statusLabel')"
    :hint="t('pageSettings.statusHint')"
  >
    <template #default="f">
      <KestrelUiSelect
        :model-value="(values.status as string) ?? 'draft'"
        :options="[
          { label: t('pageSettings.statusDraft'), value: 'draft' },
          { label: t('pageSettings.statusPublished'), value: 'published' },
        ]"
        :disabled="disabled"
        v-bind="f"
        @update:model-value="(v) => emit('update', 'status', v)"
      />
    </template>
  </KestrelUiField>

  <!-- The collection (page) fields, laid out by the shared renderer (rows / groups / widths, or one field
       per row when the collection declares no `fieldLayout`). The condition gate + dead-ref note live inside. -->
  <KestrelFieldLayout
    :layout="fieldLayout"
    :fields="fields"
    :values="values"
    :errors="errors"
    :dead-fields="deadFields"
    :locale="locale"
    :disabled="disabled"
    @update="(name, value) => emit('update', name, value)"
  />

  <!-- Page slug (the routable path). A system column on pageLike collections, edited like a field. -->
  <KestrelUiField
    v-if="pageLike"
    class="page-settings__slug"
    :label="t('pageSettings.slugLabel')"
    :hint="t('pageSettings.slugHint')"
    :error="errors.path || null"
  >
    <template #default="f">
      <KestrelUiTextInput
        :model-value="(values.path as string) ?? ''"
        :disabled="disabled"
        :placeholder="slugPlaceholder"
        v-bind="f"
        @update:model-value="(v) => emit('update', 'path', v)"
      />
    </template>
  </KestrelUiField>

  <!-- Which layout renders this page (the `layout` system column). Empty = the `default` layout, so an
       unset value keeps rendering exactly as a project without the column. -->
  <KestrelUiField
    v-if="showLayout"
    class="page-settings__layout"
    :label="t('pageSettings.layoutLabel')"
    :hint="t('pageSettings.layoutHint')"
    :error="errors.layout || null"
  >
    <template #default="f">
      <KestrelUiSelect
        :model-value="(values.layout as string) ?? ''"
        :options="layoutOptions"
        :disabled="disabled"
        v-bind="f"
        @update:model-value="(v) => emit('update', 'layout', v)"
      />
    </template>
  </KestrelUiField>

  <!-- Page SEO (meta title/description/noindex + Google preview). The `seo` JSON system column. -->
  <KestrelSeoFields
    v-if="seo"
    :value="(values.seo as SeoMeta) ?? {}"
    :page-title="(values.title as string) ?? ''"
    :path="(values.path as string) ?? ''"
    :locale="locale"
    :disabled="disabled"
    :article-meta="articleMeta"
    @update="(v) => emit('update', 'seo', v)"
  />
</template>
