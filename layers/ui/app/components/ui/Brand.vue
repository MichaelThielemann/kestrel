<script setup lang="ts">
// The Kestrel brand mark. The wordmark and the surrounding wrapper (a NuxtLink in the rail, a static
// heading on the login screen) stay with each caller.
</script>

<template>
  <span class="ui-brand-mark" aria-hidden="true">K</span>
</template>

<style lang="scss">
.ui-brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: var(--radius-md);
  background: var(--color-primary);
  color: var(--color-on-primary);
}
</style>
