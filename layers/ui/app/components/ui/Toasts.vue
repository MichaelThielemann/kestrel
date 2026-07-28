<script setup lang="ts">
// App-wide transient notifications. Teleported to <body> so it floats above any layout/dialog;
// the queue lives in `useToast` (unit-tested), this is the thin render of it.
const toasts = useToast()
const { t } = useT()
</script>

<template>
  <Teleport to="body">
    <!-- Two PERSISTENT live regions that exist before any toast: a screen reader only announces changes to
         a live region already in the DOM, so a role placed on the freshly-inserted toast node is missed.
         The visual cards below carry no live role; these mirror their text (errors → assertive). -->
    <div class="ui-toasts__live" aria-live="polite" role="status">
      <template v-for="toast in toasts.items" :key="`p-${toast.id}`">
        <div v-if="toast.type !== 'error'">{{ toast.message }}</div>
      </template>
    </div>
    <div class="ui-toasts__live" aria-live="assertive" role="alert">
      <template v-for="toast in toasts.items" :key="`a-${toast.id}`">
        <div v-if="toast.type === 'error'">{{ toast.message }}</div>
      </template>
    </div>
    <div class="ui-toasts" role="region" :aria-label="t('toast.region')">
      <TransitionGroup name="ui-toast">
        <div
          v-for="toast in toasts.items"
          :key="toast.id"
          class="ui-toast"
          :class="`ui-toast--${toast.type}`"
        >
          <span class="ui-toast__msg">{{ toast.message }}</span>
          <button type="button" class="ui-toast__close" :aria-label="t('toast.dismiss')" @click="toasts.dismiss(toast.id)">
            <UiIcon name="x" size="0.875rem" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style lang="scss">
@use '../../assets/scss/mixins' as *;

.ui-toasts__live { @include sr-only; }

.ui-toasts {
  position: fixed;
  inset-block-end: var(--space-5);
  inset-inline-end: var(--space-5);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: min(22rem, calc(100vw - var(--space-8)));
  pointer-events: none;
}

.ui-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-inline-start: 4px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  font-size: var(--text-sm);

  &--success { border-inline-start-color: var(--color-success); }
  &--error { border-inline-start-color: var(--color-danger); }
  &--info { border-inline-start-color: var(--color-primary); }

  &__msg { flex: 1 1 auto; min-width: 0; }

  &__close {
    @include focus-ring;
    flex-shrink: 0;
    display: inline-flex;
    padding: var(--space-1);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted);

    &:hover { background: var(--color-hover); color: var(--color-text); }
  }
}

.ui-toast-enter-active,
.ui-toast-leave-active {
  transition:
    opacity var(--motion-base) var(--ease-standard),
    transform var(--motion-base) var(--ease-standard);
}
.ui-toast-enter-from,
.ui-toast-leave-to {
  opacity: 0;
  transform: translateY(var(--space-3));
}
</style>
