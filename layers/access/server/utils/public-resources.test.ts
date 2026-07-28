import { describe, it, expect, afterEach } from 'vitest'
import { publicReadableResources } from './public-resources'
import { registerCollection, clearRegistry } from '../../../core/server/utils/registry'
import type { BuiltCollection } from '../../../core/server/utils/collection-types'

const stub = (name: string, pageLike: boolean): BuiltCollection =>
  ({ name, def: { name, pageLike } } as unknown as BuiltCollection)

describe('publicReadableResources', () => {
  afterEach(() => clearRegistry())

  it('returns exactly the registered pageLike collection names', () => {
    registerCollection(stub('pages', true))
    registerCollection(stub('posts', true)) // a second pageLike collection — must be public too
    registerCollection(stub('settings', false))
    registerCollection(stub('media', false))
    expect(publicReadableResources().sort()).toEqual(['pages', 'posts'])
  })

  it('is empty when no pageLike collection is registered', () => {
    registerCollection(stub('settings', false))
    expect(publicReadableResources()).toEqual([])
  })
})
