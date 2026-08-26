import { describe, it, expect, afterEach } from 'vitest'
import { getResolvedKestrelConfig, setResolvedKestrelConfig } from '@michaelthielemann/kestrel-core'
import { aiDisclosureEnabled } from '../../../src/server/utils/ai-disclosure-enabled.js'

const ORIG = getResolvedKestrelConfig()
const stubAiDisclosure = (enabled: unknown) => {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), aiDisclosure: { enabled: enabled as boolean } })
}
afterEach(() => { setResolvedKestrelConfig(ORIG) })

describe('aiDisclosureEnabled', () => {
  it('is false by default — a consumer who configures nothing gets none of this feature', () => {
    stubAiDisclosure(undefined)
    expect(aiDisclosureEnabled()).toBe(false)
  })

  it('is true only for an explicit opt-in', () => {
    stubAiDisclosure(true)
    expect(aiDisclosureEnabled()).toBe(true)
    stubAiDisclosure(false)
    expect(aiDisclosureEnabled()).toBe(false)
  })

  it('never reads a truthy non-boolean as on', () => {
    stubAiDisclosure('yes')
    expect(aiDisclosureEnabled()).toBe(false)
  })
})
