<script setup lang="ts">
withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false })

const model = defineModel<string | null>()
</script>

<template>
  <!-- eslint-disable-next-line vuejs-accessibility/form-control-has-label -- id/label land via Vue's default attrs fallthrough (single root element) from the wrapping UiField -->
  <input v-model="model" type="time" :disabled="disabled" class="ui-time">
</template>

<style lang="scss">
@use '../../assets/scss/mixins';

.ui-time {
  @include mixins.input-base;
}
</style>
