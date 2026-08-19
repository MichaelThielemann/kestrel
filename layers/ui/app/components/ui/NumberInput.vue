<script setup lang="ts">
import { computed } from 'vue'

// Attrs (id, aria-*) must land on the inner <input>, not the suffix wrapper, so the field label's
// `for` keeps pointing at the control. With no suffix the input still receives them via v-bind="$attrs".
defineOptions({ inheritAttrs: false })

withDefaults(
  defineProps<{
    min?: number
    max?: number
    step?: number | 'any'
    placeholder?: string
    disabled?: boolean
    // Display-only suffix (e.g. 'rem'). When set, the input gains a trailing adornment; the emitted
    // model value is still a bare number. When absent, the plain `<input class="ui-number">` renders.
    suffix?: string
    /** Tighter padding for dense chrome (toolbars). Still meets the AA minimum target size. */
    slim?: boolean
  }>(),
  { disabled: false, slim: false },
)

const model = defineModel<number | null>()

// Bound with `v-model` rather than :value/@input on purpose: mid-edit text like '1.0' parses to the
// number 1, and a plain :value binding would write that back over the text, deleting the trailing digit
// and moving the caret ('1.05' would end up as 15). v-model's directive skips the DOM write while the
// field is focused and its text still parses to the same number, so typing stays intact.
// The proxy only maps the empty field to null; v-model already hands over a number for a number input.
const text = computed<number | string>({
  get: () => model.value ?? '',
  set: (v) => { model.value = v === '' ? null : Number(v) },
})

// A number input can hold editing text the browser can't parse ('-', '1e'); its DOM value is then ''
// and the model already null, so a save would silently drop what the user still sees in the field.
// Snap the text back to the model so the field never shows a value that wouldn't be saved.
// (Assigning `value` clears the unparsable editing text even though the raw value is already ''.)
function snapBack(el: HTMLInputElement) {
  if (el.validity?.badInput) el.value = model.value == null ? '' : String(model.value)
}
function onBlur(e: Event) {
  snapBack(e.target as HTMLInputElement)
}
// Enter fires the ancestor form's implicit submission WITHOUT a preceding blur, so the blur guard
// can't run — with the form's native validation off, a null would be saved while unparsable text
// still shows. Suppress that submit and snap back so the mismatch is corrected and visible instead.
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.isComposing) return
  const el = e.target as HTMLInputElement
  if (el.validity?.badInput) { e.preventDefault(); snapBack(el) }
}
</script>

<template>
  <div v-if="suffix" class="ui-number-wrap" :class="{ 'ui-number-wrap--slim': slim }" :data-disabled="disabled || undefined">
    <!-- eslint-disable-next-line vuejs-accessibility/form-control-has-label -- id/label land via v-bind="$attrs" from the wrapping UiField, invisible to static analysis -->
    <input
      v-model="text"
      type="number"
      :min="min"
      :max="max"
      :step="step"
      :placeholder="placeholder"
      :disabled="disabled"
      class="ui-number-wrap__input"
      v-bind="$attrs"
      @blur="onBlur"
      @keydown="onKeydown"
    >
    <span class="ui-number-wrap__suffix" aria-hidden="true">{{ suffix }}</span>
  </div>
  <!-- eslint-disable-next-line vuejs-accessibility/form-control-has-label -- id/label land via v-bind="$attrs" from the wrapping UiField, invisible to static analysis -->
  <input
    v-else
    v-model="text"
    type="number"
    :min="min"
    :max="max"
    :step="step"
    :placeholder="placeholder"
    :disabled="disabled"
    class="ui-number"
    :class="{ 'ui-number--slim': slim }"
    v-bind="$attrs"
    @blur="onBlur"
    @keydown="onKeydown"
  >
</template>

<style lang="scss">
@use '../../assets/scss/mixins';

.ui-number {
  @include mixins.input-base;
  width: 100%;

  &::placeholder {
    color: var(--color-text-muted);
  }
  &--slim {
    @include mixins.input-slim;
  }
}

// Suffix variant (opt-in via the `suffix` prop). The border/radius live on the wrapper; the inner input
// is borderless + transparent so it reads as one control, mirroring the slug prefix adornment.
.ui-number-wrap {
  display: flex;
  align-items: stretch;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--color-control-border, var(--color-border));
  border-radius: var(--radius-md);
  background: var(--color-surface);
  overflow: hidden; // clip the square-cornered suffix background to the wrapper's rounded border

  &:focus-within {
    outline: 2px solid var(--color-focus);
    outline-offset: -2px;
  }
  &[data-disabled] {
    opacity: 0.6;
    cursor: not-allowed;
  }
  // input-base flags the invalid state on the input's own border; here the border lives on the wrapper
  // while the inner input is borderless, so mirror it so a unit field shows the same red invalid border.
  &:has(.ui-number-wrap__input[aria-invalid='true']) {
    border-color: var(--color-danger);
  }

  &__input {
    flex: 1 1 auto;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border: 0;
    background: transparent;
    color: var(--color-text);
    font-size: var(--text-base);

    &:focus-visible {
      outline: none;
    }
    &::placeholder {
      color: var(--color-text-muted);
    }
    &:disabled {
      cursor: not-allowed;
    }
  }

  &__suffix {
    display: inline-flex;
    align-items: center;
    padding-inline: var(--space-3);
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    border-left: 1px solid var(--color-control-border, var(--color-border));
    font-size: var(--text-sm);
    white-space: nowrap;
  }
}

// Slim adornment variant: the wrapper keeps its border/radius, only the inner box tightens. Written as a
// separate rule (not nested) so `.ui-number-wrap--slim .ui-number-wrap__input` outranks the base element rule.
.ui-number-wrap--slim {
  .ui-number-wrap__input {
    @include mixins.input-slim;
  }
  .ui-number-wrap__suffix {
    padding-inline: var(--space-2);
  }
}
</style>
