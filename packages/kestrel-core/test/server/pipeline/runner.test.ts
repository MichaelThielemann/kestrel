import { describe, it, expect, vi } from 'vitest'
import { Effect } from 'effect'
import { runPipeline, runPipelineSync } from '../../../src/server/pipeline/runner.js'
import { TraceCollector, type StepTraceEntry } from '../../../src/server/pipeline/trace.js'
import { syncStep, type AfterStepDef, type PipelineContext, type RequestFacts, type ResolvedPipeline, type StepDef } from '../../../src/server/pipeline/types.js'

function isThenable(value: unknown): boolean {
  return typeof (value as Promise<unknown> | undefined)?.then === 'function'
}

// This suite tests the runner's own orchestration (ordering, tracing, error propagation) against the OLD
// throw/promise-returning step shape most of these cases were written against — genuinely testing the
// runner, not the KestrelError channel. Rather than rewriting every case into Effect.gen, this local helper
// bridges a throw/promise-returning function into a real StepFn: a pure sync return never touches an async
// primitive (so the "runs through runSync as one synchronous frame" test still holds), and a thenable
// result converts to a real suspension (so the sync-guard test still trips it, now via Effect's own
// AsyncFiberException instead of a bespoke isThenable check).
function toStepFn(fn: (ctx: PipelineContext) => void | Promise<void>): StepDef['fn'] {
  return (ctx) => Effect.sync(() => fn(ctx)).pipe(
    Effect.flatMap((result) => (isThenable(result)
      ? Effect.tryPromise({ try: () => result as Promise<void>, catch: (error) => error }).pipe(Effect.catchAll((error) => Effect.die(error)))
      : Effect.void)),
  ) as ReturnType<StepDef['fn']>
}

const step = (name: string, fn: (ctx: PipelineContext) => void | Promise<void> = () => {}, extra: Partial<StepDef> = {}): StepDef => ({ name, fn: toStepFn(fn), ...extra })

function context(facts: Partial<RequestFacts> = {}): PipelineContext<Record<string, unknown>, Record<string, unknown>> {
  return {
    input: {},
    output: {},
    work: {},
    facts: {
      collection: '',
      op: 'createOne',
      principal: { userId: 'u1', role: 'admin' },
      readScope: 'published',
      locale: 'en',
      now: '2026-01-01T00:00:00.000Z',
      correlationId: 'corr-1',
      causation: { pipeline: 'createOne', op: 'createOne' },
      ...facts,
    },
    ports: { db: null, event: null },
    exec: Object.freeze({
      collection: null,
      read: false,
      request: Object.freeze({ ip: '127.0.0.1', method: 'POST', headers: {} }),
    }),
    trace: new TraceCollector({ pipeline: 'createOne', op: facts.op ?? 'createOne' }),
  }
}

function pipeline(steps: StepDef[], overrides: Partial<ResolvedPipeline> = {}): ResolvedPipeline {
  return { name: 'createOne', collection: null, read: false, rawBody: false, gates: { access: { public: false } }, steps, after: [], ...overrides }
}

