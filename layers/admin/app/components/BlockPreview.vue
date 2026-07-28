<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import type { SerializedBlock } from '../../../core/server/utils/serialize-collection'
import { previewSrc, parseFrameMessage, type PreviewBlockNode } from '../../../public/app/utils/preview-protocol'
import { createPreviewSender, acceptsFrameEvent, type PreviewSender } from '../utils/preview-channel'
import { editorFormContextKey } from '../utils/editor-form-context'
import { PRESETS, matchPreset, fitScale, resolveDim, clampDim, DIM_MIN, WIDTH_MAX, HEIGHT_MAX, type ViewportPreset } from '../utils/preview-viewport'

/**
 * The editor half of the live preview: an iframe onto the REAL public page (the record's URL for a
 * saved pageLike record — real CSS, fonts, breakpoints, drafts included via the same-origin admin
 * session — else the dedicated fallback page), kept keystroke-live over the postMessage bridge. The
 * populated tree is pushed to the iframe rAF-coalesced (≤ one frame behind typing, no debounce). Selection syncs both
 * ways: tree click → highlight/scroll in the frame; block click in the frame → `select` up to the tree.
 */
const props = defineProps<{ content: unknown[]; locale?: string; selectedId?: string | null }>()
const emit = defineEmits<{ select: [id: string] }>()
const { t } = useT()

// The record's public URL comes from the editor shell (null → fallback page). Injected optionally so
// the component still mounts standalone (tests, storybook-ish usage) — it then always uses the fallback.
const ctx = inject(editorFormContextKey, null)
const src = computed(() => previewSrc(ctx?.previewUrl.value ?? null, props.locale ?? ''))

// ---- populate (pipeline: resolve media ids + internal links into reactive caches) ----
// Block field schemas (non-blocking: byType fills once loaded, then the next send carries the media).
const { blocks: blockDefs, load } = useBlocks()
load()
const byType = computed<Record<string, SerializedBlock>>(() =>
  Object.fromEntries((blockDefs.value ?? []).map((b) => [b.name, b])),
)
const items = computed(() => (Array.isArray(props.content) ? props.content : []))
// `locale` is a getter so a locale change re-resolves media (its cache is per-locale).
const { ensure: ensureMedia, resolve: resolveMedia } = useMediaResolver(() => props.locale ?? 'en')
const { ensure: ensureLinks, resolve: resolveLink } = useLinkResolver()
// The current resolve round. The ready-handshake push awaits it: the frame's first paint is the
// SERVER-populated page, so pushing a not-yet-resolved client tree would momentarily strip its images/
// hrefs. With warm (or empty) caches the promise settles immediately — no perceptible delay.
let ensureRound: Promise<unknown> = Promise.resolve()
watch(
  [items, byType, () => props.locale],
  ([list, types]) => {
    ensureRound = Promise.allSettled([
      ensureMedia(collectMediaIds(list, types)),
      ensureLinks(collectLinkRefs(list, types)),
    ])
  },
  { immediate: true, deep: true },
)
const populated = computed(() =>
  populateBlocksLinks(populateBlocksMedia(items.value, byType.value, resolveMedia), byType.value, resolveLink),
)

// ---- channel (parent side) ----
const frame = ref<HTMLIFrameElement | null>(null)
// True once the CURRENT frame document said hello; sends before that are pointless (lost on load).
const ready = ref(false)
let sender: PreviewSender | null = null

function pushContent() {
  sender?.sendContent(populated.value as PreviewBlockNode[])
}

function onMessage(e: MessageEvent) {
  if (!acceptsFrameEvent(e, frame.value?.contentWindow ?? null, window.location.origin)) return
  const m = parseFrameMessage(e.data)
  if (!m) return
  if (m.kestrel === 'preview:ready') {
    // Fresh document (first load OR reload/src change) — send it the full current state, once the
    // in-flight media/link resolve settles (see ensureRound); `ready` may flip meanwhile (reload).
    ready.value = true
    void ensureRound.then(() => { if (ready.value) pushContent() })
  } else {
    emit('select', m.id)
  }
}

// Every load starts a document that must handshake before it may receive pushes. If consumer script
// navigated the canvas away (programmatic router push — clicks/submits are already intercepted in the
// bridge), the loaded document is not the preview page: snap the frame back to the preview URL.
function onFrameLoad() {
  ready.value = false
  const el = frame.value
  if (!el) return
  try {
    const loc = el.contentWindow?.location
    if (loc && loc.pathname + loc.search !== src.value) el.src = src.value
  } catch {
    el.src = src.value // cross-origin navigation — location unreadable, snap back
  }
}

// Manual fallback for any residual stale component state: reload the iframe. This remounts EVERY
// component in the frame (not just, say, a stale srcset) and re-handshakes — the fresh document posts
// `preview:ready`, and onMessage re-pushes the full populated tree after ensureRound. `ready=false`
// guards pushes to the doc that's tearing down.
function refresh() {
  ready.value = false
  const el = frame.value
  if (!el) return
  try {
    el.contentWindow?.location.reload() // same URL → onFrameLoad's snap-back check passes
  } catch {
    el.src = src.value // cross-origin: location unreadable → renavigate
  }
}

