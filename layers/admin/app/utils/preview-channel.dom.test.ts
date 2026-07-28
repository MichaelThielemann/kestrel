import { describe, it, expect } from 'vitest'
import { createPreviewSender, acceptsFrameEvent } from './preview-channel'
import { contentMessage } from '../../../public/app/utils/preview-protocol'

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

function makeTarget() {
  const posted: { msg: unknown; origin: string }[] = []
  const win = { postMessage: (msg: unknown, origin: string) => posted.push({ msg, origin }) }
  return { posted, win: win as unknown as Window }
}

describe('createPreviewSender — rAF-coalesced content, immediate selection', () => {
  it('coalesces a burst of content updates into ONE post carrying the latest tree', async () => {
    const { posted, win } = makeTarget()
    const sender = createPreviewSender(() => win, 'http://localhost', () => 'a')
    sender.sendContent([{ id: 'a', type: 'hero', props: { heading: '1' } }])
    sender.sendContent([{ id: 'a', type: 'hero', props: { heading: '12' } }])
    sender.sendContent([{ id: 'a', type: 'hero', props: { heading: '123' } }])
    expect(posted).toHaveLength(0) // nothing until the frame tick
    await nextFrame()
    expect(posted).toHaveLength(1)
    expect(posted[0]!.origin).toBe('http://localhost')
    expect(posted[0]!.msg).toEqual(contentMessage([{ id: 'a', type: 'hero', props: { heading: '123' } }], 'a'))
  })

  it('reads the selection at FIRE time — a selection change during the pending frame is never reverted', async () => {
    const { posted, win } = makeTarget()
    let selected: string | null = 'a'
    const sender = createPreviewSender(() => win, 'http://localhost', () => selected)
    sender.sendContent([{ id: 'a', type: 'hero', props: {} }]) // scheduled while 'a' is selected
    selected = 'b' // the user clicks block b before the frame fires
    sender.sendSelected('b') // the immediate post overtakes the queued content
    await nextFrame()
    expect(posted).toHaveLength(2)
    expect(posted[0]!.msg).toEqual({ kestrel: 'preview:selected', selectedId: 'b' })
    // the late content frame must carry the NEW selection, not the stale captured one
    expect((posted[1]!.msg as { selectedId: string }).selectedId).toBe('b')
  })

  it('deep-clones the tree so reactive proxies / later mutations never leak into the message', async () => {
    const { posted, win } = makeTarget()
    const sender = createPreviewSender(() => win, 'http://localhost', () => null)
    const tree = [{ id: 'a', type: 'hero', props: { heading: 'before' } }]
    sender.sendContent(tree)
    tree[0]!.props.heading = 'after' // mutate the source before the frame fires
    await nextFrame()
    const sent = posted[0]!.msg as { blocks: { props: { heading: string } }[] }
    expect(sent.blocks[0]!.props.heading).toBe('after') // latest value wins (read at fire time)…
    sent.blocks[0]!.props.heading = 'tampered'
    expect(tree[0]!.props.heading).toBe('after') // …but the message is a detached copy
  })

  it('sends selection immediately (no frame wait) and skips posts when the target is gone', async () => {
    const { posted, win } = makeTarget()
    let target: Window | null = win
    const sender = createPreviewSender(() => target, 'http://localhost', () => null)
    sender.sendSelected('b')
    expect(posted).toHaveLength(1)
    expect(posted[0]!.msg).toEqual({ kestrel: 'preview:selected', selectedId: 'b' })
    target = null
    sender.sendSelected(null)
    sender.sendContent([])
    await nextFrame()
    expect(posted).toHaveLength(1) // nothing new — no target, no throw
  })

  it('dispose() cancels a pending frame', async () => {
    const { posted, win } = makeTarget()
    const sender = createPreviewSender(() => win, 'http://localhost', () => null)
    sender.sendContent([])
    sender.dispose()
    await nextFrame()
    expect(posted).toHaveLength(0)
  })
})

describe('acceptsFrameEvent — the parent-side trust guard', () => {
  const frameWin = {} as Window
  const ev = (over: Partial<{ origin: string; source: unknown }>) =>
    ({ origin: 'http://localhost', source: frameWin, ...over }) as MessageEvent

  it('accepts only same-origin events sourced from the preview iframe window', () => {
    expect(acceptsFrameEvent(ev({}), frameWin, 'http://localhost')).toBe(true)
    expect(acceptsFrameEvent(ev({ origin: 'https://evil.example' }), frameWin, 'http://localhost')).toBe(false)
    expect(acceptsFrameEvent(ev({ source: {} as Window }), frameWin, 'http://localhost')).toBe(false)
    expect(acceptsFrameEvent(ev({}), null, 'http://localhost')).toBe(false)
  })
})
