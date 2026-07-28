import { describe, it, expect } from 'vitest'
import { recordTitle } from './record-title'

const text = { type: 'text' }

describe('recordTitle', () => {
  it('prefers a text field named `title`', () => {
    const fields = { name: text, title: text }
    expect(recordTitle(fields, { name: 'Nope', title: 'Cyber Security Report 2026' })).toBe('Cyber Security Report 2026')
  })

  it('falls back to the FIRST text field when there is no `title`', () => {
    const fields = { headline: text, subline: text }
    expect(recordTitle(fields, { headline: 'First', subline: 'Second' })).toBe('First')
  })

  it('ignores a non-text field named `title` (matches the auto-slug pick)', () => {
    const fields = { title: { type: 'number' }, headline: text }
    expect(recordTitle(fields, { title: 7, headline: 'Real headline' })).toBe('Real headline')
  })

  it('trims the value', () => {
    expect(recordTitle({ title: text }, { title: '  Padded  ' })).toBe('Padded')
  })

  it('returns empty for a blank, missing, or non-string value', () => {
    expect(recordTitle({ title: text }, { title: '   ' })).toBe('')
    expect(recordTitle({ title: text }, {})).toBe('')
    expect(recordTitle({ title: text }, { title: 42 })).toBe('')
  })

  it('returns empty when the collection has no text field at all', () => {
    expect(recordTitle({ count: { type: 'number' } }, { count: 1 })).toBe('')
  })
})
