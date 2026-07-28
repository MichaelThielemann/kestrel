<script setup lang="ts">
import { computed } from 'vue'
import { resolveFieldComponent } from '../../utils/field-registry'
import { resolveLocalized } from '../../utils/localized'
import { humanizeFieldName } from '../../utils/humanize'
import FieldUnsupported from './Unsupported.vue'
import type { FieldComponentProps } from '../../utils/field-component'

const props = defineProps<FieldComponentProps>()
const model = defineModel<unknown>()
const { lang } = useT()
const component = computed(() => resolveFieldComponent(props.field.type) ?? FieldUnsupported)
// The widget renders `name` as its display label. Prefer the def's (localized) label, else humanize the
// key (`siteName` → "Site Name") so the editor label matches the collection-list header. The field's wire
// key is owned by the parent, so passing the human label down as `name` is safe.
const label = computed(() => resolveLocalized(props.field.label, lang.value) ?? humanizeFieldName(props.name))
</script>

<template>
  <component
    :is="component"
    :id="id"
    v-model="model"
    :field="field"
    :name="label"
    :locale="locale"
    :error="error"
    :disabled="disabled"
  />
</template>
