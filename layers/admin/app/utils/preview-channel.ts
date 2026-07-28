import { contentMessage, selectedMessage, type PreviewBlockNode } from '../../../public/app/utils/preview-protocol'

/**
 * Editor→iframe send half of the live-preview channel (the receive half is the public
 * `KestrelPreviewBridge`). Content updates are coalesced to one post per animation frame — a typing
 * burst produces a single message carrying the LATEST tree (read at fire time), so the preview stays
 * keystroke-live (≤ one frame behind) without flooding the channel. Selection changes are tiny and
 * latency-sensitive → posted immediately.
 *
 * `target` is a getter because the iframe's contentWindow appears on load and is replaced on every
 * navigation/reload; posts silently no-op while it is gone. `origin` is passed as postMessage's
 * targetOrigin so a frame that navigated cross-origin can never receive editor content.
 */
export interface PreviewSender {
  sendContent: (blocks: PreviewBlockNode[]) => void
  sendSelected: (selectedId: string | null) => void
  dispose: () => void
}

export function createPreviewSender(
  target: () => Window | null | undefined,
  origin: string,
  // Read at FIRE time (like the blocks), never captured at schedule time: an immediate selection post
  // can overtake a pending content frame, and a stale captured id in that frame would then revert the
  // bridge's newer selection (content messages carry the selection authoritatively).
  getSelected: () => string | null,
): PreviewSender {
  let rafId: number | null = null
  let latest: PreviewBlockNode[] | null = null

  const post = (msg: unknown) => target()?.postMessage(msg, origin)

  const fire = () => {
    rafId = null
    if (!latest) return
    // JSON round-trip: detaches Vue reactive proxies (structured clone chokes on some exotic wrappers)
    // and guarantees the payload is the same JSON-safe shape the DB round-trips. Block trees are small;
    // at one clone per frame this is well under a millisecond.
    post(contentMessage(JSON.parse(JSON.stringify(latest)), getSelected()))
    latest = null
  }

  return {
    sendContent(blocks) {
      latest = blocks
      rafId ??= requestAnimationFrame(fire)
    },
    sendSelected(selectedId) {
      post(selectedMessage(selectedId))
    },
    dispose() {
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = null
      latest = null
    },
  }
}

/** Parent-side trust guard: accept a message only from OUR origin AND our preview iframe's window. */
export function acceptsFrameEvent(event: MessageEvent, frameWindow: Window | null, origin: string): boolean {
  return frameWindow !== null && event.origin === origin && event.source === frameWindow
}
