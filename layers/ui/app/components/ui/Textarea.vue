<script setup lang="ts">
withDefaults(
  defineProps<{
    rows?: number
    placeholder?: string
    disabled?: boolean
  }>(),
  { rows: 4, disabled: false },
)

const model = defineModel<string | null>()
</script>

<template>
  <textarea
    v-model="model"
    :rows="rows"
    :placeholder="placeholder"
    :disabled="disabled"
    class="ui-textarea"
  />
</template>

<style lang="scss">
@use '../../assets/scss/mixins' as *;

.ui-textarea {
  @include input-base;
  width: 100%;
  font-family: inherit;
  line-height: var(--leading-normal);
  resize: vertical;

  &::placeholder {
    color: var(--color-text-muted);
  }
}
</style>
