import { describe, it, expect, beforeEach } from 'vitest'
import { Effect } from 'effect'
import { clearPipelines, registerDefaultPipelines, registerPipeline, resolvePipeline } from '../../../src/server/pipeline/registry.js'
import { runPipeline } from '../../../src/server/pipeline/runner.js'
import { TraceCollector } from '../../../src/server/pipeline/trace.js'
import { asyncStep, syncStep } from '../../../src/server/pipeline/types.js'
import type { PipelineContext, PipelineDef, StepDef } from '../../../src/server/pipeline/types.js'

const step = (name: string, extra: Partial<StepDef> = {}): StepDef => ({ name, fn: () => Effect.void, ...extra })

const createOne = (): PipelineDef => ({
  name: 'createOne',
  access: { public: false },
  steps: [
    step('validate', { sealed: true }),
    step('transform'),
    syncStep('assertUnique', () => Effect.void, { sealed: true }),
    syncStep('persist', () => Effect.void, { sealed: true }),
  ],
  after: [{ step: step('reindexRefs'), critical: false }],
})

const names = (collection: string | null, op: string) => resolvePipeline(collection, op)!.steps.map((s) => s.name)

describe('pipeline registry', () => {
  beforeEach(() => {
    clearPipelines()
    registerDefaultPipelines([createOne()])
  })

  it('resolves the default pipeline when no consumer def exists', () => {
    const resolved = resolvePipeline('pages', 'createOne')!
    expect(resolved.name).toBe('createOne')
    expect(resolved.collection).toBe('pages')
    expect(resolved.gates.access).toEqual({ public: false })
    expect(resolved.steps.map((s) => s.name)).toEqual(['validate', 'transform', 'assertUnique', 'persist'])
    expect(resolved.after.map((a) => a.step.name)).toEqual(['reindexRefs'])
  })

  it('returns undefined for an unknown op', () => {
    expect(resolvePipeline('pages', 'nope')).toBeUndefined()
  })

  it('pulls the defaults lazily — a def registered after the provider still composes', () => {
    registerPipeline({ name: 'createOne', on: { collection: 'pages' }, patch: [{ after: 'transform', step: step('sanitize') }] })
    expect(names('pages', 'createOne')).toEqual(['validate', 'transform', 'sanitize', 'assertUnique', 'persist'])
  })

  it('applies before/after/replace patches', () => {
    registerPipeline({
      name: 'createOne',
      on: { collection: 'pages' },
      patch: [
        { before: 'transform', step: step('a') },
        { after: 'transform', step: step('b') },
        { replace: 'transform', step: step('transform2') },
      ],
    })
    expect(names('pages', 'createOne')).toEqual(['validate', 'a', 'transform2', 'b', 'assertUnique', 'persist'])
  })

  it('replaces the whole list when a def declares steps', () => {
    registerPipeline({ name: 'createOne', on: { collection: 'pages' }, steps: [step('only')] })
    expect(names('pages', 'createOne')).toEqual(['only'])
  })

  it('scopes a collection-specific def to that collection', () => {
    registerPipeline({ name: 'createOne', on: { collection: 'pages' }, steps: [step('only')] })
    expect(names('pages', 'createOne')).toEqual(['only'])
    expect(names('posts', 'createOne')).toEqual(['validate', 'transform', 'assertUnique', 'persist'])
  })

  it('composes a collection-agnostic def before a collection-specific one', () => {
    registerPipeline({ name: 'createOne', patch: [{ after: 'validate', step: step('global') }] })
    registerPipeline({ name: 'createOne', on: { collection: 'pages' }, patch: [{ after: 'global', step: step('local') }] })
    expect(names('pages', 'createOne')).toEqual(['validate', 'global', 'local', 'transform', 'assertUnique', 'persist'])
  })

  it('throws on an unknown patch anchor', () => {
    registerPipeline({ name: 'createOne', patch: [{ before: 'nope', step: step('a') }] })
    expect(() => resolvePipeline('pages', 'createOne')).toThrow('anchor "nope" matches no step')
  })

  it('refuses to replace a sealed step without unsafeReplace', () => {
    registerPipeline({ name: 'createOne', patch: [{ replace: 'persist', step: syncStep('myPersist', () => Effect.void) }] })
    expect(() => resolvePipeline('pages', 'createOne')).toThrow('is sealed')
  })

  it('replaces a sealed step with unsafeReplace', () => {
    registerPipeline({ name: 'createOne', patch: [{ replace: 'persist', step: syncStep('myPersist', () => Effect.void), unsafeReplace: true }] })
    expect(names('pages', 'createOne')).toEqual(['validate', 'transform', 'assertUnique', 'myPersist'])
  })

  it('appends after-steps instead of replacing them', () => {
    registerPipeline({ name: 'createOne', on: { collection: 'pages' }, after: [{ step: step('writeRedirects'), critical: true }] })
    const resolved = resolvePipeline('pages', 'createOne')!
    expect(resolved.after.map((a) => [a.step.name, a.critical])).toEqual([['reindexRefs', false], ['writeRedirects', true]])
  })

  it('lets a consumer def override the gate declarations', () => {
    registerPipeline({ name: 'createOne', on: { collection: 'pages' }, access: { public: true, scope: 'published' }, csrf: false })
    const resolved = resolvePipeline('pages', 'createOne')!
    expect(resolved.gates).toEqual({ access: { public: true, scope: 'published' }, csrf: false, ipAllowlist: undefined })
  })

  it('rejects a reserved name used for a differently targeted op', () => {
    expect(() => registerPipeline({ name: 'createOne', op: 'readOne', steps: [step('a')] }))
      .toThrow('reserved standard operation')
  })

  it('rejects a standard-op override registered under a custom name', () => {
    expect(() => registerPipeline({ name: 'savePage', op: 'createOne', steps: [step('a')] }))
      .toThrow("must carry the op's own name")
  })

  it('accepts a custom pipeline name', () => {
    registerPipeline({ name: 'duplicate', access: { public: false }, steps: [step('a')] })
    expect(names(null, 'duplicate')).toEqual(['a'])
  })

  it('scopes a collection-less custom pipeline to /api/<name> only', () => {
    registerPipeline({ name: 'login', access: { public: true }, steps: [step('a')] })
    expect(names(null, 'login')).toEqual(['a'])
    expect(resolvePipeline('pages', 'login')).toBeUndefined()
  })

  it('keeps a collection-less patch collection-agnostic', () => {
    registerPipeline({ name: 'createOne', patch: [{ after: 'validate', step: step('audit2') }] })
    expect(names('pages', 'createOne')).toContain('audit2')
    expect(names('posts', 'createOne')).toContain('audit2')
  })

  it('carries rawBody through to the composed pipeline', () => {
    registerPipeline({ name: 'upload', access: { role: 'admin' }, rawBody: true, steps: [step('a')] })
    expect(resolvePipeline(null, 'upload')!.rawBody).toBe(true)
    expect(resolvePipeline('pages', 'createOne')!.rawBody).toBe(false)
  })

  it('rejects two defs for the same op and scope', () => {
    registerPipeline({ name: 'createOne', on: { collection: 'pages' }, steps: [step('a')] })
    expect(() => registerPipeline({ name: 'createOne', on: { collection: 'pages' }, steps: [step('b')] }))
      .toThrow('already registered')
  })

  it('throws when a patch inserts a non-sync step into the critical section', () => {
    registerPipeline({ name: 'createOne', patch: [{ before: 'persist', step: step('audit') }] })
    expect(() => resolvePipeline('pages', 'createOne'))
      .toThrow('step "audit" is not `sync: true` but sits inside the critical section, between "assertUnique" and "persist"')
  })

  it('accepts a sync step inserted into the critical section', () => {
    registerPipeline({ name: 'createOne', patch: [{ before: 'persist', step: syncStep('audit', () => Effect.void) }] })
    expect(names('pages', 'createOne')).toEqual(['validate', 'transform', 'assertUnique', 'audit', 'persist'])
  })

  it('rejects an asyncStep-built step inserted into the critical section', () => {
    registerPipeline({ name: 'createOne', patch: [{ before: 'persist', step: asyncStep('audit', () => Effect.void) }] })
    expect(() => resolvePipeline('pages', 'createOne'))
      .toThrow('step "audit" is not `sync: true` but sits inside the critical section, between "assertUnique" and "persist"')
  })

  it('rejects a raw `sync: true` literal that did not go through syncStep', () => {
    registerPipeline({ name: 'createOne', patch: [{ before: 'persist', step: step('audit', { sync: true }) }] })
    expect(() => resolvePipeline('pages', 'createOne'))
      .toThrow('step "audit" sets `sync: true` without going through `syncStep`')
  })

  it('composes and runs an asyncStep-built step outside the critical section', async () => {
    const ran: string[] = []
    registerPipeline({
      name: 'createOne',
      on: { collection: 'pages' },
      patch: [{ after: 'transform', step: asyncStep('audit', () => Effect.gen(function* () { yield* Effect.promise(() => Promise.resolve()); ran.push('audit') })) }],
    })
    const resolved = resolvePipeline('pages', 'createOne')!
    expect(resolved.steps.map((s) => s.name)).toEqual(['validate', 'transform', 'audit', 'assertUnique', 'persist'])
    const ctx: PipelineContext = {
      input: {},
      output: {},
      work: {},
      facts: {
        collection: 'pages',
        op: 'createOne',
        principal: { userId: 'u1', role: 'admin' },
        readScope: 'all',
        locale: 'en',
        now: '2026-01-01T00:00:00.000Z',
        correlationId: 'corr-1',
        causation: { pipeline: 'createOne', op: 'createOne' },
      },
      ports: { db: null, event: null },
      exec: Object.freeze({
        collection: null,
        read: false,
        request: Object.freeze({ ip: '127.0.0.1', method: 'POST', headers: {} }),
      }),
      trace: new TraceCollector({ pipeline: 'createOne', op: 'createOne' }),
    }
    await runPipeline(resolved, ctx, {
      access: () => ({ allowed: true }),
      csrf: () => ({ allowed: true }),
      ipAllowlist: () => ({ allowed: true }),
    })
    expect(ran).toEqual(['audit'])
  })

  it('throws on a duplicate step name introduced by a patch', () => {
    registerPipeline({ name: 'createOne', patch: [{ after: 'validate', step: step('transform') }] })
    expect(() => resolvePipeline('pages', 'createOne')).toThrow('appears twice')
  })

  it('caches the composed pipeline per collection and op', () => {
    const first = resolvePipeline('pages', 'createOne')
    expect(resolvePipeline('pages', 'createOne')).toBe(first)
    expect(resolvePipeline('posts', 'createOne')).not.toBe(first)
  })

  it('invalidates the cache when a def is registered', () => {
    const first = resolvePipeline('pages', 'createOne')
    registerPipeline({ name: 'createOne', on: { collection: 'pages' }, patch: [{ after: 'validate', step: step('extra') }] })
    expect(resolvePipeline('pages', 'createOne')).not.toBe(first)
    expect(names('pages', 'createOne')).toContain('extra')
  })

  it('drops defaults and consumer defs on clearPipelines', () => {
    resolvePipeline('pages', 'createOne')
    clearPipelines()
    expect(resolvePipeline('pages', 'createOne')).toBeUndefined()
  })
})
