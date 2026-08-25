import { describe, it, expect } from 'vitest'
import type { OwnershipManifest } from '@kestrel/contracts'
import { orderManifests, MODULE_MIGRATION_ORDER } from '../../../src/server/db/module-order.js'

const m = (module: string): OwnershipManifest => ({ module, tables: [] })

describe('orderManifests', () => {
  it('pins content → media → publishing regardless of input order', () => {
    expect(orderManifests([m('publishing'), m('media'), m('content')]).map((x) => x.module))
      .toEqual(['content', 'media', 'publishing'])
    expect(orderManifests([m('media'), m('content'), m('publishing')]).map((x) => x.module))
      .toEqual(['content', 'media', 'publishing'])
  })

  it('matches the exported MODULE_MIGRATION_ORDER constant', () => {
    const shuffled = [...MODULE_MIGRATION_ORDER].reverse().map(m)
    expect(orderManifests(shuffled).map((x) => x.module)).toEqual([...MODULE_MIGRATION_ORDER])
  })

  it('appends an unlisted module after every listed one, keeping its relative order', () => {
    const ext1 = m('gallery-secure')
    const ext2 = m('another-extension')
    expect(orderManifests([ext1, m('publishing'), ext2, m('content')]).map((x) => x.module))
      .toEqual(['content', 'publishing', 'gallery-secure', 'another-extension'])
  })

  it('is a pure sort — does not mutate the input array', () => {
    const input = [m('publishing'), m('content')]
    const copy = [...input]
    orderManifests(input)
    expect(input).toEqual(copy)
  })
})
