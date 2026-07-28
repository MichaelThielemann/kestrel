<script setup lang="ts">
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipPortal, TooltipContent } from 'reka-ui'

// A hover/focus tooltip primitive (auto-imported as `UiTooltip`). The default slot is the trigger
// (`as-child`, so it must be a single element); the `content` slot is the floating panel. Self-contained
// `TooltipProvider` so it works anywhere without an app-root provider. PORTALED (escapes the action-bar's
// `overflow`/stacking context), so its styles are global — see below.
withDefaults(defineProps<{ side?: 'top' | 'right' | 'bottom' | 'left'; delay?: number }>(), {
  side: 'top',
  delay: 150,
})
</script>

<template>
  <TooltipProvider :delay-duration="delay">
    <TooltipRoot>
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent class="ui-tooltip" :side="side" :side-offset="6" :collision-padding="8">
          <slot name="content" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

<style lang="scss">
// Not scoped: Reka teleports the content to <body>, where a scoped data-v selector no longer matches
// (the same reason UiMenu and the other portaled overlays keep global styles — see the
// `reka-portal-scoped-styles` note). `--z-toast` keeps it above dropdowns/dialogs it may overlap.
.ui-tooltip {
  max-width: 22rem;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  z-index: var(--z-toast);
}
</style>
