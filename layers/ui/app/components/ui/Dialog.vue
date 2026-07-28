<script setup lang="ts">
import { DialogRoot, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui'
import UiIcon from './Icon.vue'

const props = defineProps<{ open: boolean; title: string; description?: string; size?: 'md' | 'lg' | 'xl' }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()
const { t } = useT()

// Rendering in place means dialog inputs are form-associated with any ancestor form (the record
// editor): Enter in a text-entry input would implicitly submit it — saving the half-edited record
// from inside a picker. Swallow that default here; Enter on buttons (and click-like inputs) keeps
// its activation behavior, and a dialog can still opt into Enter via its own @keydown.enter handler.
const CLICK_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'file'])
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.isComposing) return
  const el = e.target
  if (el instanceof HTMLInputElement && !CLICK_INPUT_TYPES.has(el.type)) e.preventDefault()
}
</script>

<template>
  <!-- Reka Dialog, rendered IN PLACE (no DialogPortal). Reka provides the focus trap, scroll lock,
       Escape/outside-click dismissal, ARIA wiring and focus restore; rendering in place (rather than
       teleporting) keeps the dialog synchronously DOM-testable and needs no force-mount hack. The
       admin's flat layouts don't need a portal to escape clipping — add DialogPortal here if that
       ever changes. -->
  <DialogRoot :open="props.open" @update:open="emit('update:open', $event)">
    <DialogOverlay class="ui-dialog__overlay" />
    <DialogContent
      class="ui-dialog__content"
      :class="`ui-dialog__content--${size ?? 'md'}`"
      v-bind="description ? {} : { 'aria-describedby': undefined }"
      @keydown="onKeydown"
    >
      <header class="ui-dialog__header">
        <DialogTitle class="ui-dialog__title">{{ title }}</DialogTitle>
        <DialogClose data-test="dialog-close" class="ui-dialog__close" :aria-label="t('common.close')"><UiIcon name="x" :size="16" /></DialogClose>
      </header>
      <DialogDescription v-if="description" class="ui-dialog__desc">{{ description }}</DialogDescription>
      <div class="ui-dialog__body"><slot /></div>
      <footer v-if="$slots.footer" class="ui-dialog__footer"><slot name="footer" /></footer>
    </DialogContent>
  </DialogRoot>
</template>

<style lang="scss" scoped>
.ui-dialog__overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  background: var(--color-scrim);
}
.ui-dialog__content {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: var(--z-dialog);
  max-height: calc(100svh - var(--space-6));
  overflow: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-4);

  &:focus,
  &:focus-visible { outline: none; }
}
.ui-dialog__content--md { width: min(32rem, calc(100vw - 2rem)); }
.ui-dialog__content--lg { width: min(64rem, calc(100vw - 2rem)); }
.ui-dialog__content--xl { width: min(80rem, calc(100vw - 2rem)); }
.ui-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.ui-dialog__title {
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
  margin: 0;
}
.ui-dialog__desc {
  margin: 0 0 var(--space-3);
  color: var(--color-text-muted);
}
.ui-dialog__close {
  background: none;
  border: 0;
  font-size: var(--text-xl);
  line-height: 1;
  cursor: pointer;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);

  &:hover { background: var(--color-hover); color: var(--color-text); }
  &:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
}
.ui-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
</style>