onMounted(() => {
  sender = createPreviewSender(() => frame.value?.contentWindow ?? null, window.location.origin, () => props.selectedId ?? null)
  window.addEventListener('message', onMessage)
})
onUnmounted(() => {
  sender?.dispose()
  sender = null
  window.removeEventListener('message', onMessage)
})

// Keystroke-live: every populated-tree change (edit, media/link cache fill) schedules a send; the
// channel coalesces bursts to one message per animation frame. Selection posts immediately (tiny).
watch(populated, () => { if (ready.value) pushContent() })
watch(() => props.selectedId, (id) => { if (ready.value) sender?.sendSelected(id ?? null) })
// A src change reloads the iframe (locale switch, first save assigning a URL) → wait for its new ready.
watch(src, () => { ready.value = false })

// ---- responsive preview: device presets (quick-fill) + automatic scale-to-fit + custom W×H ----
// The iframe renders at the target resolution's REAL px (so the page fires its true breakpoints); a
// uniform transform only shrinks it visually to fit the pane. Desktop keeps the config-driven breakpoint
// width but an 'auto' height that fills the pane vertically (the iframe's own document scrolls).
const previewDesktopWidth = Number((useRuntimeConfig().public as { previewDesktopWidth?: number }).previewDesktopWidth) || 1440
const presets = PRESETS(previewDesktopWidth)
const { width, height } = usePreviewViewport(previewDesktopWidth)
const activePreset = computed(() => matchPreset(width.value, height.value, presets))

function selectPreset(p: ViewportPreset) {
  width.value = p.w
  height.value = p.h
}
// Commit a W×H input on change (blur/Enter — `change` falls through to the primitive's root <input>), not
// per keystroke, so the frame doesn't thrash mid-typing. Empty → keep the current value; else full clamp.
function onDimCommit(target: 'w' | 'h', e: Event) {
  const el = e.target as HTMLInputElement
  if (el.value === '') {
    // A number input also reports '' while it holds un-parsable editing text ('-', '1e'); that must keep
    // the current value, not silently switch the axis. A genuinely EMPTIED field means "auto": the axis
    // fills the pane. (Clearing height under the fixed desktop width re-selects the Desktop preset.)
    if (el.validity?.badInput) return
    if (target === 'w') width.value = 'auto'
    else height.value = 'auto'
    return
  }
  const v = clampDim(Number(el.value), DIM_MIN, target === 'w' ? WIDTH_MAX : HEIGHT_MAX)
  if (v === null) return
  if (target === 'w') width.value = v
  else height.value = v
}

// Both stage axes drive the fit scale — measured with a ResizeObserver (VueUse isn't wired; a manual
// observer is the in-repo idiom, cf. useTheme's matchMedia). `scale` stays 1 until the first measure.
const stage = ref<HTMLElement | null>(null)
const availW = ref(0)
const availH = ref(0)
let ro: ResizeObserver | null = null
const scale = computed(() => fitScale(availW.value, availH.value, width.value, height.value))
const scalePct = computed(() => Math.round(scale.value * 100))
// Resolve each Dim to real px: fixed passes through, an 'auto' axis fills the pane at the current scale
// (falls back to the config width / 900 before measurement so SSR/tests still have a sized frame).
const frameW = computed(() => resolveDim(availW.value, width.value, scale.value, previewDesktopWidth))
const frameH = computed(() => resolveDim(availH.value, height.value, scale.value, 900))

// The iframe keeps its real target px and is scaled from its top-left; the holder occupies the SCALED
// footprint so centering behaves. The stage clips (overflow:hidden) so only the iframe document scrolls.
const frameStyle = computed(() => ({
  width: `${frameW.value}px`,
  height: `${frameH.value}px`,
  transform: `scale(${scale.value})`,
  transformOrigin: 'top left',
}))
const viewportStyle = computed(() => ({
  width: `${frameW.value * scale.value}px`,
  height: `${frameH.value * scale.value}px`,
}))

