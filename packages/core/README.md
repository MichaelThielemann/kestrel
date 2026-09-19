# @michaelthielemann/kestrel
The core: `defineContract`, `defineModule`, `definePipeline`, `defineConfig`, the boot check and
the pipeline runner with HTTP, event and cron triggers. It ships no contracts and no modules;
a config without modules boots as an empty shell. `boot()` reads the config, sorts modules by
`requires`, runs `setup()`, checks every provided contract's methods, registers steps, resolves
pipelines and validates triggers; any problem throws `KestrelBootError { module, reason }`.
The `kestrel` binary loads `kestrel.config.ts`, the modules named in `use` and `pipelines/*.ts`
from the current directory. `testing/runPipeline` runs a pipeline against fake steps or, with
`modules: [{ module, instance }]`, against a module's real steps and schemas. Before every step
the runner validates the body against the step's `describe().input` and the declared query
parameters against `describe().query` (coerced from strings), answering `VALIDATION` 400 with
`details.problems` on a mismatch — in every environment.

## Introspection
`kestrel.describe()` is the static manifest of the booted instance, computed once: every module
with `use`, package version, contracts, config schema (JSON Schema from the Zod schema) and config
variables (path, type, required, default, secret, set — never a value; fields marked
`.describe("secret")` show no default), every step with owner and description, every pipeline with
its resolved steps, every trigger. `kestrel.observe(observer)` registers a `RunObserver`
(`runStart`, `runEnd`, `stepStart`, `stepEnd`) fed by the runner independently of the logger and
returns the unsubscribe. A module reaches both through its `attach(instance, { describe, observe })`
hook, called at the end of boot; a returned function runs on `stop()`.

## Entry points
The package exports a fixed list of subpaths; everything else (boot internals, registry, sorting,
trigger implementations, tests) is private and not importable. `@michaelthielemann/kestrel` (the
root: `boot`, `defineContract`, `defineModule`, `definePipeline`, `defineConfig`, the HTTP helpers
an adapter needs, the error and result vocabulary) and `@michaelthielemann/kestrel/<name>` for
`cast`, `catalogue`, `context`, `dataflow`, `defineConfig`, `defineContract`, `defineModule`,
`definePipeline`, `errors`, `load`, `logger`, `result`, `runner`, `schema` and
`testing/runPipeline`. The core imports no contract, no module and no host framework; ESLint
enforces that for `core`, `contracts` (only the core) and the `h3` adapter (only `h3` and the core).
Binary results are served `inline` for a built-in safe set of content types plus any listed in `http.inlineTypes`.
`http.inlineTypes` with `image/svg+xml` needs a module registering the step `sanitize.svg`
(`sanitize-svg`), otherwise boot fails.

## HTTP config
`http` takes `port`, `host`, `corsOrigin`, `maxBodyBytes`, `trustProxy`, `healthPath`, `inlineTypes`
and `timeouts: { requestMs, headersMs, keepAliveMs }` (defaults 30000 / 10000 / 5000), which map to
`server.requestTimeout`, `server.headersTimeout` and `server.keepAliveTimeout`. An incoming
`x-request-id` header of short printable ASCII becomes `ctx.requestId`, appears in the `http` log
line and is echoed as the `x-request-id` response header next to `x-kestrel-run-id`.

## Logging
`consoleLogger` stamps every line with ISO 8601 and the local UTC offset rather than `Z`: it runs on
one machine, and the offset keeps the line readable in local time without losing the absolute point.

## Shutdown
`stop()` closes the listener, waits for the in-flight runs and for connections still sending a
request or receiving a response, then drops the remaining connections, stops the cron and event
triggers and tears the modules down in reverse boot order. The deadline is `stop({ timeoutMs })`
or the top-level config `shutdownTimeoutMs` (default 30000); the returned `{ drained }` says whether
everything finished inside it. The `kestrel` binary wires SIGINT/SIGTERM to `stop()` (exit 1 when the
deadline is hit) and logs `unhandledRejection`/`uncaughtException` before stopping and exiting 1.
