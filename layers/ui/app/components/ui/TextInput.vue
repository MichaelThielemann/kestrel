<script setup lang="ts">
import { ref, computed } from 'vue'

// `$attrs` (id / aria-* from UiField, autocomplete, …) is bound to the inner <input>, not the wrapper,
// so the field-label association + error wiring keep working with the reveal button in place.
defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    type?: 'text' | 'password' | 'email' | 'url' | 'search' | 'tel'
    placeholder?: string
    disabled?: boolean
    /** Force the show/hide reveal affordance on a non-password input. Password inputs get it automatically. */
    reveal?: boolean
    /** Tighter padding for dense chrome (toolbars). Still meets the AA minimum target size. */
    slim?: boolean
  }>(),
  { type: 'text', disabled: false, reveal: false, slim: false },
)

const model = defineModel<string | null>()
const { t } = useT()

// Reveal is automatic for password inputs (the only consumer today), opt-in elsewhere via `reveal`.
const revealable = computed(() => props.type === 'password' || props.reveal)
const revealed = ref(false)
// While revealed, a password input becomes a text input so the typed value is legible; other types
// are unaffected. The control is a switch — the rendered type tracks `revealed` exactly.
const inputType = computed(() => (revealable.value && revealed.value ? 'text' : props.type))
</script>

<template>
  <div class="ui-input-wrap">
    <!-- eslint-disable-next-line vuejs-accessibility/form-control-has-label -- id/label land via v-bind="$attrs" from the wrapping UiField, invisible to static analysis -->
    <input
      v-model="model"
      :type="inputType"
      :placeholder="placeholder"
      :disabled="disabled"
      class="ui-input"
      :class="{ 'ui-input--revealable': revealable, 'ui-input--slim': slim }"
      v-bind="$attrs"
    >
    <button
      v-if="revealable"
      type="button"
      class="ui-input__reveal"
      :disabled="disabled"
      :aria-label="revealed ? t('input.hidePassword') : t('input.showPassword')"
      @click="revealed = !revealed"
    >
      <UiIcon :name="revealed ? 'eye-off' : 'eye'" size="1.125rem" />
    </button>
  </div>
</template>

<style lang="scss">
@use '../../assets/scss/mixins' as *;

.ui-input-wrap {
  position: relative;
  display: block;
  width: 100%;
}

.ui-input {
  @include input-base;
  width: 100%;

  &::placeholder {
    color: var(--color-text-muted);
  }

  &--slim {
    @include input-slim;
  }

  // Leave room for the inset reveal button so the value never sits under it. Declared after `--slim` so a
  // slim revealable input keeps the reveal gutter (equal specificity → source order wins).
  &--revealable {
    padding-inline-end: 2.5rem;
  }
}

.ui-input__reveal {
  @include focus-ring;
  position: absolute;
  inset-block: 1px;
  inset-inline-end: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  // ≥24×24 target (WCAG 2.5.8): full input height, comfortable hit width.
  min-inline-size: 2.25rem;
  padding-inline: var(--space-2);
  border: 0;
  border-start-end-radius: var(--radius-md);
  border-end-end-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--color-text);
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
}
</style>
