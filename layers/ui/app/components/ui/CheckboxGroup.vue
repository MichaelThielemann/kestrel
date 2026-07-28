<script setup lang="ts">
import { computed } from 'vue'
import UiCheckbox from './Checkbox.vue'

withDefaults(
  defineProps<{
    options: { label: string; value: string }[]
    disabled?: boolean
  }>(),
  { disabled: false },
)

const model = defineModel<string[]>()
const selected = computed(() => model.value ?? [])

function toggle(value: string, checked: boolean) {
  const set = new Set(selected.value)
  if (checked) set.add(value)
  else set.delete(value)
  model.value = [...set]
}
</script>

<template>
  <div class="ui-checkbox-group" role="group">
    <label v-for="o in options" :key="o.value" class="ui-checkbox-group__item">
      <UiCheckbox
        :model-value="selected.includes(o.value)"
        :disabled="disabled"
        @update:model-value="(c) => toggle(o.value, c)"
      />
      <span>{{ o.label }}</span>
    </label>
  </div>
</template>

<style lang="scss">
.ui-checkbox-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  &__item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
  }
}
</style>
