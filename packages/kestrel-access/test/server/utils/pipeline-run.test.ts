import { describe, it, expect, afterEach } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { Effect } from 'effect'
import { asyncStep, clearPipelines, registerDefaultPipelines, syncStep } from '@kestrel/core'
import type { PipelineDef } from '@kestrel/core'
import { runPipelineForEventAuto } from '../../../src/server/utils/pipeline-run.js'

function eventFor(): H3Event {
  return createEvent(
    { method: 'POST', url: '/api/thing', headers: { 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '203.0.113.1' } } as never,
    { setHeader() {} } as never,
  )
}

afterEach(() => { clearPipelines() })

// This predicate (not the hardcoded drivers it picks between) is what decides whether a request runs
// through Effect.runSync or the async ManagedRuntime driver — a real pipeline shape on each side of the
// branch, not a synthetic call straight into the runner.
describe('runPipelineForEventAuto — the sync-vs-async dispatch predicate', () => {
  it('an all-sync write pipeline returns a non-Promise result', () => {
    registerDefaultPipelines([{
      name: 'allSync',
      access: { public: true },
      steps: [syncStep('a', (ctx) => Effect.sync(() => { ctx.output = { ok: true } }))],
    } satisfies PipelineDef])

    const result = runPipelineForEventAuto(eventFor(), { op: 'allSync' })

    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toEqual({ ok: true })
  })

  it('a pipeline containing a non-sync step returns a Promise', () => {
    registerDefaultPipelines([{
      name: 'hasAsyncStep',
      access: { public: true },
      steps: [asyncStep('a', (ctx) => Effect.promise(async () => { ctx.output = { ok: true } }))],
    } satisfies PipelineDef])

    expect(runPipelineForEventAuto(eventFor(), { op: 'hasAsyncStep' })).toBeInstanceOf(Promise)
  })

  it('a pipeline with a critical after-step returns a Promise even though every main step is sync', () => {
    registerDefaultPipelines([{
      name: 'criticalAfter',
      access: { public: true },
      steps: [syncStep('a', (ctx) => Effect.sync(() => { ctx.output = { ok: true } }))],
      after: [{ step: syncStep('b', () => Effect.void), critical: true }],
    } satisfies PipelineDef])

    expect(runPipelineForEventAuto(eventFor(), { op: 'criticalAfter' })).toBeInstanceOf(Promise)
  })

  it('a non-critical after-step does not force the async driver', () => {
    registerDefaultPipelines([{
      name: 'nonCriticalAfter',
      access: { public: true },
      steps: [syncStep('a', (ctx) => Effect.sync(() => { ctx.output = { ok: true } }))],
      after: [{ step: syncStep('b', () => Effect.void), critical: false }],
    } satisfies PipelineDef])

    expect(runPipelineForEventAuto(eventFor(), { op: 'nonCriticalAfter' })).not.toBeInstanceOf(Promise)
  })
})
