# Kestrel – Architecture

## Goal

A CMS backend assembled from interchangeable building blocks. Two kinds of wiring:

- **Operational** (`kestrel.config.ts`): *which* building blocks are active, with what settings.
- **Functional** (`pipelines/`): *how* the building blocks work together, in what order.

Kestrel itself is a registry of steps, pipelines and triggers, plus a runner.

## Terms

| Term | Meaning | Where in the repo |
|---|---|---|
| **Contract** | `defineContract(name, methods)` + interface, e.g. `persistence@1`. Domain-neutral. | Package `kestrel-contracts` or with the consumer |
| **Module** | Just a name segment, no code. Groups submodules of the same contract. | Prefix in the package name |
| **Submodule** | Implementation of a contract. Plugin pattern. One package. | `packages/<module>-<submodule>/` |
| **Step** | Pure function `(ctx) => Promise<Result<Context, KestrelError>>`, provided by a submodule. Success is `ok(ctx)`/`ok({ ...ctx, … })`, an expected failure is `ctx.fail(...)`; `throw` is reserved for wiring errors. | in the submodule |
| **Pipeline** | Ordered list of steps. Contains the business logic. | `pipelines/` |
| **Trigger** | HTTP endpoint, event, cron. Starts a pipeline. | `kestrel.config.ts` |
| **Kestrel** | Registry, boot check, runner. | Package `kestrel`, `packages/core/` |
| **Adapter** | Binds a booted instance's triggers to a foreign runtime (e.g. h3/Nitro). Knows neither contracts nor modules. | its own package, e.g. `kestrel-h3` |

## Packages

Without modules, Kestrel is an empty shell. Every building block is its own npm package; a
consumer installs exactly what it uses. Someone using SIAM never installs `authn-single`.

| Package | Contents |
|---|---|
| `@michaelthielemann/kestrel` | Core: `defineContract`, `defineModule`, `definePipeline`, `defineConfig`, boot, runner, triggers. Knows not a single contract. |
| `@michaelthielemann/kestrel-contracts` | The standard contracts, with contract tests. |
| `@michaelthielemann/kestrel-<module>-<submodule>` | One submodule each, e.g. `-persistence-sqlite`, `-authn-single`. Depends only on the core and the contracts. |

Repository (pnpm workspace):

```
packages/
  core/src/            @michaelthielemann/kestrel
  contracts/src/       @michaelthielemann/kestrel-contracts
  <module>-<submodule>/  one submodule per folder: module.ts, impl.ts, impl.test.ts, README.md
examples/
  minimal/             first consumer: kestrel.config.ts, pipelines/
```

The complete, current package list lives in the table in `../README.md` — it grows with every
new submodule and is deliberately not duplicated here.

Consumer project:

```
my-site/
  kestrel.config.ts    operational wiring: which packages, which triggers
  pipelines/           functional wiring: your own flows
  modules/             optional: your own submodules (own or third-party contracts)
```

## Modes of operation

The HTTP server in the core is just *one* trigger. An instance can be used in two ways:

1. **Standalone**: `kestrel` (CLI) boots from `kestrel.config.ts`, starts the HTTP, event and
   cron triggers. Clients speak HTTP (see `api.md`); `http.allow` closes the server to a list of
   addresses or CIDR ranges (see `pipelines.md` § HTTP Operation).
2. **Embedded**: A host (Nuxt/Nitro, Express, a script) imports the core, modules and pipelines
   statically, calls `boot()` and then `kestrel.run(pipeline, input)` directly — without an
   HTTP round trip. `http: null` in the config turns off the built-in server; event and cron
   triggers keep running after `start()`. `kestrel.triggers.http` + `matchRoute()` map the
   configured routes onto the host's requests. An **adapter** such as `kestrel-h3` does exactly
   that for a given framework. Example: `../examples/embedded`.

In both cases: only pipelines with a trigger are reachable from outside.

## The five rules

1. **Submodules don't know each other.** Only contracts are the shared language.
2. **Contracts are domain-neutral.** Test question: "Would a shop or a forum need the same
   interface?" If not, domain knowledge has slipped into the wrong layer.
   Example: `persistence@1` knows nothing about users. `authn/multi` brings its own schema.
   Routing vocabulary — home slug, language prefix in URLs, path ↔ document,
   `kestrel:<type>:<id>` in public paths — therefore lives in `site@1`, not in `content@1`;
   `content@1` is generic document CRUD.
3. **Submodules provide steps, not triggers.** No submodule has a route or throws events. The
   one exception: a submodule emits from a contract method itself when the fact arises without a
   pipeline (`apply()` also runs at boot) or when a partial failure of that method has already
   produced the fact (a `fail` would end the pipeline before an `events.emit` step); today that is
   only `migrations.applied`. Every further exception needs a row with its reason in the event
   table of `pipelines.md`.