describe('runPipeline gates', () => {
  it('refuses to run without an access declaration', async () => {
    const ctx = context()
    const ran: string[] = []
    const resolved = pipeline([step('a', () => { ran.push('a') })], { gates: {} })
    await expect(runPipeline(resolved, ctx)).rejects.toMatchObject({ _tag: 'Forbidden' })
    expect(ran).toEqual([])
    expect(ctx.trace.toJSON().gates).toEqual([{ gate: 'access', passed: false, detail: 'no access declaration — default deny' }])
  })

  it('evaluates every gate before the first step', async () => {
    const seen: string[] = []
    const ctx = context()
    const resolved = pipeline([step('a', () => { seen.push('step:a') })])
    await runPipeline(resolved, ctx, {
      access: () => { seen.push('gate:access'); return { allowed: true } },
      csrf: () => { seen.push('gate:csrf'); return { allowed: true } },
      ipAllowlist: () => { seen.push('gate:ip'); return { allowed: true } },
    })
    // ip → csrf → access: the network-level refusals settle before the request's identity is considered.
    expect(seen).toEqual(['gate:ip', 'gate:csrf', 'gate:access', 'step:a'])
  })

  it('denies an anonymous caller on a non-public pipeline', async () => {
    const ctx = context({ principal: null })
    await expect(runPipeline(pipeline([step('a')]), ctx)).rejects.toMatchObject({ _tag: 'Forbidden' })
    expect(ctx.trace.toJSON().gates.at(-1)).toEqual({ gate: 'access', passed: false, detail: 'authentication required' })
  })

  it('writes the access gate\'s read scope into env', async () => {
    const ctx = context({ principal: null, op: 'readMany', readScope: 'all' })
    await runPipeline(pipeline([], { gates: { access: { public: true } } }), ctx)
    expect(ctx.facts.readScope).toBe('published')
  })

  it('requires csrf for a write op and skips it for a read op', async () => {
    const csrf = vi.fn(() => ({ allowed: true }))
    await runPipeline(pipeline([]), context(), { csrf })
    expect(csrf).toHaveBeenCalledTimes(1)
    const readCtx = context({ op: 'readMany' })
    await runPipeline(pipeline([], { name: 'readMany', read: true }), readCtx, { csrf })
    expect(csrf).toHaveBeenCalledTimes(1)
    expect(readCtx.trace.toJSON().gates).toContainEqual({ gate: 'csrf', passed: true, detail: 'not required' })
  })

  it('aborts on a failing csrf gate before any step runs', async () => {
    const ran: string[] = []
    const ctx = context()
    await expect(runPipeline(pipeline([step('a', () => { ran.push('a') })]), ctx, {
      csrf: () => ({ allowed: false, detail: 'missing token' }),
    })).rejects.toMatchObject({ _tag: 'Forbidden' })
    expect(ran).toEqual([])
    expect(ctx.trace.toJSON().steps).toEqual([])
  })

  it('aborts on a failing ip gate', async () => {
    await expect(runPipeline(pipeline([]), context(), {
      ipAllowlist: () => ({ allowed: false, detail: 'ip 10.0.0.1 not allowed' }),
    })).rejects.toThrow('ip 10.0.0.1 not allowed')
  })
})

describe('runPipeline steps', () => {
  it('runs steps in order and returns the output', async () => {
    const ran: string[] = []
    const ctx = context()
    const resolved = pipeline([
      step('a', (c) => { ran.push('a'); c.work.value = 1 }),
      step('b', async (c) => { await Promise.resolve(); ran.push('b'); (c.output as Record<string, unknown>).id = c.work.value }),
    ])
    const output = await runPipeline(resolved, ctx)
    expect(ran).toEqual(['a', 'b'])
    expect(output).toEqual({ id: 1 })
  })

  it('skips a step whose condition is false and records the label', async () => {
    const ran: string[] = []
    const ctx = context()
    const resolved = pipeline([
      step('resolveSlug', () => { ran.push('resolveSlug') }, { when: () => false, whenLabel: 'pageLike only' }),
      step('persist', () => { ran.push('persist') }, { when: () => true }),
    ])
    await runPipeline(resolved, ctx)
    expect(ran).toEqual(['persist'])
    expect(ctx.trace.toJSON().steps).toEqual([
      expect.objectContaining({ name: 'resolveSlug', status: 'skipped-condition', reason: 'pageLike only' }),
      expect.objectContaining({ name: 'persist', status: 'ok' }),
    ])
  })

  it('aborts on the first throwing step and traces the error', async () => {
    const ran: string[] = []
    const ctx = context()
    const resolved = pipeline([
      step('a', () => { ran.push('a') }),
      step('b', () => { throw new Error('boom') }),
      step('c', () => { ran.push('c') }),
    ])
    await expect(runPipeline(resolved, ctx)).rejects.toThrow('boom')
    expect(ran).toEqual(['a'])
    const steps = ctx.trace.toJSON().steps
    expect(steps.map((s: StepTraceEntry) => [s.name, s.status])).toEqual([['a', 'ok'], ['b', 'error']])
    expect(steps[1]!.reason).toBe('boom')
  })

  it('traces a duration and step annotations', async () => {
    const ctx = context()
    await runPipeline(pipeline([step('persist', (c) => { c.trace.annotate('rows', 2) })]), ctx)
    const entry = ctx.trace.toJSON().steps[0]!
    expect(entry.annotations).toEqual({ rows: 2 })
    expect(entry.ms).toBeGreaterThanOrEqual(0)
  })
})

