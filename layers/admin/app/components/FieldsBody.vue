<script setup lang="ts">
// The schema-driven default editor body: a plain field list. All state comes from the editor form
// context provided by CollectionEditor; this body only lays it out.
const ctx = useEditorFormContext()
</script>

<template>
  <div class="editor__flat">
    <KestrelPageFieldsPane v-bind="ctx.pageFieldsBindings.value" v-on="ctx.pageFieldsHandlers" />
  </div>
</template>

<style lang="scss">
// Flat-collection field list: its own scroll region, so the shell's actions row stays pinned below it.
.editor__flat {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