// Content box (padding excluded) so the initial seed matches the ResizeObserver's `contentRect` — both
// must agree, else the frame footprint would briefly exceed the padded stage (clipped, not scrolled).
function contentBox(el: HTMLElement) {
  const cs = getComputedStyle(el)
  return {
    width: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    height: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
  }
}
onMounted(() => {
  const el = stage.value
  if (!el || typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver((entries) => {
    const b = entries[0]?.contentRect ?? contentBox(el)
    availW.value = b.width
    availH.value = b.height
  })
  ro.observe(el)
  const b = contentBox(el)
  availW.value = b.width
  availH.value = b.height
})
onUnmounted(() => { ro?.disconnect(); ro = null })
</script>

<template>
  <section class="block-preview" :aria-label="t('preview.ariaLabel')">
    <div class="block-preview__bar">
      <p class="block-preview__label">{{ t('preview.label') }}</p>

      <div class="block-preview__tools">
        <div class="block-preview__group">
          <UiTooltip>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              icon="rotate-cw"
              :aria-label="t('preview.refresh')"
              @click="refresh"
            />
            <template #content>{{ t('preview.refresh') }}</template>
          </UiTooltip>
        </div>

        <span class="block-preview__sep" aria-hidden="true" />

        <div class="block-preview__group" role="group" :aria-label="t('preview.deviceLabel')">
          <UiTooltip v-for="p in presets" :key="p.key">
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              :icon="p.icon"
              :aria-label="t(p.label)"
              :aria-pressed="activePreset === p.key"
              :class="{ 'block-preview__seg--active': activePreset === p.key }"
              @click="selectPreset(p)"
            />
            <template #content>{{ t(p.label) }} · {{ p.w }} × {{ p.h === 'auto' ? t('preview.auto') : p.h }}</template>
          </UiTooltip>
        </div>

        <span class="block-preview__sep" aria-hidden="true" />

        <!-- Read-only: scale is always automatic (two-axis fit), so the % is an indicator, not a control. -->
        <span class="block-preview__pct" aria-hidden="true">{{ scalePct }}%</span>

        <span class="block-preview__sep" aria-hidden="true" />

        <div class="block-preview__dims">
          <!-- Either axis can be 'Auto' (fills the pane): typing a number fixes it, clearing the field
               returns it to Auto. Height is Auto under the Desktop preset. -->
          <UiNumberInput
            slim
            class="block-preview__dim"
            :model-value="width === 'auto' ? null : width"
            :min="DIM_MIN"
            :max="WIDTH_MAX"
            :placeholder="width === 'auto' ? t('preview.auto') : undefined"
            :aria-label="t('preview.width')"
            @change="onDimCommit('w', $event)"
          />
          <span class="block-preview__x" aria-hidden="true">×</span>
          <UiNumberInput
            slim
            class="block-preview__dim"
            :model-value="height === 'auto' ? null : height"
            :min="DIM_MIN"
            :max="HEIGHT_MAX"
            :placeholder="height === 'auto' ? t('preview.auto') : undefined"
            :aria-label="t('preview.height')"
            @change="onDimCommit('h', $event)"
          />
          <span class="block-preview__unit" aria-hidden="true">px</span>
        </div>
      </div>
    </div>

    <div ref="stage" class="block-preview__stage">
      <div class="block-preview__viewport" :style="viewportStyle">
        <iframe ref="frame" class="block-preview__frame" :src="src" :style="frameStyle" :title="t('preview.label')" @load="onFrameLoad" />
      </div>
    </div>
  </section>
</template>

<style lang="scss">
// The iframe owns rendering + scrolling; this host only frames it and hosts the device toggle.
.block-preview {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  &__bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex: 0 0 auto;
  }
  // Pane heading, folded onto the toolbar row so the preview header is a single thin line (the outer
  // editor pane's own "Preview" label is hidden below to avoid a duplicate).
  &__label {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-muted);
    flex: 0 0 auto;
  }
  // Controls cluster to the right of the heading, wrapping among themselves; the whole cluster only
  // wraps below the heading when the middle pane is too narrow to fit both.
  &__tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    flex: 1 1 auto;
    min-width: 0;
  }
  &__group {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  // Active segment: neutral fill + indigo glyph (matches the button-group active idiom).
  &__seg--active {
    color: var(--color-primary);
    background: var(--color-surface-2);
  }
  &__sep {
    align-self: stretch;
    width: 1px;
    min-height: 1.25rem;
    background: var(--color-border);
  }
  &__pct {
    min-width: 3.5ch;
    text-align: right;
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }
  &__dims {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }
  // Compact numeric inputs (the primitive is width:100% by default — override under our wrapper so the
  // selector wins by specificity without touching the shared component). 6rem fits up to 5 typed digits
  // without clipping; flex:none stops the narrow middle pane from shrinking them back below that width.
  &__dims .ui-number {
    width: 6rem;
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  &__stage {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    // The container NEVER scrolls: the frame is always scaled to fit both axes, and any over-height
    // content scrolls inside the iframe's own document. Center the (possibly letterboxed) device frame.
    overflow: hidden;
    // No padding: the pane already has its own, and an inset here would misalign the frame's top corners
    // with the rest of the editor's content edge.

    // Stacked single-column editor (matches the editor3 breakpoint in BlocksBody): the panes become
    // content-sized there, so give the stage a concrete height to measure + scale the frame within.
    @media (max-width: 1100px) {
      height: 70vh;
    }
  }
  // Occupies the SCALED footprint of the frame so centering + overflow behave; owns the crisp 1px border
  // (box-shadow, unscaled). Deliberately square: the preview must read as the RAW page, not a device mock,
  // so no corner radius rounds off the rendered edges. `overflow: hidden` still guards subpixel spill.
  &__viewport {
    flex: 0 0 auto;
    box-shadow: 0 0 0 1px var(--color-border);
    background: #fff;
    overflow: hidden;
    transition: width 160ms ease, height 160ms ease;
  }
  &__frame {
    display: block;
    border: 0;
    background: #fff;
    transition: transform 160ms ease;
  }
}
</style>
