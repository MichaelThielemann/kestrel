<script setup lang="ts">
import { columnLabel } from '../utils/list-cell'
import type { ListColumn } from '../utils/list-columns'

defineProps<{ columns: ListColumn[]; visibleKeys: string[]; isDefault: boolean }>()
const emit = defineEmits<{ toggle: [key: string]; reset: [] }>()

const { t } = useT()
const colLabel = (col: ListColumn) => columnLabel(col, t)
</script>

<template>
  <div id="list-columns-panel" class="list__panel">
    <!-- eslint-disable-next-line vuejs-accessibility/label-has-for -- native wrapping label around a custom UiCheckbox; no `for`/`id` pair needed, invisible to static analysis -->
    <label v-for="c in columns" :key="c.key" class="list__col-row">
      <UiCheckbox
        class="list__col-check"
        :data-col="c.key"
        :model-value="visibleKeys.includes(c.key)"
        :disabled="visibleKeys.length === 1 && visibleKeys.includes(c.key)"
        @update:model-value="() => emit('toggle', c.key)"
      />
      <span>{{ colLabel(c) }}</span>
    </label>
    <button v-if="!isDefault" type="button" class="list__panel-action" @click="emit('reset')">{{ t('list.columnsReset') }}</button>
  </div>
</template>

<style lang="scss">
.list__col-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  cursor: pointer;
}
</style>
