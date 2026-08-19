<script setup lang="ts">
import { computed, ref } from 'vue'
import type { IconName } from '../../../ui/app/utils/icons'

type View = 'grid' | 'table'

const props = defineProps<{ view: View; search: string; disabled?: boolean }>()
const emit = defineEmits<{
  'update:view': [View]
  'update:search': [string]
  upload: [File[]]
  'new-folder': []
}>()

const { t } = useT()

const VIEW_OPTIONS = computed<{ label: string; value: string; icon: IconName }[]>(() => [
  { label: t('mediaToolbar.viewGrid'), value: 'grid', icon: 'layout-grid' },
  { label: t('mediaToolbar.viewTable'), value: 'table', icon: 'table' },
])

const viewModel = computed<string | string[] | null>({
  get: () => props.view,
  set: (v) => { if (typeof v === 'string') emit('update:view', v as View) },
})

const fileInput = ref<HTMLInputElement | null>(null)

function onFiles(e: Event) {
  const input = e.target as HTMLInputElement
  emit('upload', Array.from(input.files ?? []))
  input.value = ''
}
</script>

<template>
  <div class="media-toolbar">
    <KestrelUiTextInput
      class="media-toolbar__search"
      :model-value="search"
      type="search"
      :placeholder="t('mediaToolbar.searchPlaceholder')"
      :aria-label="t('mediaToolbar.searchAriaLabel')"
      @update:model-value="(v) => emit('update:search', v ?? '')"
    />
    <!-- View toggle + actions sit together on the right so they read as one control cluster. -->
    <div class="media-toolbar__actions">
      <KestrelUiButtonGroup v-model="viewModel" :options="VIEW_OPTIONS" :aria-label="t('mediaToolbar.viewAriaLabel')" />
      <span class="media-toolbar__divider" aria-hidden="true"></span>
      <input ref="fileInput" type="file" multiple class="media-toolbar__file" :aria-label="t('mediaToolbar.upload')" @change="onFiles" />
      <KestrelUiButton :disabled="disabled" @click="fileInput?.click()"><KestrelUiIcon name="upload" :size="16" /> {{ t('mediaToolbar.upload') }}</KestrelUiButton>
      <KestrelUiButton :disabled="disabled" @click="emit('new-folder')"><KestrelUiIcon name="folder-plus" :size="16" /> {{ t('mediaToolbar.newFolder') }}</KestrelUiButton>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.media-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  row-gap: var(--space-2);
  align-items: center;

  &__search {
    flex: 1 1 16rem;
    min-width: 0;
    max-width: 24rem;
    margin-right: auto;
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  &__divider {
    align-self: stretch;
    width: 1px;
    min-height: 1.5rem;
    background: var(--color-border);
    margin: 0 var(--space-1);
  }

  &__file {
    display: none;
  }
}
</style>
