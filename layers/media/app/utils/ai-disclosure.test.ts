import { describe, it, expect } from 'vitest'
import { aiSourceTypeLabel } from './ai-disclosure'

describe('aiSourceTypeLabel', () => {
  it('labels each value of the disclosure vocabulary', () => {
    expect(aiSourceTypeLabel('trainedAlgorithmicMedia')).toBe('AI-generated')
    expect(aiSourceTypeLabel('compositeWithTrainedAlgorithmicMedia')).toBe('Contains AI-generated content')
    expect(aiSourceTypeLabel('algorithmicallyEnhanced')).toBe('AI-edited')
  })
  it('returns an unknown value verbatim rather than inventing a disclosure for it', () => {
    expect(aiSourceTypeLabel('somethingElse')).toBe('somethingElse')
    expect(aiSourceTypeLabel('')).toBe('')
  })
})
