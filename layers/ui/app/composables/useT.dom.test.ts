import { describe, it, expect } from 'vitest'
import { translate, interpolate } from './useT'

describe('interpolate', () => {
  it('replaces {name} placeholders from params', () => {
    expect(interpolate('New {label}', { label: 'Page' })).toBe('New Page')
    expect(interpolate('{a} and {b}', { a: 1, b: 2 })).toBe('1 and 2')
  })
  it('leaves a placeholder untouched when its param is missing', () => {
    expect(interpolate('Hi {name}', {})).toBe('Hi {name}')
    expect(interpolate('Hi {name}')).toBe('Hi {name}')
  })
})

describe('translate', () => {
  const en = { 'a.b': 'Hello', greet: 'Hi {name}', 'list.new': 'New {label}' }
  const de = { 'a.b': 'Hallo' }

  it('uses the active catalog when the key exists', () => {
    expect(translate(de, en, 'a.b')).toBe('Hallo')
  })
  it('falls back to the fallback catalog when the active one lacks the key', () => {
    expect(translate(de, en, 'greet', { name: 'Mo' })).toBe('Hi Mo')
  })
  it('falls back to the key itself when neither catalog has it', () => {
    expect(translate(de, en, 'totally.missing')).toBe('totally.missing')
  })
  it('interpolates params into the resolved string', () => {
    expect(translate(en, en, 'list.new', { label: 'Thing' })).toBe('New Thing')
  })
})
