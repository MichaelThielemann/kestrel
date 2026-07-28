import { describe, it, expect } from 'vitest'
import {
  PREVIEW_QUERY, PREVIEW_FALLBACK_PATH,
  contentMessage, selectedMessage, readyMessage, selectMessage,
  parseEditorMessage, parseFrameMessage, previewSrc,
} from './preview-protocol'

describe('preview message builders + parsers', () => {
  it('round-trips the editor→frame messages (content, selected)', () => {
    const content = contentMessage([{ id: 'a', type: 'hero', props: {} }], 'a')
    expect(parseEditorMessage(content)).toEqual(content)
    const selected = selectedMessage(null)
    expect(parseEditorMessage(selected)).toEqual(selected)
  })

  it('round-trips the frame→editor messages (ready, select)', () => {
    expect(parseFrameMessage(readyMessage())).toEqual(readyMessage())
    expect(parseFrameMessage(selectMessage('b1'))).toEqual(selectMessage('b1'))
  })

  it('rejects foreign postMessage traffic (HMR, extensions, primitives, null)', () => {
    for (const junk of [null, undefined, 'webpackHotUpdate', 42, {}, { type: 'vite:ping' }, { kestrel: 'bogus' }, []]) {
      expect(parseEditorMessage(junk)).toBeNull()
      expect(parseFrameMessage(junk)).toBeNull()
    }
    // A frame message is not an editor message and vice versa.
    expect(parseEditorMessage(readyMessage())).toBeNull()
    expect(parseFrameMessage(contentMessage([], null))).toBeNull()
  })

  it('rejects malformed payloads on otherwise-valid types', () => {
    expect(parseEditorMessage({ kestrel: 'preview:content', blocks: 'nope', selectedId: null })).toBeNull()
    expect(parseEditorMessage({ kestrel: 'preview:selected', selectedId: 42 })).toBeNull()
    expect(parseFrameMessage({ kestrel: 'preview:select', id: 42 })).toBeNull()
  })
})

describe('previewSrc — the iframe URL for the editor host', () => {
  it('uses the record public URL (+ preview flag) when one exists', () => {
    expect(previewSrc('/about', 'en')).toBe(`/about?${PREVIEW_QUERY}=1`)
    expect(previewSrc('/de/ueber-uns', 'de')).toBe(`/de/ueber-uns?${PREVIEW_QUERY}=1`)
  })

  it('falls back to the dedicated preview route (with locale) when there is no public URL', () => {
    expect(previewSrc(null, 'de')).toBe(`${PREVIEW_FALLBACK_PATH}?${PREVIEW_QUERY}=1&locale=de`)
    expect(previewSrc(null, '')).toBe(`${PREVIEW_FALLBACK_PATH}?${PREVIEW_QUERY}=1`)
  })
})
