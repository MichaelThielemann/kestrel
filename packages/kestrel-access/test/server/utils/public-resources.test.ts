import { describe, it, expect, afterEach } from 'vitest'
import { publicReadableResources } from '../../../src/server/utils/public-resources.js'
import { clearPipelines, clearRegistry, registerCollection, registerPipeline } from '@kestrel/core'
import type { BuiltCollection } from '@kestrel/core'
const stub = (name: string, pageLike: boolean): BuiltCollection =>
  ({ name, def: { name, pageLike } } as unknown as BuiltCollection)

describe('publicReadableResources', () => {
  afterEach(() => { clearRegistry(); clearPipelines() })

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

  it('follows the read pipeline declaration, so an override moves a collection out of the set', () => {
    registerCollection(stub('pages', true))
    registerPipeline({ name: 'readMany', on: { collection: 'pages' }, access: { role: 'admin', scope: 'all' } })
    expect(publicReadableResources()).toEqual([])
  })
})
