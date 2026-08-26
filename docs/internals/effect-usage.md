# Effect in this codebase

The house idiom for using Effect-TS in the pipeline engine: the runtime singleton, where Promises take over, the service pattern, and three runtime gotchas no type signature carries.

## The runtime is a process-long singleton

`packages/kestrel-core/src/server/pipeline/runner.ts` constructs one `ManagedRuntime` at module load and reuses it for the life of the process — never per request, never per run:

```ts
const runtime = ManagedRuntime.make(Layer.empty)
```

`Layer.empty` resolves no external dependency (no DB, no config, no field types), so its construction time doesn't matter — it's equally safe the instant the module is first reached, whichever plugin or import triggers that. A request's `PipelineContext` is still built fresh per request; only the runtime handle underneath it is long-lived. The two drivers do not share that access equally:

```ts
function runSyncEffect<TOut>(effect: Effect.Effect<TOut, unknown>, guardMessage: string): TOut {
  try {
    return Effect.runSync(effect)
  } catch (error) {
    const unwrapped = unwrapFiberFailure(error)
    if (isAsyncFiberException(unwrapped)) throw new Error(guardMessage, { cause: error })
    throw unwrapped
  }
}

async function runPromiseEffect<TOut>(effect: Effect.Effect<TOut, unknown>): Promise<TOut> {
  try {
    return await runtime.runPromise(effect)
  } catch (error) {
    throw unwrapFiberFailure(error)
  }
}
```

`runPromiseEffect` runs through the singleton (`runtime.runPromise`); `runSyncEffect` calls bare `Effect.runSync(effect)` and never touches `runtime` at all — the sync driver has no access to whatever layers the runtime eventually holds. Both squash the same `FiberFailure` wrapper before the error reaches HTTP handling — see the first gotcha below.

## Promises at the boundary

Effect stops at the response boundary, not at the package boundary. A step body is typed `StepFn = (ctx: PipelineContext) => Effect.Effect<void, KestrelError>` — a `@public` export, like `syncStep`/`asyncStep` — and writes its result into `ctx.output`/`ctx.work` rather than returning it. Anyone authoring a step needs `effect` at the pinned version, whether the step lives in-tree, in an extension, or in a consumer project; see [Extending](../guide/extending.md) for the consumer-facing recipe. What doesn't cross is a pipeline's *result*: `runPipelineSync` returns `TOut` synchronously and `runAfterStepsSync` returns `void` (the latter drives the media bypass-CRUD path only), both exported alongside their Promise-returning counterparts, and `runPipelineForEventAuto` picks the sync driver whenever every step in the composed pipeline is `sync` and no after-step is critical — which covers most HTTP requests, not just a CRUD facade. Either way, a tagged error crosses as a serialized value union — never as an Effect type or a raw throw. The consumer adapter seam (`AdapterContract<T>`) is compile-time only today — no Layer, no runtime decode; see [Extension points](./extension-points.md).

## The service pattern: `Context.Tag` plus an explicit `Layer`

Effect offers two supported service idioms — the `Effect.Service` sugar class and the separate tag/layer form. This codebase uses the separate form: the tag is the contract, the layer is the wiring, and neither is implied by the other. `packages/kestrel-core/src/server/db/module-db.ts` builds one per module:

```ts
const tag = Context.GenericTag<ModuleDbService>(`@michaelthielemann/kestrel-ModuleDb/${manifest.module}`)
const service: ModuleDbService = { /* ... */ }
return { layer: Layer.succeed(tag, service), tag }
```

