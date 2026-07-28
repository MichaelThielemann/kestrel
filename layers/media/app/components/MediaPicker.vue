<script setup lang="ts">
defineProps<{ open: boolean; multiple?: boolean; accept?: 'image' | 'any'; initialFolder?: string; initialSelected?: number[] }>()
const emit = defineEmits<{ confirm: [number[]]; 'update:open': [boolean] }>()
const { t } = useT()
</script>

<template>
  <UiDialog :open="open" size="lg" :title="multiple ? t('media.picker.titleMultiple') : t('media.picker.titleSingle')" @update:open="(v) => emit('update:open', v)">
    <MediaLibrary
      pick
      :multiple="multiple"
      :accept="accept ?? 'any'"
      :initial-folder="initialFolder"
      :initial-selected="initialSelected"
      @confirm="(ids) => { emit('confirm', ids); emit('update:open', false) }"
      @cancel="emit('update:open', false)"
    />
  </UiDialog>
</template>
