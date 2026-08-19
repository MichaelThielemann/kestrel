<script setup lang="ts">
// Proofing augmentation of the BASE secure-gallery editor (`<FieldSecureGallery>`). Registered OVER the base
// widget (the proofing extension's plugin uses `enforce: 'post'` so `registerFieldComponent('secureGallery',
// …)` wins regardless of cross-layer plugin order). It renders the base unchanged — all field props + v-model
// fall through — and only fills the base's generic seams with READ-ONLY views of the CUSTOMERS' marks:
//   • `#toolbar`       — a colour filter (chips)
//   • `#file-overlay`  — per-photo colour dots + a comment-count bubble, inset on the grid thumbnail
//   • `#file-badge`    — the same colour dots + count in the list/table view
//   • `#viewer-extra`  — the customers' comments for a photo, shown in the lightbox meta on double-click
// The base stays proofing-agnostic; this layer is the ONLY place proofing data enters the editor.
//
// The photographer already unlocks the gallery here (key in memory) → the base exposes `{ key, open }`, which
// this wrapper uses to load + decrypt the customers' submissions via `useProofingReview` once unlocked.
// `inject`/`recordEditContextKey`/`useProofingReview` are auto-imported; `<FieldSecureGallery>` is the base.
import { ref, computed, watch } from 'vue'
import { PROOFING_COLORS } from '../../utils/proofing'

// The field-widget contract (forwarded to the base) + the base's value ref. `GalleryRef` mirrors the base's
// `SecureGalleryRef` structurally (no cross-package type import); the wrapper only passes it through.
interface GalleryRef { v: 2; galleryId: string; saltB64: string; verify: { iv: string; data: string } }
const props = defineProps<{ field?: unknown; name: string; locale?: string; error?: string | null; disabled?: boolean; id?: string }>()
const model = defineModel<GalleryRef | null>()

// `defineExpose` is read through `proxyRefs`, so the base's `key` ref arrives ALREADY UNWRAPPED here
// (CryptoKey | null) — do NOT read `.key.value`. `open` is a plain function; it takes the optional GCM
// `aad` (additionalData) the review forwards — the base binds (gallerySlug, customerId) on seal, so open
// must pass it back or the auth check fails and every customer submission is silently dropped.
interface Exposed { key: unknown; open: (s: { iv: string; data: string }, aad?: Uint8Array) => Promise<Uint8Array> }
const base = ref<Exposed | null>(null)

// Hex per colour for the INSET dots/bubble. The overlay is rendered through TWO forwarded slots (wrapper →
// base → MediaGrid), so the load-bearing visuals are styled INLINE — guaranteed to apply regardless of how
// Vue resolves the scope id of deeply-forwarded slot content. (The toolbar chips below are one level → scoped.)
const COLOR_HEX: Record<string, string> = { red: '#ef4444', yellow: '#eab308', green: '#22c55e', blue: '#3b82f6', purple: '#a855f7' }
const dotStyle = (c: string) => ({
  width: '11px', height: '11px', borderRadius: '50%', boxSizing: 'content-box' as const,
  background: COLOR_HEX[c] ?? '#999', border: '2px solid #fff', boxShadow: '0 1px 2px rgba(0,0,0,.45)',
})
const bubbleStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '2px', height: '17px', padding: '0 5px',
  borderRadius: '999px', background: 'rgba(17,24,39,.85)', color: '#fff', fontSize: '10px',
  fontWeight: '700', lineHeight: '1', boxShadow: '0 1px 2px rgba(0,0,0,.45)',
}

// The slot's `file` is typed as the media `LibraryFile` (an interface, with no `blobId`), but the base
// adapter populates a `blobId` at runtime. Params are `unknown` (everything is assignable) + read defensively.
const blobIdOf = (file: unknown): string | undefined => {
  const id = (file as { blobId?: unknown } | null)?.blobId
  return typeof id === 'string' ? id : undefined
}

// The gallery slug (= the proofing submission key) comes from a sibling field's value. Which field is
// configurable via the secureGallery field's `options.keyField` (default 'slug'); the customer view must
// submit this same value.
const ctx = inject(recordEditContextKey, null)
const keyField = computed(() => {
  const opt = (props.field as { options?: { keyField?: unknown } } | undefined)?.options?.keyField
  return typeof opt === 'string' && opt ? opt : 'slug'
})
const gallerySlug = computed(() => String((ctx?.values as Record<string, unknown> | undefined)?.[keyField.value] ?? ''))

const { marksByImage, load } = useProofingReview({
  // getter so `load()` always reads the current slug (it may fill in after first render)
  get gallerySlug() { return gallerySlug.value },
  // Forward the AAD too — the review binds (gallerySlug, customerId) as additionalData, and the base's open
  // must receive it or the GCM auth check fails and every customer submission is silently dropped.
  open: (s, aad) => base.value!.open(s, aad),
})
// Load + decrypt the customer marks once BOTH the gallery is unlocked (key available) and the slug is known —
// whichever arrives last triggers it. `base.value?.key` tracks the base's exposed (unwrapped) key ref.
let warnedNoSlug = false
watch([() => base.value?.key, gallerySlug], ([k, slug]) => {
  if (k && slug) void load()
  // Unlocked but the host record has no non-empty `slug` → the review key is empty and marks can never load.
  // Surface it in dev instead of failing silently (the #1 proofing footgun: a host collection without a slug,
  // or a customer view submitting `$route.path` instead of the record slug).
  else if (k && !slug && import.meta.dev && !warnedNoSlug) {
    warnedNoSlug = true
    console.warn(`[galleries-secure-proofing] Gallery unlocked but its record has no non-empty \`${keyField.value}\` field — customer proofing marks are keyed by it and cannot be loaded. Give the host collection that field (or set the secureGallery field's options.keyField), and ensure the public <SecureGalleryProofingView> submits the SAME value (not \`$route.path\`).`)
  }
})

