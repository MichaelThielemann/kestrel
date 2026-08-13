<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import UiIcon from './Icon.vue'
import {
  ComboboxRoot, ComboboxAnchor, ComboboxInput, ComboboxTrigger, ComboboxCancel,
  ComboboxContent, ComboboxViewport, ComboboxItem, ComboboxItemIndicator,
} from 'reka-ui'
import type { FieldOption } from '../../utils/field-component'
import { reorder } from '../../utils/reorder'

const props = withDefaults(
  defineProps<{
    options: FieldOption[]
    selected: FieldOption[]
    multiple?: boolean
    loading?: boolean
    placeholder?: string
    disabled?: boolean
    inputId?: string
    invalid?: boolean
    describedby?: string
    required?: boolean
  }>(),
  { multiple: false, loading: false, disabled: false, invalid: false, required: false },
)

const model = defineModel<number | number[] | null>()
const emit = defineEmits<{ search: [term: string] }>()

const query = ref('')

// Reka's root model: an array for multiple, the value (or undefined) for single.
const rootModel = computed<number | number[] | undefined>({
  get: () => (props.multiple
    ? (Array.isArray(model.value) ? model.value : [])
    : (typeof model.value === 'number' ? model.value : undefined)),
  set: (v) => { model.value = props.multiple ? ((v as number[]) ?? []) : (typeof v === 'number' ? v : null) },
})

function labelFor(id: number): string {
  return props.selected.find((s) => s.value === id)?.label
    ?? props.options.find((o) => o.value === id)?.label
    ?? `#${id}`
}
const displayValue = (id: unknown) => (typeof id === 'number' ? labelFor(id) : '')

// In single mode Reka resyncs the input text to the selected label on select/blur;
// that programmatic update must not be treated as a user search.
const currentLabel = computed(() => (!props.multiple && typeof model.value === 'number' ? labelFor(model.value) : null))

// A selected label can resolve asynchronously (id known, label fetched later) with no model change,
// which Reka's display-value callback won't re-evaluate — mirror it into the single-mode input.
watch(currentLabel, (lbl) => { if (lbl != null) query.value = lbl })

function onInput(term: string) {
  query.value = term
  if (term === currentLabel.value) return
  emit('search', term)
}
// Focusing an empty box loads the first page of records, so options appear without typing.
function onFocus() {
  if (!query.value.trim()) emit('search', '')
}
function removeChip(id: number) {
  if (Array.isArray(model.value)) model.value = model.value.filter((v) => v !== id)
}

const { t } = useT()

const chips = ref<HTMLElement | null>(null)
const liveMessage = ref('')

function announceMove(label: string, to: number) {
  liveMessage.value = t('combobox.moved', { label, pos: to + 1, total: props.selected.length })
}

// The chip index IS the model index here, so commit reorders the model directly.
const { dragIndex, overIndex, onDragStart, onDragEnter, onDragLeave, onDrop, onDragEnd } = useDragReorder({
  disabled: () => props.disabled || !Array.isArray(model.value),
  commit: (from, to) => {
    // Re-stated here rather than relying on the `disabled` predicate above: only the local check narrows
    // the model to the multi-value array `reorder` returns (and that `model.value` accepts back).
    if (!Array.isArray(model.value)) return
    const label = props.selected[from]?.label ?? ''
    model.value = reorder(model.value, from, to)
    nextTick(() => announceMove(label, to))
  },
})

function moveChip(from: number, to: number) {
  if (props.disabled || !Array.isArray(model.value) || to < 0 || to >= model.value.length) return
  const dir = to < from ? 'earlier' : 'later'
  const label = props.selected[from]?.label ?? ''
  model.value = reorder(model.value, from, to)
  // Keep keyboard focus on the moved chip: keyed reuse preserves it for the pressed button, but when that
  // button becomes disabled at a boundary the browser drops focus to <body> — redirect to the remove button.
  nextTick(() => {
    announceMove(label, to)
    const chip = chips.value?.children[to] as HTMLElement | undefined
    if (!chip) return
    const moveBtns = chip.querySelectorAll<HTMLButtonElement>('.ui-combobox__chip-move')
    const dirBtn = dir === 'earlier' ? moveBtns[0] : moveBtns[1]
    ;(dirBtn && !dirBtn.disabled ? dirBtn : chip.querySelector<HTMLButtonElement>('.ui-combobox__chip-remove'))?.focus()
  })
}
</script>

