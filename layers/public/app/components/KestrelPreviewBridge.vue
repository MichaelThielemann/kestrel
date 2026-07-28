<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, shallowRef } from 'vue'
import { blockEditKey } from '../utils/block-edit-context'
import {
  parseEditorMessage, readyMessage, selectMessage,
  type PreviewBlockNode,
} from '../utils/preview-protocol'

/**
 * The iframe half of the editor live preview. Wraps the page's BlockRenderer via a scoped slot: it
 * exposes the LIVE block tree (the editor's in-memory content, received over postMessage) — falling
 * back to the server-rendered `blocks` prop until the first message — and provides the block-edit
 * context so the renderer emits clickable, highlightable markers. Mounted only in preview mode
 * (`?kestrel-preview=1` + admin, or the dedicated fallback page), and lazy-loaded there, so none of
 * this ships in the normal public bundle.
 *
 * SECURITY: messages are trusted only when `event.origin` is OUR origin AND `event.source` is the
 * embedding parent window — a third-party page that frames the site (or is framed by it) can never
 * inject preview content. Outbound posts target our own origin only.
 */
const props = defineProps<{ blocks?: unknown[] }>()

// Live tree: null until the editor's first content message, then always the message payload.
// shallowRef — each message replaces the whole tree; BlockRenderer keys by block id.
const live = shallowRef<PreviewBlockNode[] | null>(null)
const blocks = computed<unknown[]>(() => live.value ?? (Array.isArray(props.blocks) ? props.blocks : []))

// Selection: local state, synced both ways (click here → editor tree; tree click → highlight here).
const selectedId = ref<string | null>(null)
provide(blockEditKey, {
  selectedId,
  select: (id: string) => {
    selectedId.value = id // highlight immediately; the editor echoes the selection back
    post(selectMessage(id))
  },
})

function post(msg: unknown) {
  // Posting to self when opened directly (parent === window) is harmless — our own listener ignores
  // frame→editor types — and keeping it unconditional keeps the handshake testable.
  window.parent.postMessage(msg, window.location.origin)
}

function onMessage(e: MessageEvent) {
  if (e.origin !== window.location.origin || e.source !== window.parent) return
  const m = parseEditorMessage(e.data)
  if (!m) return
  if (m.kestrel === 'preview:content') {
    const prev = selectedId.value
    live.value = m.blocks
    selectedId.value = m.selectedId
    // A selection made while the frame was still loading arrives with the first content push (not as a
    // separate selected message) — scroll to it like a live selection would.
    if (m.selectedId && m.selectedId !== prev) void scrollToSelected(m.selectedId)
  } else {
    selectedId.value = m.selectedId
    void scrollToSelected(m.selectedId)
  }
}

// Bring an externally-selected block into view (tree-pane click in the editor).
async function scrollToSelected(id: string | null) {
  if (!id) return
  await nextTick()
  const el = Array.from(document.querySelectorAll('[data-block-id]')).find((n) => n.getAttribute('data-block-id') === id)
  // The marker is `display: contents` (no box of its own), so scroll its rendered child instead.
  ;(el?.firstElementChild ?? el)?.scrollIntoView({ block: 'nearest' })
}

// The preview is a canvas, not a browsing context: swallow every link navigation (consumer layout nav,
// CTA anchors) AND form submission in the CAPTURE phase, so neither native navigation nor Vue Router
// (which respects defaultPrevented) can steer the iframe away from the previewed page. Block clicks
// still select — preventDefault does not stop propagation, so the marker handlers keep working.
// (Programmatic navigation from consumer script can't be intercepted here; the editor host snaps the
// frame back on load when its location no longer matches the preview URL.)
function onClickCapture(e: MouseEvent) {
  const a = (e.target as Element | null)?.closest?.('a[href]')
  if (a) e.preventDefault()
}
function onSubmitCapture(e: Event) {
  e.preventDefault()
}

onMounted(() => {
  window.addEventListener('message', onMessage)
  document.addEventListener('click', onClickCapture, true)
  document.addEventListener('submit', onSubmitCapture, true)
  // Handshake: tell the editor this document (fresh mount OR reload) is ready for the current state.
  post(readyMessage())
})
onUnmounted(() => {
  window.removeEventListener('message', onMessage)
  document.removeEventListener('click', onClickCapture, true)
  document.removeEventListener('submit', onSubmitCapture, true)
})
</script>

<template>
  <slot :blocks="blocks" />
</template>

<style lang="scss">
// Selection chrome for the marker wrappers BlockRenderer emits when the edit context is present.
// This document is the CONSUMER's public page (no admin design tokens), so the colors are concrete
// values with overridable custom properties — a consumer can theme them from their own CSS.
//
// The marker itself is `display: contents`: it generates NO box, so the block root stays the parent's
// real flex/grid ITEM exactly as on the published site — this restores flex/grid-item props, `gap`, and
// breakpoints keyed to the block root, which a wrapper box would break by displacing the root. (It does
// NOT change `>` combinators: the marker element is still in the DOM tree, so `parent > block-root`
// rules match the same as before — unchanged either way.) The highlight chrome therefore lives on the
// block root via `> *`. Events are unaffected — the marker div is still in the DOM/event path.
.block-edit-marker {
  display: contents;

  > * {
    cursor: pointer;
    outline: 2px solid transparent;
    outline-offset: -2px;
    transition: outline-color 120ms ease;
  }
  &:hover > * {
    outline-color: var(--kestrel-preview-hover, rgba(100, 116, 139, 0.55));
  }
  &--selected > * {
    // Selection ring drawn with `outline` (not box-shadow) so a consumer block that carries its own root
    // box-shadow keeps it while selected — a box-shadow ring here would replace it. Slightly thicker than
    // the hover ring for contrast on dark/indigo consumer sites.
    outline-color: var(--kestrel-preview-accent, #4f46e5);
    outline-width: 3px;
  }
}
</style>
