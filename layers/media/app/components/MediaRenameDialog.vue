<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const props = defineProps<{ open: boolean; name: string; busy?: boolean; error?: string | null }>()
const emit = defineEmits<{ rename: [string]; 'update:open': [boolean] }>()

const draft = ref(props.name)
watch(() => props.open, (o) => { if (o) draft.value = props.name })

const { t } = useT()

const canRename = computed(() => {
  const v = draft.value.trim()
  return !!v && v !== props.name
})
function submit() { if (canRename.value && !props.busy) emit('rename', draft.value.trim()) }
</script>

<template>
  <UiDialog :open="open" :title="t('media.rename')" @update:open="(v) => emit('update:open', v)">
    <UiField :label="t('media.newName')">
      <template #default="f">
        <UiTextInput v-model="draft" v-bind="f" @keydown.enter="submit" />
      </template>
    </UiField>
    <UiAlert v-if="error" variant="error">{{ error }}</UiAlert>
    <template #footer>
      <UiButton :disabled="busy" @click="emit('update:open', false)">{{ t('common.cancel') }}</UiButton>
      <UiButton variant="primary" :disabled="busy || !canRename" @click="submit">{{ t('media.rename') }}</UiButton>
    </template>
  </UiDialog>
</template>
