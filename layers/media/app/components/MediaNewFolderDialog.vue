<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ create: [string]; 'update:open': [boolean] }>()

const { t } = useT()
const name = ref('')

watch(() => props.open, (o) => { if (o) name.value = '' })

function onCreate() {
  const v = name.value.trim()
  if (!v) return
  emit('create', v)
  emit('update:open', false)
}
</script>

<template>
  <KestrelUiDialog :open="open" :title="t('media.newFolder')" @update:open="(v) => emit('update:open', v)">
    <KestrelUiField :label="t('media.folderName')">
      <template #default="f">
        <KestrelUiTextInput v-model="name" :placeholder="t('media.folderNamePlaceholder')" v-bind="f" @keydown.enter="onCreate" />
      </template>
    </KestrelUiField>
    <template #footer>
      <KestrelUiButton @click="emit('update:open', false)">{{ t('common.cancel') }}</KestrelUiButton>
      <KestrelUiButton variant="primary" :disabled="!name.trim()" @click="onCreate">{{ t('common.create') }}</KestrelUiButton>
    </template>
  </KestrelUiDialog>
</template>