4. **Business logic lives in pipelines.** A pipeline file shows the complete flow.
5. **Errors at boot, not at runtime.** A missing contract, a missing method, an unknown step,
   a cycle → Kestrel doesn't start, and names the module and the cause.

## Boot sequence

1. Read `kestrel.config.ts`.
2. Load active submodules (`use` is a package name or a relative path), sort topologically by
   `requires`. `optional` additionally orders a submodule after the provider of a contract, if
   that provider is active — a missing optional provider is not a boot error, and
   `deps.find(contract)` then returns `undefined` instead of throwing.
3. For every submodule: check `requires` against the registry → call `setup(config, deps)` →
   check the return value against the contract type (is every method present?) → register it
   under `provides`.
4. Add every submodule's steps to the step registry (`authn.requireUser` etc.); every step needs
   a `describe()` entry with `summary`, `reads`, `writes` (required, otherwise
   `KestrelBootError`).
5. Load pipelines, resolve every step string against the step registry, then check each
   pipeline's data flow (`checkDataflow`): every `reads` path of a step must be covered by the
   `writes` of an earlier step or by the context's baseline (`payload`, `headers`, `files`, `ip`,
   `params.<p>` bound by any HTTP route of the pipeline), otherwise boot aborts.
6. Check and register triggers (HTTP server, event bus, cron). Event triggers need a module with
   `triggers.event` — the core ships none and therefore knows no contract name for it.

If any step fails: abort with `KestrelBootError { module, reason }`.

## Errors loud and cheap – four levels

| Level | Mechanism | Cost |
|---|---|---|
| Compile | Contracts are TS interfaces, `setup()` returns the contract type. ESLint `no-restricted-imports` forbids submodule→submodule imports. Step names are a type: `StepCatalogue<Modules>` plus `pipelineDefiner<Known>()` turn an unknown or mistyped step in a pipeline file into a `tsc` error instead of a boot error (`pipelines.md` § Step catalogue). | immediate |
| Test | One contract test per contract, every implementation must pass it. | seconds |
| Boot | Registry check as above; `describe()` is required for every step, and `checkDataflow` proves that every `reads` path was written before it's used. | at startup |
| Value (runtime) | Expected errors are `Result` values, not a `throw`: every async contract method and every step returns `Result<T, KestrelError>` (`{ code, status, message, retryable, details?, cause? }`, a code-→-status table `STATUS_OF`); `throw` is reserved for wiring errors and becomes a 500 `INTERNAL`. Details: `pipelines.md` § Errors as values, `contracts.md`. | per call |

## Config and context

Two separate data flows that a submodule never mixes:

- **Config** is static. It's read once at boot from `kestrel.config.ts`, parsed per submodule
  against its `configSchema` (Zod), and passed as the first argument to `setup(config, deps)`.
  It doesn't change during an instance's runtime.
- **Context** is dynamic. The runner builds it fresh per run (`runner.ts`) and passes it through
  a pipeline's steps; it carries `trigger`, `payload`, `params`, `headers`, `files`, `ip` and
  `result` (see `pipelines.md`).

A submodule never reads config from the context, nor context from the config — `setup()` closes
over the config, every step gets its runtime data exclusively via `ctx`.

## Workflow state: status in the schema, delivery state in its own table

The editorial status (`published`, `draft`, or other consumer-defined values) is an `enum` field
the consumer defines in the content schema, not a separate workflow module (see `contracts.md`).
"Public only shows `published`" is a fixed pipeline filter
(`content.list:pages?status=published`), not a state machine of its own.

Separately, `delivery-static` keeps its own table `delivery_publish_status` with one row per
document and language (`state: live | error | draft`, see `api.md`). This is deliberately *not*
a duplication of the same state, but two different things: the status in the schema is the
editorial *intent* ("this should be published"), `delivery_publish_status` is the *result* of
the last render/write attempt into the blobstore. Rendering can fail while the editorial status
stays `published` — the editor then sees `error` with a cause, instead of a silently stale
delivery state. There is deliberately no separate state machine for the editorial status
(transitions, conditions, its own `pages.publish` permission) — the status stays a plain schema
field, every value is reachable from every other value.

## What is deliberately not done

- No layered folders (`domain/`, `application/`, `infrastructure/`) inside submodules. The
  hexagonal separation happens at the contract boundary, not below it.
- No `shared/`, `utils/`, `helpers/` folders. Whatever two submodules need is a contract, or
  belongs in Kestrel.
- No dependency-injection framework. `setup(config, deps)` is enough.

## Recommended build order

1. `packages/core` and `packages/contracts` (one instance, then freeze).
2. Vertical slice: `authn-single` + `persistence-sqlite` + `content-default` + pipelines for
   login and pages (see `../examples/minimal`).
3. Only once that runs: distribute further submodules across multiple instances in parallel.