describe('runPipeline after-steps', () => {
  const after = (name: string, critical: boolean, fn: (ctx: PipelineContext) => void | Promise<void>): AfterStepDef => ({ step: step(name, fn), critical })

  it('runs after-steps once the main list is done', async () => {
    const ran: string[] = []
    const resolved = pipeline([step('persist', () => { ran.push('persist') })], {
      after: [after('reindexRefs', false, () => { ran.push('reindexRefs') })],
    })
    await runPipeline(resolved, context())
    expect(ran).toEqual(['persist', 'reindexRefs'])
  })

  it('logs a non-critical failure into the trace and keeps going', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ran: string[] = []
    const ctx = context()
    const resolved = pipeline([], {
      after: [
        after('reindexRefs', false, () => { throw new Error('index down') }),
        after('planPublish', false, () => { ran.push('planPublish') }),
      ],
    })
    await expect(runPipeline(resolved, ctx)).resolves.toEqual({})
    expect(ran).toEqual(['planPublish'])
    expect(ctx.trace.toJSON().steps).toEqual([
      expect.objectContaining({ name: 'reindexRefs', phase: 'after', critical: false, status: 'error', reason: 'index down' }),
      expect.objectContaining({ name: 'planPublish', status: 'ok' }),
    ])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('rethrows a critical failure and stops the remaining after-steps', async () => {
    const ran: string[] = []
    const ctx = context()
    const resolved = pipeline([], {
      after: [
        after('writeRedirects', true, () => { throw new Error('artifact write failed') }),
        after('planPublish', false, () => { ran.push('planPublish') }),
      ],
    })
    await expect(runPipeline(resolved, ctx)).rejects.toThrow('artifact write failed')
    expect(ran).toEqual([])
    expect(ctx.trace.toJSON().steps).toEqual([
      expect.objectContaining({ name: 'writeRedirects', critical: true, status: 'error' }),
    ])
  })

  it('honours a condition on an after-step', async () => {
    const ctx = context()
    const resolved = pipeline([], {
      after: [{ step: step('writeRedirects', () => { throw new Error('never') }, { when: () => false, whenLabel: 'site singleton only' }), critical: true }],
    })
    await expect(runPipeline(resolved, ctx)).resolves.toEqual({})
    expect(ctx.trace.toJSON().steps[0]).toMatchObject({ status: 'skipped-condition', reason: 'site singleton only' })
  })
})

describe('Effect drivers', () => {
  // Same interleaving-marker technique as the ADR-0011 runSync gate (test/architecture/effect-runsync-gate.test.ts):
  // arm a timer/microtask before the call, then have every step observe whether it already fired. A truly
  // synchronous `Effect.runSync` run cannot let an armed callback interleave mid-run — only a driver that
  // secretly yields to the event loop could let one flip early.
  it('an all-sync composed pipeline runs through runSync as one synchronous frame', () => {
    let intruded = false
    setImmediate(() => { intruded = true })
    setTimeout(() => { intruded = true }, 0)
    queueMicrotask(() => { intruded = true })

    const observedIntrusion: boolean[] = []
    const ctx = context()
    const resolved = pipeline([
      step('a', (c) => { observedIntrusion.push(intruded); c.work.value = 1 }),
      step('b', (c) => { observedIntrusion.push(intruded); (c.output as Record<string, unknown>).id = c.work.value }),
    ])

    const output = runPipelineSync(resolved, ctx)

    expect(output).toEqual({ id: 1 })
    expect(observedIntrusion).toEqual([false, false])
  })

  it('a mixed pipeline (a genuinely async step) runs through the async driver and awaits it', async () => {
    const ran: string[] = []
    const ctx = context()
    const resolved = pipeline([
      step('a', async (c) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        ran.push('a')
        c.work.value = 7
      }),
      step('b', (c) => { ran.push('b'); (c.output as Record<string, unknown>).id = c.work.value }),
    ])

    const output = await runPipeline(resolved, ctx)

    expect(ran).toEqual(['a', 'b'])
    expect(output).toEqual({ id: 7 })
  })

  // A step branded `sync: true` (via syncStep) whose Effect actually suspends (a real async primitive,
  // not just an imperative function returning a promise) must not be silently unawaited. Effect.runSync
  // itself throws AsyncFiberException on hitting it — runSyncEffect turns that into the same guard
  // message the old isThenable check produced.
  it('a syncStep whose effect actually suspends trips the runSync guard', () => {
    const ctx = context()
    const liar = syncStep('liar', () => Effect.promise(() => Promise.resolve()))
    const resolved = pipeline([liar])

    expect(() => runPipelineSync(resolved, ctx))
      .toThrow('pipeline "createOne" was run synchronously but a step or gate returned a promise')
  })
})
