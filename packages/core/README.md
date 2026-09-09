# @michaelthielemann/kestrel
The core: `defineContract`, `defineModule`, `definePipeline`, `defineConfig`, the boot check and
the pipeline runner with HTTP, event and cron triggers. It ships no contracts and no modules;
a config without modules boots as an empty shell. `boot()` reads the config, sorts modules by
`requires`, runs `setup()`, checks every provided contract's methods, registers steps, resolves
pipelines and validates triggers; any problem throws `KestrelBootError { module, reason }`.
The `kestrel` binary loads `kestrel.config.ts`, the modules named in `use` and `pipelines/*.ts`
from the current directory. `testing/runPipeline` runs a pipeline against fake steps.

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

## Shutdown
`stop()` closes the listener, waits for the in-flight runs and for connections still sending a
request or receiving a response, then drops the remaining connections, stops the cron and event
triggers and tears the modules down in reverse boot order. The deadline is `stop({ timeoutMs })`
or the top-level config `shutdownTimeoutMs` (default 30000); the returned `{ drained }` says whether
everything finished inside it. The `kestrel` binary wires SIGINT/SIGTERM to `stop()` (exit 1 when the
deadline is hit) and logs `unhandledRejection`/`uncaughtException` before stopping and exiting 1.