<template>
  <ComboboxRoot
    v-model="rootModel"
    :multiple="multiple"
    :disabled="disabled"
    ignore-filter
    reset-model-value-on-clear
    :open-on-click="true"
    :open-on-focus="true"
    class="ui-combobox"
  >
    <ComboboxAnchor class="ui-combobox__anchor" :data-multiple="multiple || undefined" :aria-invalid="invalid || undefined">
      <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions, vuejs-accessibility/no-redundant-roles -- @dragleave is a mouse-only progressive enhancement (the chip-move buttons below give the same reorder fully keyboard access); role="list" is NOT redundant here, `list-style: none` below strips the implicit list semantics in WebKit, see the "WebKit list-semantics fix" test -->
      <ul v-if="multiple && selected.length" ref="chips" class="ui-combobox__chips" role="list" @dragleave="onDragLeave">
        <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -- drag handlers are a mouse-only progressive enhancement; the chip-move buttons below give the same reorder fully keyboard access -->
        <li
          v-for="(s, i) in selected"
          :key="s.value"
          class="ui-combobox__chip"
          :class="{ 'ui-combobox__chip--over': overIndex === i && dragIndex !== i }"
          :draggable="!disabled"
          @dragstart="onDragStart(i, $event)"
          @dragenter="onDragEnter(i)"
          @dragover.prevent="onDragEnter(i)"
          @drop.prevent="onDrop(i)"
          @dragend="onDragEnd"
        >
          <button
            type="button"
            draggable="false"
            class="ui-combobox__chip-move"
            :aria-label="t('combobox.move_earlier', { label: s.label })"
            :disabled="disabled || i === 0"
            @click="moveChip(i, i - 1)"
          ><UiIcon name="chevron-left" :size="14" /></button>
          <span>{{ s.label }}</span>
          <button
            type="button"
            draggable="false"
            class="ui-combobox__chip-move"
            :aria-label="t('combobox.move_later', { label: s.label })"
            :disabled="disabled || i === selected.length - 1"
            @click="moveChip(i, i + 1)"
          ><UiIcon name="chevron-right" :size="14" /></button>
          <button
            type="button"
            draggable="false"
            class="ui-combobox__chip-remove"
            :aria-label="t('combobox.remove', { label: s.label })"
            :disabled="disabled"
            @click="removeChip(s.value)"
          ><UiIcon name="x" :size="14" /></button>
        </li>
      </ul>
      <ComboboxInput
        :id="inputId"
        class="ui-combobox__input"
        :model-value="query"
        :placeholder="placeholder"
        :display-value="multiple ? undefined : displayValue"
        :disabled="disabled"
        :aria-invalid="invalid || undefined"
        :aria-describedby="describedby"
        :required="required || undefined"
        @update:model-value="onInput"
        @focus="onFocus"
      />
      <ComboboxCancel v-if="!multiple" class="ui-combobox__icon" :aria-label="t('combobox.clear')"><UiIcon name="x" :size="14" /></ComboboxCancel>
      <ComboboxTrigger class="ui-combobox__icon" :aria-label="t('combobox.toggle_options')"><UiIcon name="chevron-down" :size="14" /></ComboboxTrigger>
    </ComboboxAnchor>

    <ComboboxContent class="ui-combobox__content" :side-offset="4">
      <ComboboxViewport class="ui-combobox__viewport">
        <p v-if="loading" class="ui-combobox__note">{{ t('combobox.loading') }}</p>
        <p v-else-if="!options.length" class="ui-combobox__note">{{ t('combobox.no_results') }}</p>
        <ComboboxItem
          v-for="o in options"
          :key="o.value"
          :value="o.value"
          class="ui-combobox__item"
        >
          <span>{{ o.label }}</span>
          <ComboboxItemIndicator class="ui-combobox__check"><UiIcon name="check" :size="14" /></ComboboxItemIndicator>
        </ComboboxItem>
      </ComboboxViewport>
    </ComboboxContent>

    <span class="ui-combobox__live" aria-live="polite">{{ liveMessage }}</span>
  </ComboboxRoot>
</template>

<style lang="scss">
@use '../../assets/scss/mixins' as *;

.ui-combobox {
  &__anchor {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-control-border, var(--color-border));
    border-radius: var(--radius-md);
    background: var(--color-surface);

    &:focus-within { outline: 2px solid var(--color-focus); outline-offset: -2px; }
    &[aria-invalid='true'] { border-color: var(--color-danger); }
  }
  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  &__chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0 var(--space-1) 0 var(--space-2);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
  }
  &__chip-remove {
    @include focus-ring;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 1.5rem;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: var(--text-base);
    line-height: 1;
  }
  &__chip-move {
    @include focus-ring;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 1.5rem;
    border: 0;
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: var(--text-base);
    line-height: 1;
    // Collapsed + transparent when idle so the chip stays compact, but NOT display/visibility:none —
    // the button must remain focusable so keyboard users can Tab to it (which then reveals it via
    // :focus-within below). Revealed on hover/focus, and always shown where there is no hover (touch).
    opacity: 0;
    max-width: 0;
    padding: 0;
    overflow: hidden;
    // animate only size, not opacity, so the focus ring shows immediately on keyboard focus
    transition: max-width 0.1s, padding 0.1s;

    &:disabled { cursor: default; } // stays collapsed (the reveal selector excludes :disabled)
  }
  &__live { @include sr-only; }
  &__chip {
    &:hover,
    &:focus-within {
      .ui-combobox__chip-move:not(:disabled) {
        opacity: 1;
        max-width: 1.5rem;
        padding: 0 var(--space-1);
      }
    }
  }
  @media (hover: none) {
    &__chip-move:not(:disabled) {
      opacity: 1;
      max-width: 1.5rem;
      padding: 0 var(--space-1);
    }
  }
  &__chip--over {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }
  &__input {
    flex: 1;
    min-width: 6rem;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--color-text);
    font-size: var(--text-base);
    padding: var(--space-1) 0;
  }
  &__icon {
    @include focus-ring;
    border: 0;
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
  }
  &__content {
    z-index: var(--z-dropdown);
    width: var(--reka-combobox-trigger-width);
    max-height: 16rem;
    overflow: hidden;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
  }
  &__viewport {
    max-height: 16rem;
    overflow-y: auto;
    padding: var(--space-1);
  }
  &__note {
    padding: var(--space-2) var(--space-3);
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }
  &__item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    cursor: pointer;

    &[data-highlighted] { background: var(--color-hover); outline: none; }
    &[data-state='checked'] { font-weight: var(--weight-medium); }
  }
  &__check { color: var(--color-primary); }
}
</style>
