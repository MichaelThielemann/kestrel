# @michaelthielemann/kestrel
The core: `defineContract`, `defineModule`, `definePipeline`, `defineConfig`, the boot check and
the pipeline runner with HTTP, event and cron triggers. It ships no contracts and no modules;
a config without modules boots as an empty shell. `boot()` reads the config, sorts modules by
`requires`, runs `setup()`, checks every provided contract's methods, registers steps, resolves
pipelines and validates triggers; any problem throws `KestrelBootError { module, reason }`. A
condition that boot does not treat as fatal — for example an event trigger whose event no
pipeline emits and no module declares in `emits` — is both logged through `logger.warn` and
returned as `kestrel.warnings: BootWarning[]`, so a caller can assert the list is empty even
against a logger that discards warnings; the same list is also in `describe().warnings`, so a
module's `attach()` hook and `insights.readManifest` see it without a separate channel.
`BootWarning` is a discriminated union on `code`;
today's members are `{ code: "unemitted-event", message, pipeline, event }` and `{ code:
"unwritten-optional-read", message, pipeline, step, key }` (an optional read, `"key?"`, whose key
no step of any booted pipeline writes and no trigger provides — almost always a typo), and a
future minor release may add further codes, so code reading `kestrel.warnings` must handle a
`code` it does not recognize. A step that writes `result` without declaring `output`,
`extendsOutput`, `extendsItems`, `binary: true` or, when its sole `result` write is optional
(`result?`), `terminalOutput`; an object schema among those that declares `properties` without a
`required` key; and an `extendsOutput`/`extendsItems` that cannot fold onto the active output
schema (another type, a type array, a union with a non-object branch, and more — naming the reason)
each fail `boot()` outright with a `KestrelBootError` naming the pipeline and the step.
The `kestrel` binary loads `kestrel.config.ts`, the modules named in `use` and `pipelines/*.ts`
from the current directory. `testing/runPipeline` runs a pipeline against fake steps or, with
`modules: [{ module, instance }]`, against a module's real steps and schemas. Before every step
the runner validates the body against the step's `describe().input` and the declared query
parameters against `describe().query` (coerced from strings), answering `VALIDATION` 400 with
`details.problems` on a mismatch — in every environment. `boot({ validateOutput: true })` (default
off) and `testing/runPipeline` (always on) additionally validate `ctx.result` after every step
that writes it against the pipeline's output schema folded up to that point
(`@michaelthielemann/kestrel/schema`'s `resolveOutputSchema`), failing with the step name and the
JSON path on a mismatch. A step that ends the run with `ctx.done()` declares that result's shape as
`terminalOutput` instead — never folded — and the same validation checks it against that schema.

## Introspection
`kestrel.describe()` is the static manifest of the booted instance, computed once: every module
with `use`, package version, contracts, config schema (JSON Schema from the Zod schema) and config
variables (path, type, required, default, secret, set — never a value; fields marked
`.describe("secret")` show no default), every step with owner and description, every pipeline with
its resolved steps, every trigger. `kestrel.observe(observer)` registers a `RunObserver`
(`runStart`, `runEnd`, `stepStart`, `stepEnd`) fed by the runner independently of the logger and
returns the unsubscribe. `kestrel.health()` aggregates every module's own `health()` hook,
synchronously and with no I/O: `ok: false` means a readiness probe should route no traffic here,
`restartRequired: true` means a liveness probe should restart the process rather than retry. A
module reaches all three through its `attach(instance, { describe, observe, health })` hook,
called at the end of boot; a returned function runs on `stop()`.

## Checking a config without booting
`checkBoot(input, { setup })` runs every check `boot()` runs and returns every problem in
`errors` instead of throwing at the first, sharing `boot()`'s engine so the two check the same
things the same way; it never starts a trigger. `setup: "none"` runs no module code beyond
`configSchema` and reports anything that needed an instance in `notChecked`; `setup: "all"` runs
every module's `setup()`/`attach()`/`teardown()`; `{ only: [...] }` runs them for the named `use`
entries only.

## Entry points
The package exports a fixed list of subpaths; everything else (boot internals, registry, sorting,
trigger implementations, tests) is private and not importable. `@michaelthielemann/kestrel` (the
root: `boot`, `checkBoot`, `defineContract`, `defineModule`, `definePipeline`, `defineConfig`, the
HTTP helpers an adapter needs, the error and result vocabulary) and `@michaelthielemann/kestrel/<name>`
for `atomic`, `cast`, `catalogue`, `context`, `defineConfig`, `defineContract`, `defineModule`,
`definePipeline`, `errors`, `instanceLock`, `load`, `logger`, `reads`, `result`, `runner`, `schema` and
`testing/runPipeline`. `instanceLock` (`acquireInstanceLock`, `instanceLockFile`) keeps a second process off a
database file: the lock is a sidecar `<file>.instance` next to the database, never a row inside it, so it never
travels with a replica, snapshot or restore. A lock whose heartbeat (every 10 s) is older than its TTL (60 s; the
lock file records the holder's, and the longer of that and the caller's applies) is taken over,
and so is one whose process on the same machine and in the same PID namespace is gone (judged by PID and process
start time). Any other lock makes `acquireInstanceLock` throw a `KestrelBootError` with code `instance-locked` at
once, naming the holder's host, PID and start time and the time from which the lock is taken over. That includes a
lock from another PID namespace, such as the previous run of a container restarted after its process was killed:
its boot fails until 60 s after that run's last heartbeat, so a restart policy has to retry, unless the kernel gave
the new namespace the old one's id. A process that exits on its own, through `process.exit()` or an uncaught
exception gives up its lock on exit; only a killed process leaves it behind. Several holders in one process share
the lock, also across worker threads, and the file goes with the last release; within one thread the first holder's
options apply.
In-memory and temporary databases (`:memory:`, an empty name, `file:` URIs with `mode=memory`) take none, and
`health()` turns `restartRequired` once another instance took the lock over.
`reads` (`observeReads`, `noteRead`, `unobserved`) lets a caller see what the providers
answered while a function ran, in the same process and async context; `delivery-static` uses it to record what a
render read (see `docs/contracts.md`). The core imports no contract, no module and no host framework; ESLint
enforces that for `core`, `contracts` (only the core) and the `h3` adapter (only `h3` and the core).
Binary results are served `inline` for a built-in safe set of content types plus any listed in `http.inlineTypes`.
`http.inlineTypes` with `image/svg+xml` needs a module registering the step `sanitize.svg`
(`sanitize-svg`), otherwise boot fails.

## HTTP config
`http` takes `port`, `host`, `corsOrigin`, `maxBodyBytes`, `multipart`, `trustProxy`, `proxyHops`, `trustedHeader`,
`trustedProxies`, `allow`, `healthPath`, `inlineTypes`
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
