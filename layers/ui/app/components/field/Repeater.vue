<script setup lang="ts">
import { computed, ref, nextTick } from 'vue'
import UiIcon from '../ui/Icon.vue'
import FieldLayout from './Layout.vue'
import { useRepeater } from '../../composables/useRepeater'
import { useFieldA11y } from '../../utils/useFieldA11y'
import type { FieldComponentProps } from '../../utils/field-component'
import type { FieldDef, FieldOf, LayoutNode } from '@michaelthielemann/kestrel-core'
const props = defineProps<FieldComponentProps>()
const model = defineModel<Record<string, unknown>[] | null>()

const subFields = computed<Record<string, FieldDef>>(() =>
  props.field.type === 'repeater' ? (props.field as FieldOf<'repeater'>).options.fields : {})
// The repeater's optional sub-field layout (carried on the serialized options; undefined → flat). One
// documented cast, same category as the repeater arm's own narrowing above.
const subLayout = computed<LayoutNode[] | undefined>(() =>
  (props.field as { options?: { fieldLayout?: LayoutNode[] } }).options?.fieldLayout)
const required = computed(() => !!props.field.required)
const { rows, keys, addRow, removeRow, move, setCell, insertRow, duplicateRow } = useRepeater(model, subFields)
const { errId, describedby, ariaInvalid } = useFieldA11y(props)
const { t } = useT()

const rowsEl = ref<HTMLElement | null>(null)
const addEl = ref<HTMLButtonElement | null>(null)
const dragIndex = ref<number | null>(null)
const overIndex = ref<number | null>(null)
const liveMessage = ref('')

// Toggle a zero-width suffix so an identical message still re-triggers the polite live region.
function say(msg: string) {
  liveMessage.value = msg === liveMessage.value ? `${msg}\u200B` : msg
}
function announce(to: number) {
  say(t('field.repeater.moved', { n: to + 1, total: rows.value.length }))
}

function onDragStart(i: number, event: DragEvent) {
  if (props.disabled) return
  dragIndex.value = i
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(i))
  }
}

function onDragEnter(i: number) {
  if (dragIndex.value !== null) overIndex.value = i
}

// Clear drop highlight only when leaving the list entirely (not between sibling rows).
function onDragLeave(event: DragEvent) {
  if (!(event.currentTarget as Element).contains(event.relatedTarget as Node | null)) {
    overIndex.value = null
  }
}

function onDrop(i: number) {
  if (props.disabled || dragIndex.value === null) return
  if (dragIndex.value !== i) {
    move(dragIndex.value, i)
    nextTick(() => announce(i))
  }
  dragIndex.value = null
  overIndex.value = null
}

function onDragEnd() {
  dragIndex.value = null
  overIndex.value = null
}

function moveRow(from: number, to: number) {
  move(from, to)
  nextTick(() => {
    announce(to)
    const row = rowsEl.value?.querySelectorAll(':scope > .ui-repeater__row-wrap > .ui-repeater__row')[to] as HTMLElement | undefined
    if (!row) return
    const dir = to < from ? 'up' : 'down'
    const btns = row.querySelectorAll<HTMLButtonElement>(':scope > .ui-repeater__actions > .ui-repeater__move')
    const dirBtn = dir === 'up' ? btns[0] : btns[1]
    ;(dirBtn && !dirBtn.disabled ? dirBtn : row.querySelector<HTMLButtonElement>(':scope > .ui-repeater__actions > .ui-repeater__remove'))?.focus()
  })
}

// Keep keyboard focus in the list after deletion: the row that slid into this index, else the new last row, else Add.
function removeRowAt(i: number) {
  removeRow(i)
  say(t('field.repeater.removed', { n: i + 1, remaining: rows.value.length }))
  nextTick(() => {
    const idx = Math.min(i, rows.value.length - 1)
    const row = idx >= 0
      ? rowsEl.value?.querySelectorAll(':scope > .ui-repeater__row-wrap > .ui-repeater__row')[idx] as HTMLElement | undefined
      : undefined
    ;(row?.querySelector<HTMLButtonElement>(':scope > .ui-repeater__actions > .ui-repeater__remove') ?? addEl.value)?.focus()
  })
}

