<script setup lang="ts">
withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false })

const model = defineModel<string | null>()
</script>

<template>
  <input v-model="model" type="time" :disabled="disabled" class="ui-time">
</template>

<style lang="scss">
@use '../../assets/scss/mixins' as *;

.ui-time {
  @include input-base;
}
</style>
