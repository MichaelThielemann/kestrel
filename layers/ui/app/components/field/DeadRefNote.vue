<script setup lang="ts">
// The per-field stale-reference warning, rendered by the shared FieldLayout. Non-blocking note,
// distinct from the field's red validation error. Lives in the ui layer so the shared renderer
// references it without a ui→admin dependency; its path-derived auto-import name stays
// `FieldDeadRefNote`, so callers are unchanged.
defineProps<{ show: boolean }>()
const { t } = useT()
</script>

<template>
  <p v-if="show" class="field-dead-ref" role="note">
    <UiIcon name="triangle-alert" :size="13" class="field-dead-ref__icon" />{{ t('deadRefs.fieldNote') }}
  </p>
</template>

<style lang="scss">
.field-dead-ref {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-warning-text); /* warning conveyed as TEXT → needs 4.5:1, not the 3:1 icon accent */
}
.field-dead-ref__icon {
  flex-shrink: 0;
}
</style>
