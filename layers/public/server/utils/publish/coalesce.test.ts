import { describe, it, expect } from 'vitest'
import { coalesce } from './coalesce'

describe('coalesce', () => {
  it('any full wins', () => {
    expect(coalesce([{ type: 'tags', tags: ['a'], render: [], prune: [] }, { type: 'full' }])).toEqual({ type: 'full' })
  })

  it('unions tags/render/prune across tag intents (dedupe, insertion order)', () => {
    expect(coalesce([
      { type: 'tags', tags: ['a'], render: ['/x'], prune: [] },
      { type: 'tags', tags: ['b', 'a'], render: ['/y'], prune: ['/z'] },
      { type: 'noop' },
    ])).toEqual({ type: 'tags', tags: ['a', 'b'], render: ['/x', '/y'], prune: ['/z'] })
  })

  it('all noop (or empty) → noop', () => {
    expect(coalesce([{ type: 'noop' }, { type: 'noop' }])).toEqual({ type: 'noop' })
    expect(coalesce([])).toEqual({ type: 'noop' })
  })
})
