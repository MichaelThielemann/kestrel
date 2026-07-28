<script setup lang="ts">
import type { PageFieldsBindings } from '../utils/editor-form-context'

// The page-fields fragment shared by both editor bodies: an optional content-locale switcher
// (labelled like a page field) sitting above the collection (page) field list. Centralises the
// LocaleBar + PageFields wiring so the flat form and the 3-pane editor's root pane stay in sync.
// Props are the shared `PageFieldsBindings` type — the same shape the shell pre-builds and provides.
defineProps<PageFieldsBindings>()
const emit = defineEmits<{ copyFrom: [locale: string]; update: [name: string, value: unknown] }>()
const { t } = useT()
</script>

<template>
  <div v-if="translatable" class="ui-field">
    <span class="ui-field__label">{{ t('localeBar.fieldLabel') }}</span>
    <LocaleBar
      :collection="collection"
      :id="id"
      :mode="mode"
      :current="locale"
      :translations="translations"
      :group="group"
      @copy-from="(loc) => emit('copyFrom', loc)"
    />
  </div>
  <PageFields
    :fields="fields"
    :field-layout="fieldLayout"
    :values="values"
    :errors="errors"
    :dead-fields="deadFields"
    :locale="locale"
    :page-like="pageLike"
    :seo="seo"
    :status="status"
    :disabled="disabled"
    @update="(name, value) => emit('update', name, value)"
  />
</template>
