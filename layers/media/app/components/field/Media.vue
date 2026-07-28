<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { FieldComponentProps } from '../../../../ui/app/utils/field-component'
import type { FieldOf } from '../../../../core/server/utils/defineCollection'
import { reorder } from '../../../../ui/app/utils/reorder'
import { commonFolder } from '../../utils/library'

interface Resolved { id: number; folder?: string; src: string; alt: string | null; mime?: string; thumbhash?: string | null; srcset?: { url: string; width: number }[] }

// Honour the one shared widget contract. Narrow the media options via a computed guard, exactly as
// Relation.vue does for its relation options.
const props = defineProps<FieldComponentProps>()
const model = defineModel<number | number[] | null>()

const { t } = useT()
const options = computed(() => (props.field.type === 'media' ? (props.field as FieldOf<'media'>).options : undefined))
const required = computed(() => !!props.field.required)
const multiple = computed(() => !!options.value?.multiple)
const accept = computed(() => options.value?.accept ?? 'any')
const pickerOpen = ref(false)

const ids = computed<number[]>(() => {
  const v = model.value
  if (multiple.value) return Array.isArray(v) ? v : []
  return typeof v === 'number' ? [v] : []
})

const { ensure, resolve } = useMediaResolver(() => props.locale)
const resolved = computed<Resolved[]>(() => ids.value.flatMap((id) => resolve(id) ?? []))
watch(ids, (v) => ensure(v), { immediate: true })

// Seed the picker's initial folder from the common folder of the current items so it opens where the
// selection lives (root when they diverge / nothing is selected yet).
const initialFolder = computed(() => commonFolder(resolved.value.map((r) => r.folder ?? '')))

function onConfirm(picked: number[]) {
  if (multiple.value) {
    // REPLACE, not merge: the picker returns the full desired set (pre-checked + toggled), so
    // unchecking an item in the picker removes it here. Dedupe defensively.
    model.value = [...new Set(picked)]
  } else {
    model.value = picked[0] ?? null
  }
}
function removeId(id: number) {
  if (multiple.value) model.value = (Array.isArray(model.value) ? model.value : []).filter((x) => x !== id)
  else model.value = null
}

// Drag-to-reorder (multiple mode), mirroring the Combobox chip idiom. `resolved` is a SUBSEQUENCE of the
// model ids (a dangling/deleted id drops out), so a resolved position must be mapped back to the id's
// index in the model before reordering — a resolved index is NOT the model index.
const itemsEl = ref<HTMLElement | null>(null)
const liveMessage = ref('')
// A DISTINCT accessible name per item, so the move/remove buttons don't all read "media" when the images
// carry no alt text: alt → filename → "media #<pos>". Position keeps it unique even for same-named files.
const nameOf = (r: Resolved, i: number) => r.alt?.trim() || filenameOf(r) || t('field.media.itemAt', { pos: i + 1 })
function modelIndexOf(id: number) { return (Array.isArray(model.value) ? model.value : []).indexOf(id) }
function announceMove(name: string, to: number) {
  liveMessage.value = t('field.media.moved', { name, pos: to + 1, total: resolved.value.length })
}
// `resolved` is a SUBSEQUENCE of the model ids (a dangling/deleted id drops out), so commit maps the
// resolved drag indices back to the ids' model indices before reordering — a resolved index ≠ model index.
const { dragIndex, overIndex, onDragStart, onDragEnter, onDragLeave, onDrop, onDragEnd } = useDragReorder({
  disabled: () => props.disabled || !multiple.value,
  commit: (fromResolved, toResolved) => {
    const from = modelIndexOf(resolved.value[fromResolved]!.id)
    const to = modelIndexOf(resolved.value[toResolved]!.id)
    if (from < 0 || to < 0) return
    const name = nameOf(resolved.value[fromResolved]!, fromResolved)
    model.value = reorder(Array.isArray(model.value) ? model.value : [], from, to)
    nextTick(() => announceMove(name, toResolved))
  },
})
function moveItem(i: number, dir: -1 | 1) {
  const j = i + dir
  if (props.disabled || !multiple.value || j < 0 || j >= resolved.value.length) return
  const from = modelIndexOf(resolved.value[i]!.id)
  const to = modelIndexOf(resolved.value[j]!.id)
  if (from < 0 || to < 0) return
  const name = nameOf(resolved.value[i]!, i)
  model.value = reorder(Array.isArray(model.value) ? model.value : [], from, to)
  // Keep keyboard focus on a move control at the item's new position. At a boundary the direction button
  // is disabled, so fall back to the OPPOSITE move button (still enabled for any ≥2-item list) — never to
  // the destructive remove button, which would turn a repeated move into an accidental delete.
  nextTick(() => {
    announceMove(name, j)
    const item = itemsEl.value?.children[j] as HTMLElement | undefined
    const btns = item?.querySelectorAll<HTMLButtonElement>('.field-media__move')
    const dirBtn = dir < 0 ? btns?.[0] : btns?.[1]
    const otherBtn = dir < 0 ? btns?.[1] : btns?.[0]
    const target = dirBtn && !dirBtn.disabled ? dirBtn : otherBtn && !otherBtn.disabled ? otherBtn : item
    target?.focus()
  })
}
function srcsetOf(r: Resolved) { return r.srcset?.map((s) => `${s.url} ${s.width}w`).join(', ') }

