import { describe, it, expect } from 'vitest'
import { resolveInitialTheme } from './useTheme'

describe('resolveInitialTheme', () => {
  it('honours an explicit stored choice over the system preference', () => {
    expect(resolveInitialTheme({ stored: 'dark', prefersDark: false })).toBe('dark')
    expect(resolveInitialTheme({ stored: 'light', prefersDark: true })).toBe('light')
  })

  it('follows the OS prefers-color-scheme when there is no stored choice', () => {
    expect(resolveInitialTheme({ stored: null, prefersDark: true })).toBe('dark')
    expect(resolveInitialTheme({ stored: null, prefersDark: false })).toBe('light')
  })

  it('defaults to light when nothing is known', () => {
    expect(resolveInitialTheme({})).toBe('light')
  })

  it('treats an unknown stored value as unset and falls back to the system preference', () => {
    expect(resolveInitialTheme({ stored: 'sepia', prefersDark: true })).toBe('dark')
    expect(resolveInitialTheme({ stored: '', prefersDark: false })).toBe('light')
  })
})
