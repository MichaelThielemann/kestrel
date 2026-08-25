import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  setResolvedKestrelConfig, getResolvedKestrelConfig, clearResolvedKestrelConfig,
} from '../../../src/server/utils/kestrel-config-provider.js'
import type { ResolvedKestrel } from '../../../src/server/utils/kestrel-config.js'

const sample = { dbPath: ':memory:', siteUrl: 'https://example.test' } as unknown as ResolvedKestrel

describe('kestrel-config-provider', () => {
  // The global test/setup.ts seeds the provider (so every OTHER test in this package gets a resolved
  // config for free) — undo that here so this suite starts from the genuinely-unset state it tests.
  beforeEach(() => {
    clearResolvedKestrelConfig()
  })
  afterEach(() => {
    clearResolvedKestrelConfig()
  })

  it('throws before the boot-wiring plugin has called the setter', () => {
    expect(() => getResolvedKestrelConfig()).toThrow(/setResolvedKestrelConfig/)
  })

  it('round-trips the exact object the setter was given', () => {
    setResolvedKestrelConfig(sample)
    expect(getResolvedKestrelConfig()).toBe(sample)
  })

  it('clearResolvedKestrelConfig resets to the throwing state', () => {
    setResolvedKestrelConfig(sample)
    clearResolvedKestrelConfig()
    expect(() => getResolvedKestrelConfig()).toThrow(/setResolvedKestrelConfig/)
  })
})