// Only image mimes get a thumbnail; everything else (pdf/doc/video/…) shows a file badge + filename so
// it isn't a broken <img>. Filename/extension are derived from the public URL (the resolved shape
// carries no filename); the badge falls back to the mime subtype when the URL has no extension.
function isImage(r: Resolved) { return (r.mime ?? '').startsWith('image/') }
function filenameOf(r: Resolved) {
  const path = r.src.split(/[?#]/)[0]
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
}
function fileExt(r: Resolved) {
  const name = filenameOf(r)
  const dot = name.lastIndexOf('.')
  if (dot > 0) return name.slice(dot + 1).toUpperCase()
  return (r.mime ?? '').split('/')[1]?.toUpperCase() ?? ''
}

defineExpose({ onConfirm, removeId, onDragStart, onDrop, moveItem })
</script>

<template>
  <UiField :id="id" :label="name" :error="error" :required="required">
    <template #default="f">
      <div class="field-media">
        <ul v-if="resolved.length" ref="itemsEl" class="field-media__items" @dragleave="onDragLeave">
          <li
            v-for="(r, i) in resolved"
            :key="r.id"
            class="field-media__item"
            :class="{
              'field-media__item--draggable': multiple && !disabled,
              'field-media__item--over': overIndex === i && dragIndex !== i,
            }"
            :draggable="multiple && !disabled"
            @dragstart="onDragStart(i, $event)"
            @dragenter="onDragEnter(i)"
            @dragover.prevent="onDragEnter(i)"
            @drop.prevent="onDrop(i)"
            @dragend="onDragEnd"
          >
            <MediaThumb v-if="isImage(r)" draggable="false" class="field-media__thumb" :src="r.src" :srcset="srcsetOf(r)" sizes="80px" :alt="r.alt ?? ''" :thumbhash="r.thumbhash" />
            <a v-else draggable="false" class="field-media__file" :href="r.src" target="_blank" rel="noopener noreferrer" :title="filenameOf(r)">
              <span class="field-media__badge" aria-hidden="true">{{ fileExt(r) }}</span>
              <span class="field-media__filename">{{ filenameOf(r) }}</span>
            </a>
            <template v-if="multiple && !disabled">
              <button
                type="button"
                draggable="false"
                class="field-media__move field-media__move--prev"
                :aria-label="t('field.media.move_earlier', { name: nameOf(r, i) })"
                :disabled="i === 0"
                @click="moveItem(i, -1)"
              ><UiIcon name="chevron-left" size="0.875rem" /></button>
              <button
                type="button"
                draggable="false"
                class="field-media__move field-media__move--next"
                :aria-label="t('field.media.move_later', { name: nameOf(r, i) })"
                :disabled="i === resolved.length - 1"
                @click="moveItem(i, 1)"
              ><UiIcon name="chevron-right" size="0.875rem" /></button>
            </template>
            <button v-if="!disabled" type="button" draggable="false" class="field-media__remove" :aria-label="t('field.media.remove', { name: nameOf(r, i) })" @click="removeId(r.id)"><UiIcon name="x" size="1rem" /></button>
          </li>
        </ul>
        <p v-else class="field-media__empty">{{ t('field.media.empty') }}</p>
        <UiButton
          v-if="!disabled"
          :id="f.id"
          type="button"
          variant="secondary"
          :aria-invalid="f['aria-invalid']"
          :aria-describedby="f['aria-describedby']"
          @click="pickerOpen = true"
        >
          {{ multiple ? t('field.media.add') : (resolved.length ? t('field.media.replace') : t('field.media.select')) }}
        </UiButton>
        <span class="field-media__live" aria-live="polite">{{ liveMessage }}</span>
      </div>
      <MediaPicker v-model:open="pickerOpen" :multiple="multiple" :accept="accept" :initial-folder="initialFolder" :initial-selected="ids" @confirm="onConfirm" />
    </template>
  </UiField>
</template>

<style lang="scss" scoped>
.field-media { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start; }
.field-media__items { display: flex; flex-wrap: wrap; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
.field-media__item { position: relative; }
.field-media__item--draggable { cursor: grab; }
.field-media__item--draggable:active { cursor: grabbing; }
/* Drop indicator — outward outline (items are gap-spaced, never overflow-clipped). */
.field-media__item--over { outline: 2px solid var(--color-primary); outline-offset: 2px; border-radius: var(--radius-md); }
.field-media__thumb { width: 80px; height: 80px; object-fit: cover; border-radius: var(--radius-md); background: var(--color-bg); border: 1px solid var(--color-border); }
.field-media__file { display: flex; flex-direction: column; gap: var(--space-1); width: 80px; text-decoration: none; color: inherit; }
.field-media__badge { display: grid; place-items: center; width: 80px; height: 80px; border-radius: var(--radius-md); background: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text-muted); font-weight: var(--weight-bold); font-size: var(--text-sm); }
.field-media__filename { max-width: 80px; font-size: var(--text-xs); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Remove control — a dark translucent disc + white glyph reads on ANY image (a white surface disc was
   invisible over pale photos); the light ring lifts it off, hover escalates to solid danger. */
.field-media__remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 1.75rem;
  height: 1.75rem;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-full);
  background: rgba(9, 9, 11, 0.55);
  color: #fff;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55), var(--shadow-sm);
  cursor: pointer;
  line-height: 1;
  transition: background var(--motion-fast) var(--ease-standard),
    transform var(--motion-fast) var(--ease-standard),
    box-shadow var(--motion-fast) var(--ease-standard);
}
.field-media__remove:hover {
  background: var(--color-danger-solid);
  color: var(--color-on-danger);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.7), var(--shadow-md);
  transform: scale(1.08);
}
.field-media__remove:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

/* Keyboard reorder buttons — same disc idiom, revealed on hover/focus so idle thumbs stay clean.
   Kept focusable when idle (opacity, not display:none) so Tab reveals them via :focus-within. */
.field-media__move {
  position: absolute;
  bottom: 4px;
  width: 1.5rem;
  height: 1.5rem;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-full);
  background: rgba(9, 9, 11, 0.55);
  color: #fff;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55);
  cursor: pointer;
  line-height: 1;
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-standard);
}
.field-media__move--prev { left: 4px; }
.field-media__move--next { right: 4px; }
.field-media__move:disabled { cursor: default; } /* stays hidden at a boundary (reveal excludes :disabled) */
.field-media__item:hover .field-media__move:not(:disabled),
.field-media__item:focus-within .field-media__move:not(:disabled) { opacity: 1; }
.field-media__move:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
@media (hover: none) {
  .field-media__move:not(:disabled) { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .field-media__remove,
  .field-media__move { transition: none; }
  .field-media__remove:hover { transform: none; }
}

.field-media__empty { color: var(--color-text-muted); font-size: var(--text-sm); margin: 0; }
.field-media__live { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
