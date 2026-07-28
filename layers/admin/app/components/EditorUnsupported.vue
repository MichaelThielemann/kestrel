<script setup lang="ts">
// Fallback body when a collection's `editor` type has no registered body (an extension misconfig or a
// missing plugin). Fails visibly instead of rendering blank.
defineProps<{ editor: string }>()
const { t } = useT()
</script>

<template>
  <div class="editor-unsupported">
    <p class="editor-unsupported__note">{{ t('editor.unsupported', { type: editor }) }}</p>
  </div>
</template>

<style lang="scss">
.editor-unsupported {
  flex: 1 1 auto;
  min-height: 0;

  &__note {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
  }
}
</style>
