import { describe, it, expect } from 'vitest'
import {
  PREVIEW_QUERY, PREVIEW_FALLBACK_PATH,
  contentMessage, selectedMessage, readyMessage, selectMessage,
  parseEditorMessage, parseFrameMessage, previewSrc, previewPage,
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

describe('previewPage — the editor\'s unsaved values over the saved record', () => {
  const saved = { title: 'Saved', content: [{ type: 'hero' }], seo: { title: 'S' }, status: 'published' }

  it('overrides only what the editor sent', () => {
    expect(previewPage(saved, { title: 'Unsaved' })).toEqual({ ...saved, title: 'Unsaved' })
  })

  it('renders from the payload alone when the page does not exist yet (an unsaved slug)', () => {
    expect(previewPage(null, { title: 'Brand new', content: [] })).toEqual({ title: 'Brand new', content: [] })
  })

  it('is the saved record untouched when there is no ticket', () => {
    expect(previewPage(saved, null)).toBe(saved)
    expect(previewPage(saved, undefined)).toBe(saved)
  })

  it('drops the stale $<relation> sidecar when a single relation is cleared to null', () => {
    const withAuthor = { ...saved, authorId: 5, $author: { id: 5, name: 'Jane' } }
    expect(previewPage(withAuthor, { authorId: null })).toEqual({ ...saved, authorId: null })
  })

  it('drops the stale $media.<field> sidecar when a single media field is cleared to null', () => {
    const withCover = { ...saved, coverId: 5, $media: { cover: { id: 5, url: '/cover.jpg' } } }
    expect(previewPage(withCover, { coverId: null })).toEqual({ ...saved, coverId: null, $media: {} })
  })

  it('control: an untouched relation/media field KEEPS its sidecar', () => {
    const withBoth = {
      ...saved,
      authorId: 5, $author: { id: 5, name: 'Jane' },
      coverId: 9, $media: { cover: { id: 9, url: '/cover.jpg' } },
    }
    expect(previewPage(withBoth, { title: 'Unsaved' })).toEqual({ ...withBoth, title: 'Unsaved' })
  })
})
