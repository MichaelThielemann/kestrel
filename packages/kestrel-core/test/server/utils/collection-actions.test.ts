import { describe, it, expect, beforeEach } from 'vitest'
import { Effect } from 'effect'
import { buildCollectionActions } from '../../../src/server/utils/collection-actions.js'
import { defineCollection } from '../../../src/index.js'
import { buildCollection } from '../../../src/server/schema/buildCollection.js'
import { clearRegistry, registerCollection } from '../../../src/server/utils/registry.js'
import { clearPipelines, registerPipeline } from '../../../src/server/pipeline/registry.js'
import { syncStep } from '../../../src/server/pipeline/types.js'
// Side-effect import: hands the registry the defaults installer that ensureDefaultPipelines re-runs
// after each clearPipelines — in the server the router's defaults import does this.
import '../../../src/server/pipeline/defaults.js'

const posts = buildCollection(defineCollection({
  name: 'posts', mode: 'multi', status: true,
  fields: { title: { type: 'text', required: true } },
}))

beforeEach(() => {
  clearPipelines()
  clearRegistry()
  registerCollection(posts)
})

describe('buildCollectionActions', () => {
  it('always includes the built-in bulk set (deleteMany, duplicate), both kind "both", never updateMany', () => {
    const actions = buildCollectionActions('posts')
    const names = actions.map((a) => a.name)
    expect(names).toEqual(['deleteMany', 'duplicate'])
    expect(actions.every((a) => a.kind === 'both')).toBe(true)
    expect(names).not.toContain('updateMany')
  })

  it('gives deleteMany/duplicate their POST route under the collection', () => {
    const [deleteMany, duplicate] = buildCollectionActions('posts')
    expect(deleteMany!.route).toEqual({ url: '/api/posts/deleteMany', method: 'POST' })
    expect(duplicate!.route).toEqual({ url: '/api/posts/duplicate', method: 'POST' })
  })

  it('surfaces a consumer-registered custom write pipeline as a "bulk" action by default', () => {
    registerPipeline({ name: 'archive', on: { collection: 'posts' }, access: { role: 'admin' }, steps: [syncStep('archive', () => Effect.void)] })
    const archive = buildCollectionActions('posts').find((a) => a.name === 'archive')
    expect(archive).toEqual({ name: 'archive', route: { url: '/api/posts/archive', method: 'POST' }, kind: 'bulk' })
  })

  it('carries ui metadata (kind, label, icon, confirm) from the custom PipelineDef through', () => {
    registerPipeline({
      name: 'archive',
      on: { collection: 'posts' },
      access: { role: 'admin' },
      steps: [syncStep('archive', () => Effect.void)],
      ui: { kind: 'record', label: { en: 'Archive', de: 'Archivieren' }, icon: 'archive', confirm: true },
    })
    const archive = buildCollectionActions('posts').find((a) => a.name === 'archive')
    expect(archive).toEqual({
      name: 'archive',
      route: { url: '/api/posts/archive', method: 'POST' },
      kind: 'record',
      label: { en: 'Archive', de: 'Archivieren' },
      icon: 'archive',
      confirm: true,
    })
  })

  it('excludes a custom pipeline that overrides a standard op or a tooling read (not a NEW action)', () => {
    registerPipeline({ name: 'updateOne', on: { collection: 'posts' }, patch: [] })
    const names = buildCollectionActions('posts').map((a) => a.name)
    expect(names).toEqual(['deleteMany', 'duplicate'])
  })

  it('excludes a custom READ pipeline (navigation, not an action)', () => {
    registerPipeline({ name: 'report', on: { collection: 'posts' }, read: true, access: { role: 'admin' }, steps: [{ name: 'report', fn: () => Effect.void }] })
    const names = buildCollectionActions('posts').map((a) => a.name)
    expect(names).not.toContain('report')
  })

  it('does not leak a custom pipeline registered for a different collection', () => {
    registerPipeline({ name: 'archive', on: { collection: 'other' }, access: { role: 'admin' }, steps: [syncStep('archive', () => Effect.void)] })
    const names = buildCollectionActions('posts').map((a) => a.name)
    expect(names).not.toContain('archive')
  })
})
