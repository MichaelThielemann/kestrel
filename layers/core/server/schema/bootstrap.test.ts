import { describe, it, expect } from 'vitest'
import { desiredFromCollections, collectionEnabled } from './bootstrap'
import { defineCollection } from '../utils/defineCollection'
import { folders } from '../../../media/server/database/folders'

describe('desiredFromCollections', () => {
  it('always includes core\'s record_refs; extra (upper-layer) tables only when passed in', () => {
    expect(Object.keys(desiredFromCollections([]))).toEqual(['record_refs'])
    expect(Object.keys(desiredFromCollections([], { extraTables: [folders] }))).toEqual(
      expect.arrayContaining(['record_refs', 'folders']),
    )
  })

  it('merges every discovered collection table', () => {
    const def = defineCollection({ name: 'widgets', mode: 'multi', translatable: false, fields: { title: { type: 'text' } } })
    const snapshot = desiredFromCollections([def])
    expect(Object.keys(snapshot)).toEqual(expect.arrayContaining(['widgets', 'record_refs']))
  })

  it('drops a DISABLED built-in from the desired schema — the registry gate and the schema engine agree', () => {
    const builtin = defineCollection({ name: 'pages', mode: 'multi', translatable: false, builtin: true, fields: { title: { type: 'text' } } })
    const own = defineCollection({ name: 'articles', mode: 'multi', translatable: false, fields: { title: { type: 'text' } } })
    const snapshot = desiredFromCollections([builtin, own], { toggles: { pages: false } })
    expect(Object.keys(snapshot)).not.toContain('pages')
    expect(Object.keys(snapshot)).toContain('articles')
    // enabled (default / explicit true) built-ins stay
    expect(Object.keys(desiredFromCollections([builtin, own], { toggles: {} }))).toContain('pages')
    expect(Object.keys(desiredFromCollections([builtin, own], { toggles: { pages: true } }))).toContain('pages')
  })

  it('collectionEnabled: only a builtin with an explicit false toggle is disabled (non-builtins ignore toggles)', () => {
    const builtin = defineCollection({ name: 'media', mode: 'multi', translatable: false, builtin: true, fields: {} })
    const own = defineCollection({ name: 'media2', mode: 'multi', translatable: false, fields: {} })
    expect(collectionEnabled(builtin, { media: false })).toBe(false)
    expect(collectionEnabled(builtin, {})).toBe(true)
    expect(collectionEnabled(builtin, undefined)).toBe(true)
    expect(collectionEnabled(own, { media2: false })).toBe(true)
  })
})
