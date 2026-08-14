import { describe, it, expect, afterEach } from 'vitest'
import { aiDisclosureEnabled } from './ai-disclosure-enabled'

const original = globalThis.useRuntimeConfig
const stubRuntimeConfig = (value: unknown) => {
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => value
}
afterEach(() => { (globalThis as Record<string, unknown>).useRuntimeConfig = original })

describe('aiDisclosureEnabled', () => {
  it('is false by default — a consumer who configures nothing gets none of this feature', () => {
    stubRuntimeConfig({ kestrel: {} })
    expect(aiDisclosureEnabled()).toBe(false)
  })

  it('is true only for an explicit opt-in', () => {
    stubRuntimeConfig({ kestrel: { aiDisclosure: { enabled: true } } })
    expect(aiDisclosureEnabled()).toBe(true)
    stubRuntimeConfig({ kestrel: { aiDisclosure: { enabled: false } } })
    expect(aiDisclosureEnabled()).toBe(false)
  })

  it('never reads a truthy non-boolean as on', () => {
    stubRuntimeConfig({ kestrel: { aiDisclosure: { enabled: 'yes' } } })
    expect(aiDisclosureEnabled()).toBe(false)
  })
})