const colorFilter = ref<string | null>(null)
const marksFor = (file: unknown) => { const id = blobIdOf(file); return id ? (marksByImage.value[id] ?? []) : [] }
function colorsFor(file: unknown): string[] {
  const seen = new Set<string>()
  for (const m of marksFor(file)) if (m.color) seen.add(m.color)
  // stable, palette order
  return PROOFING_COLORS.filter((c) => seen.has(c))
}
const commentsFor = (file: unknown) => marksFor(file).filter((m) => m.comment)
const commentCount = (file: unknown) => commentsFor(file).length
// Folders pass through; files are kept only if a customer flagged them with the active colour.
function filterFn(item: unknown): boolean {
  const it = item as { type?: string; file?: unknown }
  if (it.type !== 'file' || !colorFilter.value) return true
  const id = blobIdOf(it.file)
  return !!id && (marksByImage.value[id]?.some((m) => m.color === colorFilter.value) ?? false)
}
</script>

<template>
  <FieldSecureGallery ref="base" v-bind="props" v-model="model" :filter="filterFn">
    <!-- Colour filter (right of the breadcrumb) -->
    <template #toolbar>
      <div class="sgpe-filter" role="group" aria-label="Filter by customer mark">
        <button type="button" class="sgpe-chip" :class="{ 'is-active': !colorFilter }" @click="colorFilter = null">All</button>
        <button v-for="c in PROOFING_COLORS" :key="c" type="button" class="sgpe-chip sgpe-chip--dot"
          :class="[`sgpe--${c}`, { 'is-active': colorFilter === c }]" :title="`Show ${c}`" :aria-pressed="colorFilter === c"
          @click="colorFilter = colorFilter === c ? null : c" />
        <!-- Marks are loaded once on unlock; let the photographer pull newly-submitted marks without reloading. -->
        <button type="button" class="sgpe-chip" title="Reload customer marks" @click="load()">Refresh</button>
      </div>
    </template>

    <!-- Inset customer marks on each photo: colour dots + a comment-count bubble (grid) -->
    <template #file-overlay="{ file }">
      <span v-for="c in colorsFor(file)" :key="c" :style="dotStyle(c)" :title="`Marked ${c}`" />
      <span v-if="commentCount(file)" :style="bubbleStyle" :title="`${commentCount(file)} comment(s)`">
        <KestrelUiIcon name="message-square" :size="11" /> {{ commentCount(file) }}
      </span>
    </template>

    <!-- Same marks inline in the list view -->
    <template #file-badge="{ file }">
      <template v-if="colorsFor(file).length || commentCount(file)">
        <span v-for="c in colorsFor(file)" :key="c" :style="{ ...dotStyle(c), display: 'inline-block', verticalAlign: 'middle', marginInlineEnd: '3px' }" :title="`Marked ${c}`" />
        <span v-if="commentCount(file)" :style="{ ...bubbleStyle, marginInlineEnd: '6px', verticalAlign: 'middle' }">
          <KestrelUiIcon name="message-square" :size="11" /> {{ commentCount(file) }}
        </span>
      </template>
    </template>

    <!-- Customer marks + comments in the lightbox (double-click a photo → meta panel) -->
    <template #viewer-extra="{ file }">
      <section v-if="marksFor(file).length" class="sgpe-marks">
        <h4 class="sgpe-marks__title">Customer marks</h4>
        <ul class="sgpe-marks__list">
          <li v-for="(m, i) in marksFor(file)" :key="i" class="sgpe-marks__item">
            <span v-if="m.color" :style="{ ...dotStyle(m.color), flex: '0 0 auto', marginTop: '2px' }" :title="`Marked ${m.color}`" />
            <span v-else class="sgpe-marks__nocolor" aria-hidden="true">—</span>
            <span class="sgpe-marks__text">{{ m.comment || 'No comment.' }}</span>
          </li>
        </ul>
      </section>
    </template>
  </FieldSecureGallery>
</template>

<style lang="scss" scoped>
.sgpe-filter { display: inline-flex; gap: var(--space-1); align-items: center; }
.sgpe-chip {
  font: inherit; font-size: var(--text-xs); padding: 2px var(--space-2); cursor: pointer;
  border: 1px solid var(--color-border); border-radius: var(--radius-full, 999px);
  background: var(--color-surface); color: var(--color-text-muted);
}
.sgpe-chip.is-active { border-color: var(--color-primary); color: var(--color-text); }
.sgpe-chip--dot { width: 1.1rem; height: 1.1rem; padding: 0; }
.sgpe--red { background: #ef4444; }
.sgpe--yellow { background: #eab308; }
.sgpe--green { background: #22c55e; }
.sgpe--blue { background: #3b82f6; }
.sgpe--purple { background: #a855f7; }
.sgpe-marks { display: flex; flex-direction: column; gap: var(--space-2); }
.sgpe-marks__title { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); }
.sgpe-marks__list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--space-2); }
.sgpe-marks__item { display: flex; align-items: flex-start; gap: var(--space-2); font-size: var(--text-sm); }
.sgpe-marks__nocolor { flex: 0 0 auto; color: var(--color-text-subtle); }
.sgpe-marks__text { min-width: 0; overflow-wrap: anywhere; }
</style>