In this codebase the pattern draws a table-ownership boundary, not runtime DI: no step type declares an `R` requirement, and production code collapses the layer immediately — `Effect.runSync(Effect.scoped(Effect.provide(tag, layer)))` — and caches the resulting plain service in a module-level singleton (`useContentDbFor`/`useContentDb` in `content-db.ts`, the same shape in `publishing-db.ts` and `media-db.ts`). A test provides the real layer through that same `Effect.provide` call, not a stub or in-memory substitute — the Live/Test/InMemory layer trio ADR-0011 anticipated was never built; there is one layer per module and tests use it. (A step reads the engine-owned `ctx.ports` bag; nothing is declared per step — see the `PipelinePorts` type above, not [Extension points](./extension-points.md)'s "declared ports" phrasing.)

## Three gotchas

None of these is stated in a type; all three cost real verification work to pin down and stay true only for `effect`'s pinned `~3.22.1` line (see [Decisions](./decisions.md), ADR-0011 and ADR-0019 — the latter is where the `StepFn` channel above and the second gotcha below were actually settled, superseding ADR-0011's `R`/ports channel and its "the public API never speaks Effect" framing). An `effect` upgrade must run `test/architecture/effect-runsync-gate.test.ts` before merge; a failure there means the third gotcha's guarantee is gone.

- **`Effect.runSync` / `runPromise` failures surface wrapped in `FiberFailure`, not as the original error.** The pipeline runner's two drivers (`runSyncEffect`, `runPromiseEffect` above) both squash the cause back out (`Cause.squash` on the `FiberFailureCauseId` field) to preserve the original thrown value — a `KestrelError` or a genuine defect — reaching its consumer unchanged. Other run boundaries in the codebase skip the unwrap and get away with it because their effects' error channel is `never`, so only a defect could surface: `pollOnce` (`outbox-worker.ts`) is a bare `Effect.runPromise`, `resolveAccess` (`kestrel-access/utils/policy.ts`) is a bare `Effect.runSync`, and `validate.ts` uses `Effect.runSyncExit`. A fourth boundary with a real error channel needs the same squash the runner does — call `runStepSync`/`runStepAsync` from `test/helpers/run-effect.ts` in a test that exercises a step's `fn(ctx)` directly, never bare `Effect.runSync`, or the assertion sees the `FiberFailure` wrapper instead of the original error.
- **A plain `try`/`catch`/`finally` around a `yield* effect` inside `Effect.gen` does not observe the effect's failure — but `Effect.tryPromise` does turn a synchronous `throw` into a normal failure.** Only Effect's own combinators (`Effect.catchAll`, `Effect.catchAllCause`, `Effect.ensuring`) see a `yield*`ed effect's failure; a surrounding plain `try`/`catch`/`finally` skips straight past it to the step's own boundary. A synchronous `throw` inside the same `Effect.gen` body — not through `yield*` — does propagate normally, so the two look interchangeable until a failure actually needs intercepting or cleaning up after. The runner leans on the opposite direction of this at its gate/async bridge: `Effect.tryPromise({ try: () => Promise.resolve(fn()), catch: (error) => error })` turns a synchronous throw inside `fn` into the effect's own failure exactly like a rejected promise would — see [Pipeline engine](./pipeline-engine.md) for the step-body version of this gotcha.
- **The `runSync` critical section relies on a genuine async boundary throwing, not suspending — and gates use a separate mechanism to enforce the same rule.** `runPipelineSync` drives the *whole* plan under `runSyncEffect` — gates, every main step, every after-step — and `runAfterStepsSync` drives an after-step list alone for the media bypass-CRUD path. For a step, a genuinely async Effect suspends `Effect.runSync` itself, which throws `AsyncFiberException` natively; the runner catches that specific exception and turns it into the guard error above. A gate is not a step — it's a plain function, not an Effect — so the sync driver wraps it in `Effect.sync` with an explicit `isThenable` check instead: a gate evaluator whose result turns out to be a promise anyway throws the same guard error by hand, since there's no `Effect.runSync` suspension to catch there. `assertCriticalSection` additionally rejects a non-sync step inside the contiguous section at compose time, so a smuggled async step fails twice over — once at compose time, once if it ever reached `runSync` anyway.

## See also

- [Pipeline engine](./pipeline-engine.md) — gates, sealed steps, and the critical section the third gotcha protects.
- [Extension points](./extension-points.md) — the adapter seam a consumer authors against today, `AdapterContract<T>` with no Layer and no runtime decode.
- [Extending](../guide/extending.md) — the consumer-facing recipe for writing a step against the `effect` dependency.
- [Decisions](./decisions.md) — ADR-0011's `effect` version pin and the `runSync` critical-section ruling, and ADR-0019, which superseded its `R`/ports channel and public-API framing.
