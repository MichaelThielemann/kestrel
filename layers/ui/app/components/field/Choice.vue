<script setup lang="ts">
import { computed } from 'vue'
import UiField from '../ui/Field.vue'
import UiFieldset from '../ui/Fieldset.vue'
import UiSelect from '../ui/Select.vue'
import UiButtonGroup from '../ui/ButtonGroup.vue'
import UiCheckboxGroup from '../ui/CheckboxGroup.vue'
import { resolveLocalized } from '../../utils/localized'
import type { FieldComponentProps } from '../../utils/field-component'
import type { FieldOf } from '../../../../core/server/utils/defineCollection'

const props = defineProps<FieldComponentProps>()
const model = defineModel<string | string[] | null>()

const { lang } = useT()

const cfg = computed(() => {
  if (props.field.type !== 'choice') return { choices: [] as { label: string; value: string }[], multiple: false, buttons: false }
  const o = (props.field as FieldOf<'choice'>).options
  return {
    // A choice label is `Localized` like every other author-supplied label. Resolving it HERE (not in the
    // controls) is what keeps it out of the markup as a JSON blob — `{{ o.label }}` would stringify the map.
    choices: o.choices.map((c) => ({ ...c, label: resolveLocalized(c.label, lang.value) ?? c.value })),
    multiple: !!o.multiple,
    buttons: o.display === 'buttons',
  }
})
const required = computed(() => !!props.field.required)

// Narrowing proxies so each control gets its precise model type. For the single <select>, map null↔''
// (the empty option's value) so an optional choice can REPRESENT "no value" (null shows the empty option
// instead of defaulting to the first choice) and be CLEARED back to null by re-selecting it.
const single = computed<string | null>({
  get: () => (typeof model.value === 'string' ? model.value : ''),
  set: (v) => { model.value = v ? v : null },
})
// An optional single choice gets a leading empty option so null is selectable/clearable; a required one
// has none (validation enforces a pick), keeping its existing behaviour.
const singleOptions = computed(() =>
  required.value ? cfg.value.choices : [{ label: '—', value: '' }, ...cfg.value.choices],
)
const multi = computed<string[]>({
  get: () => (Array.isArray(model.value) ? model.value : []),
  set: (v) => { model.value = v },
})
</script>

<template>
  <UiField v-if="!cfg.multiple && !cfg.buttons" :id="id" :label="name" :error="error" :required="required">
    <template #default="f">
      <UiSelect v-model="single" :options="singleOptions" :disabled="disabled" v-bind="f" />
    </template>
  </UiField>
  <UiFieldset v-else :id="id" :label="name" :error="error" :required="required">
    <template #default="f">
      <UiButtonGroup
        v-if="cfg.buttons"
        v-model="model"
        :options="cfg.choices"
        :multiple="cfg.multiple"
        :disabled="disabled"
        v-bind="f"
      />
      <UiCheckboxGroup
        v-else
        v-model="multi"
        :options="cfg.choices"
        :disabled="disabled"
        v-bind="f"
      />
    </template>
  </UiFieldset>
</template>
