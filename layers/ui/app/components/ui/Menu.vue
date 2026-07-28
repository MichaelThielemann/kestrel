<script setup lang="ts">
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuPortal, ContextMenuContent, ContextMenuItem } from 'reka-ui'

export interface MenuItem { label: string; value: string; danger?: boolean; disabled?: boolean }
defineProps<{ items: MenuItem[] }>()
const emit = defineEmits<{ select: [string] }>()
</script>

<template>
  <ContextMenuRoot>
    <ContextMenuTrigger as-child>
      <slot />
    </ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent class="ui-menu" :collision-padding="8">
        <ContextMenuItem
          v-for="it in items"
          :key="it.value"
          :disabled="it.disabled"
          class="ui-menu__item"
          :class="{ 'ui-menu__item--danger': it.danger }"
          @select="emit('select', it.value)"
        >{{ it.label }}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>

<style lang="scss">
// Not scoped: Reka teleports the menu content to <body>, where a scoped data-v selector would no
// longer match — so the surface background/border silently dropped out (Image: a backgroundless,
// hard-to-read context menu). The other portaled overlays (Combobox/DatePicker/Select) are global too.
.ui-menu {
  min-width: 11rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  padding: var(--space-1);
  z-index: var(--z-dropdown);
}
.ui-menu__item {
  display: block;
  width: 100%;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  cursor: pointer;
  user-select: none;
  &[data-highlighted] { background: var(--color-hover); outline: none; }
  &[data-disabled] { color: var(--color-text-muted); cursor: default; }
  &--danger { color: var(--color-danger); }
}
</style>
