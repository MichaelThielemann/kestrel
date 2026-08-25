<script setup lang="ts">
import { computed } from 'vue'
import type { LayoutNode, SerializedBlock } from '@kestrel/core'
import type { BlockRow } from '../utils/block-tree'
import { resolveLocalized } from '../../../ui/app/utils/localized'

// The fields pane for the currently selected block: delegates to the shared <KestrelFieldLayout> renderer,
// driven by the selected block's props. `def` is the selected block's resolved definition (the parent
// already has it). Errors are the id-keyed BlockErrorMap entry for this block (depth-independent); edits
// emit (key, value) for an id-addressed setProp on the shared tree.
const props = defineProps<{
  block: BlockRow
  def?: SerializedBlock
  locale: string
  errors?: Record<string, string>
  /** Field keys in this block that hold a stale reference — shown as a non-blocking warning note. */
  deadFields?: Set<string>
  disabled?: boolean
}>()
const emit = defineEmits<{ update: [key: string, value: unknown] }>()

const { t, lang } = useT()
const subFields = computed(() =>
  Object.fromEntries(Object.entries(props.def?.fields ?? {}).map(([k, v]) => [k, asFieldDef(v)])),
)
// Block-level `fieldLayout` authoring is deferred (v1 ships collections + repeaters); the render path is
// already layout-ready via this cast, so a future serializeBlock that carries a layout flows through with
// no further change. One documented cast, same category as `asFieldDef`.
const blockLayout = computed(() => (props.def as { fieldLayout?: LayoutNode[] } | undefined)?.fieldLayout)
</script>

<template>
  <div class="block-fields">
    <p class="block-fields__title">{{ resolveLocalized(def?.label, lang) ?? block.type }}</p>
    <KestrelFieldLayout
      :layout="blockLayout"
      :fields="subFields"
      :values="block.props"
      :errors="errors"
      :dead-fields="deadFields"
      :locale="locale"
      :disabled="disabled"
      @update="(key, value) => emit('update', key, value)"
    />
    <p v-if="!Object.keys(subFields).length" class="block-fields__empty">{{ t('blocks.noFields') }}</p>
  </div>
</template>

<style lang="scss">
.block-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);

  &__title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-muted);
    text-transform: capitalize;
  }
  &__empty {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }
}
</style>
