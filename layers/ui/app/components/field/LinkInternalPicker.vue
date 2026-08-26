<script setup lang="ts">
import { ref, computed, onMounted, toRef } from 'vue'
import UiSelect from '../ui/Select.vue'
import UiCombobox from '../ui/Combobox.vue'
import { useRecordOptions } from '../../composables/useRecordOptions'
import { resolveLocalized } from '../../utils/localized'
import type { SerializedCollection } from '@michaelthielemann/kestrel-core'

const { t, lang } = useT()

const props = defineProps<{
  collections?: string[]
  locale: string
  disabled?: boolean
  inputId?: string
  invalid?: boolean
  describedby?: string
  required?: boolean
}>()

const collection = defineModel<string | null>('collection')
const recordId = defineModel<number | null>('recordId')

interface CollectionOption { label: string; value: string }
const collectionOptions = ref<CollectionOption[]>([])
const showSelect = ref(false) // stays hidden until the fetch resolves → no flash, no empty select
const loadError = ref<string | null>(null)

onMounted(async () => {
  try {
    const res = await $fetch<{ data: SerializedCollection[] }>('/api/collections')
    const filtered = res.data.filter((c) => !props.collections || props.collections.includes(c.name))
    collectionOptions.value = filtered.map((c) => ({
      value: c.name,
      label: resolveLocalized(c.label?.plural, lang.value) ?? resolveLocalized(c.label?.singular, lang.value) ?? c.name,
    }))
    if (collectionOptions.value.length === 1) collection.value ||= collectionOptions.value[0]!.value
    showSelect.value = collectionOptions.value.length > 1
  } catch {
    loadError.value = t('field.linkPicker.loadError')
  }
})

// Reset only on a user pick — a programmatic {collection, id} reseed (record loader) sets both
// together and must not have its freshly-set id clobbered.
function onPickCollection(value: string | null | undefined) {
  collection.value = value ?? null
  recordId.value = null
}

const coll = computed(() => collection.value ?? '')
const ids = computed(() => (recordId.value != null ? [recordId.value] : []))
const { options, selected, loading, onSearch } = useRecordOptions(coll, ids, toRef(props, 'locale'))
</script>

<template>
  <div class="ui-link-internal">
    <p v-if="loadError" class="ui-link-internal__error">{{ loadError }}</p>
    <UiSelect
      v-if="showSelect"
      :model-value="collection"
      :options="collectionOptions"
      :disabled="disabled"
      :placeholder="t('field.linkPicker.chooseCollection')"
      :aria-label="t('field.linkPicker.collectionLabel')"
      :aria-invalid="invalid || undefined"
      :aria-describedby="describedby"
      @update:model-value="onPickCollection"
    />
    <UiCombobox
      v-model="recordId"
      :options="options"
      :selected="selected"
      :loading="loading"
      :multiple="false"
      :disabled="disabled || !collection"
      :input-id="inputId"
      :invalid="invalid"
      :describedby="describedby"
      :required="required"
      :placeholder="t('field.linkPicker.searchRecords')"
      @search="onSearch"
    />
  </div>
</template>

<style lang="scss">
// The internal arm stacks two block controls (collection select + record combobox) plus an error line.
// Matches the `--space-1` rhythm the hash/label rows already use.
.ui-link-internal {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
</style>