function duplicateRowAt(i: number) {
  duplicateRow(i)
  say(t('field.repeater.duplicated', { n: i + 1 }))
  nextTick(() => {
    const row = rowsEl.value?.querySelectorAll(':scope > .ui-repeater__row-wrap > .ui-repeater__row')[i + 1] as HTMLElement | undefined
    row?.querySelector<HTMLElement>('input, button:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus()
  })
}

function insertRowAt(at: number) {
  insertRow(at)
  say(t('field.repeater.inserted', { n: at + 1 }))
  nextTick(() => {
    const row = rowsEl.value?.querySelectorAll(':scope > .ui-repeater__row-wrap > .ui-repeater__row')[at] as HTMLElement | undefined
    row?.querySelector<HTMLElement>('input, button:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus()
  })
}
</script>

<template>
  <fieldset
    class="ui-repeater"
    :aria-describedby="describedby"
    :aria-invalid="ariaInvalid"
  >
    <legend class="ui-repeater__legend">
      {{ name }}<span v-if="required" aria-hidden="true">*</span>
    </legend>

    <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -- @dragleave is a mouse-only progressive enhancement; the move-up/move-down buttons below give the same reorder fully keyboard access -->
    <div ref="rowsEl" class="ui-repeater__rows" @dragleave="onDragLeave">
      <template v-for="(row, i) in rows" :key="keys[i]">
        <div class="ui-repeater__insert-zone">
          <button
            type="button"
            class="ui-repeater__insert"
            :aria-label="t('field.repeater.insert_label', { n: i + 1 })"
            :disabled="disabled"
            @click="insertRowAt(i)"
          >
            <UiIcon name="plus" :size="16" />
          </button>
        </div>

        <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -- drag handlers are a mouse-only progressive enhancement; the move-up/move-down buttons below give the same reorder fully keyboard access -->
        <div
          class="ui-repeater__row-wrap"
          :class="{ 'ui-repeater__row-wrap--over': overIndex === i && dragIndex !== i }"
          @dragenter="onDragEnter(i)"
          @dragover.prevent="onDragEnter(i)"
          @drop.prevent="onDrop(i)"
          @dragend="onDragEnd"
        >
          <div class="ui-repeater__row" role="group" :aria-label="t('field.repeater.item_label', { n: i + 1 })">
            <div
              class="ui-repeater__gutter"
              :draggable="!disabled"
              aria-hidden="true"
              @dragstart="onDragStart(i, $event)"
            >
              <span class="ui-repeater__index">{{ i + 1 }}</span>
              <UiIcon name="grip" :size="16" />
            </div>

            <div class="ui-repeater__fields">
              <!-- The shared field renderer, scoped to this row (the sibling scope for the condition gate).
                   An unmet condition unmounts the sub-field (not just hides it), so no constraint lingers. -->
              <FieldLayout
                :layout="subLayout"
                :fields="subFields"
                :values="row"
                :locale="locale"
                :disabled="disabled"
                @update="(key, value) => setCell(i, key, value)"
              />
            </div>

            <div class="ui-repeater__actions">
              <button
                type="button"
                class="ui-repeater__move"
                :aria-label="t('field.repeater.move_up', { n: i + 1 })"
                :disabled="disabled || i === 0"
                @click="moveRow(i, i - 1)"
              >
                <UiIcon name="chevron-up" :size="16" />
              </button>
              <button
                type="button"
                class="ui-repeater__move"
                :aria-label="t('field.repeater.move_down', { n: i + 1 })"
                :disabled="disabled || i === rows.length - 1"
                @click="moveRow(i, i + 1)"
              >
                <UiIcon name="chevron-down" :size="16" />
              </button>
              <button
                type="button"
                class="ui-repeater__duplicate"
                :aria-label="t('field.repeater.duplicate_label', { n: i + 1 })"
                :disabled="disabled"
                @click="duplicateRowAt(i)"
              >
                <UiIcon name="copy" :size="16" />
              </button>
              <button
                type="button"
                class="ui-repeater__remove"
                :aria-label="t('field.repeater.remove_label', { n: i + 1 })"
                :disabled="disabled"
                @click="removeRowAt(i)"
              >
                <UiIcon name="trash" :size="16" />
              </button>
            </div>
          </div>
        </div>
      </template>

      <div class="ui-repeater__insert-zone">
        <button
          type="button"
          class="ui-repeater__insert"
          :aria-label="t('field.repeater.insert_label', { n: rows.length + 1 })"
          :disabled="disabled"
          @click="insertRowAt(rows.length)"
        >
          <UiIcon name="plus" :size="16" />
        </button>
      </div>
    </div>

    <p v-if="!rows.length" class="ui-repeater__empty">{{ t('field.repeater.empty') }}</p>

    <button ref="addEl" type="button" class="ui-repeater__add" :disabled="disabled" @click="addRow">{{ t('field.repeater.add') }}</button>

    <p v-if="error" :id="errId" class="ui-repeater__error" role="alert">{{ error }}</p>
    <span class="ui-repeater__live" aria-live="polite">{{ liveMessage }}</span>
  </fieldset>
</template>

<style lang="scss">
@use '../../assets/scss/mixins';

.ui-repeater {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  border: 0;

  &__legend {
    padding: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    margin-bottom: var(--space-1);
  }

  &__rows {
    display: flex;
    flex-direction: column;
  }

  &__insert-zone {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 1.5rem;

    &::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      height: 1px;
      background: var(--color-border);
      opacity: 0;
      transition: opacity 0.1s;
    }

    &:hover {
      &::before { opacity: 1; }
      .ui-repeater__insert { opacity: 1; }
    }
    // Instant on keyboard focus so the focus ring is not hidden by the opacity transition.
    &:focus-within {
      &::before { opacity: 1; }
      .ui-repeater__insert { opacity: 1; transition: none; }
    }
  }

  &__insert {
    @include mixins.focus-ring;
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    cursor: pointer;
    color: var(--color-text-muted);
    opacity: 0;
    transition: opacity 0.1s;

    &:hover:not(:disabled) {
      background: var(--color-bg);
      color: var(--color-text);
    }

    &:disabled { cursor: default; }
  }

  @media (hover: none) {
    &__insert-zone::before { opacity: 1; }
    &__insert { opacity: 1; }
  }

  &__row-wrap {
    &--over {
      .ui-repeater__row {
        outline: 2px solid var(--color-primary);
        outline-offset: -2px;
      }
    }
  }

  &__row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--space-2);
    align-items: start;
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);

    // Keyboard focus must reveal the actions instantly: an opacity transition would hide the
    // focus ring for its duration (the buttons sit in an opacity:0 layer). Hover stays animated.
    &:hover .ui-repeater__actions { opacity: 1; }
    &:focus-within .ui-repeater__actions { opacity: 1; transition: none; }
  }

  &__gutter {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding-top: var(--space-1);
    cursor: grab;
    color: var(--color-text-muted);
    user-select: none;

    &:active { cursor: grabbing; }
  }

  &__index {
    font-size: var(--text-sm);
    line-height: 1;
  }

  &__fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  &__actions {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    opacity: 0;
    transition: opacity 0.1s;
  }

  @media (hover: none) {
    &__actions { opacity: 1; }
  }

  &__move,
  &__duplicate,
  &__remove {
    @include mixins.focus-ring;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    transition: background 0.1s, border-color 0.1s, color 0.1s;

    &:hover:not(:disabled) {
      background: var(--color-bg);
      border-color: var(--color-border);
      color: var(--color-text);
    }

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }
  }

  &__remove {
    color: var(--color-danger);

    &:hover:not(:disabled) {
      color: var(--color-danger);
      border-color: var(--color-danger);
    }
  }

  &__empty {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  &__add {
    @include mixins.focus-ring;
    align-self: flex-start;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-3);
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--color-text);

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }
  }

  &__error {
    font-size: var(--text-sm);
    color: var(--color-danger);
  }

  &__live {
    @include mixins.sr-only;
  }

  @media (prefers-reduced-motion: reduce) {
    &__actions,
    &__insert,
    &__insert-zone::before { transition: none; }
  }
}
</style>
