# Configuration

Reference for `kestrel.config.ts` — the operational wiring of an instance — and for the two
command line tools. Per-module settings are not here: every module documents its own config in its
README, and the generated table there lists each key with its type and default.

```ts
import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({ modules: [], triggers: [] });
```

`defineConfig` is only a typed identity function; the values are parsed against a Zod schema at
boot. The object is closed: an unknown top-level key aborts the boot.

## Top level

| Key | Type | Default | Meaning |
|---|---|---|---|
| `modules` | `{ use, config? }[]` | required | The active modules, in dependency order |
| `triggers` | trigger[] | required | What starts which pipeline |
| `http` | object \| `null` | `{}` | The built-in HTTP server; `null` turns it off (embedded mode) |
| `pipelinesDir` | string | `"./pipelines"` | Where the `kestrel` binary looks for pipeline files |
| `shutdownTimeoutMs` | integer | `30000` | Deadline for draining in-flight runs on `stop()` |

## `modules`

```ts
{ use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data.db" } }
{ use: "./modules/my-authz/module.ts", config: {} }
```

`use` is a package name or a relative path; the file's default export must be a `defineModule()`
result. A package name is resolved from the project's `package.json`, a relative path against the
directory of the config file. Kestrel activates nothing implicitly — a module that is installed but
not listed here does not exist for the instance.

`config` is parsed against that module's `configSchema`; an invalid value aborts the boot naming
the module. Relative paths inside a module's config resolve against `deps.root`, the directory of
the loaded config file.

Setup order follows these rules, applied in order:

1. a module is set up after the provider of every contract in its `requires`;
2. and after the provider of every contract in its `optional` that is active;
3. and before the provider of every contract in its `before`;
4. and, if it declares `emits`, after the module providing the event trigger hook, unless that
   module depends on it, so an event raised during setup can already be delivered;
5. otherwise, the listed order is kept.

A module that declares `before: [C]` is set up before the provider of `C`, regardless of where
either module sits in `modules`. Naming a contract whose provider depends on the declarer, directly
or transitively — including a module that both `requires` and declares `before` on the same
contract — is a contradiction and fails the boot as a dependency cycle, naming the path.

### Host-supplied defaults

A tool that writes module entries on the consumer's behalf can hand its values over as defaults
instead of as `config`:

```ts
{
  use: "@michaelthielemann/kestrel-delivery-static",
  defaults: { from: "my-preset", values: { dependencies: { render: "events" } } },
  config: { dependencies: { maxPerRender: 200 } },
}
```

`from` names the source (non-empty); `values` is an object. Boot lays `config` over `values` and
parses the result. An entry without `config` gets `values` as its config. When the merged config
is invalid, the boot error says `invalid config (with defaults from "my-preset")`, since the
offending key may come from either layer.

The merge follows three rules:

- Plain objects merge key by key, and `config` wins at every path. That includes map-shaped options
  such as a record of content types: an entry `config` gives for a key the defaults also have is
  merged into the default entry, not swapped for it.
- An array replaces the default array whole. To keep what the defaults list and add to it,
  `config` repeats the default entries; a host whose list must always survive keeps it out of
  `defaults`.
- `null`, a string, a number or any other non-object value in `config` replaces the default too.
  `null` does not bring back the schema's own default; to get that value, write it out.

The difference shows in `kestrel.describe()` and the insights manifest. A path only `values`
carries is reported as `status: "default"` with `source: "my-preset"`. A path `config` carries is
`set`, whether or not `values` also has it. Below a `config` value that replaced a default object,
such as `null`, no path reports a `source`: those paths fall back to the schema's own defaults.
Secrets are redacted the same way in both layers. See [api.md](api.md)
for the variable fields; `effectiveModuleConfig(entry)` from the package root returns the merged
config of an entry.

## `triggers`

Three forms, all equal-standing inputs to the same runner:

```ts
{ http: "GET /pages/:id",  pipeline: "readPage" }
{ event: "page.created",   pipeline: "invalidateCache" }
{ cron: "0 3 * * *",       pipeline: "cleanupSessions" }
```

- **http** — `<METHOD> <path>` with `GET|POST|PUT|PATCH|DELETE`. `:name` captures one segment,
  `*name` as the last segment captures the rest of the path; exact routes beat wildcards. Per
  segment the order is literal, then `:param`, then the end of the route, then `*rest`, so a literal
  route wins whenever it was registered. Route parameters arrive as `ctx.params`.
- **event** — needs a module providing the event trigger hook (`events-direct` or
  `events-queue`; the bus module `events-inmemory` provides `events@1` but no hook); without one,
  configured event triggers abort the boot. An event that nothing emits is a boot warning, not an
  error.
- **cron** — five fields (minute, hour, day of month, month, day of week) with `*`, lists, ranges
  and `/step`. The scheduler ticks once a minute; if the previous run of that pipeline is still
  going, the tick is skipped and logged.

Only a pipeline with a trigger is reachable from outside. A pipeline without one can still be run
through `kestrel.run(name, input)` — that is how an embedded host calls it.

## `http`

Omitted, `http` behaves as `{}` and every key takes its default. `http: null` starts no server;
event and cron triggers still run.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `port` | integer 0–65535 | `3000` | `0` picks a free port |
| `host` | string | `"127.0.0.1"` | Interface to bind |
| `corsOrigin` | string | – | Single allowed origin; omitted means no CORS headers. The browser may send `Content-Type`, `Authorization` and `X-Request-Id` and may read `X-Kestrel-Run-Id`, `X-Request-Id` and `Retry-After` |
| `maxBodyBytes` | integer | `10485760` | A larger body answers 413, checked against `Content-Length` and while reading |
| `multipart.maxParts` | integer | `120` | Parts per `multipart/form-data` body; one more answers 413 |
| `multipart.maxFiles` | integer | `20` | Parts with a `filename` per body; one more answers 413 |
| `multipart.maxFields` | integer | `100` | Parts without a `filename` per body; one more answers 413 |
| `trustProxy` | boolean | `false` | Read the client address from `X-Forwarded-For` of a trusted proxy |
| `proxyHops` | integer | `1` | Which `X-Forwarded-For` entry, counted from the right |
| `trustedHeader` | string | – | A header the trusted proxy sets to the client address; wins over `trustProxy` |
| `trustedProxies` | string[] | `["127.0.0.0/8", "::1"]` | Peers (addresses or CIDR ranges) whose forwarding headers count |
| `allow` | string[] | `[]` | IPv4/IPv6 addresses or CIDR ranges; empty means open |
| `healthPath` | string \| `null` | `"/health"` | Answers `{ ok, restartRequired }` from `kestrel.health()` without a pipeline |
| `inlineTypes` | string[] | `[]` | Content types served `inline` beyond the built-in safe set |
| `timeouts.requestMs` | integer | `30000` | `server.requestTimeout` |
| `timeouts.headersMs` | integer | `10000` | `server.headersTimeout` |
| `timeouts.keepAliveMs` | integer | `5000` | `server.keepAliveTimeout` |

`allow` is checked before routing, for health and CORS preflight too; an entry of `allow` or
`trustedProxies` that is neither an address nor a CIDR range aborts the boot. `image/svg+xml` in `inlineTypes` requires a module that
registers the step `sanitize.svg`, otherwise the boot aborts.

`healthPath` is a liveness probe and needs no authentication. It answers `{ ok, restartRequired }`
from `kestrel.health()` (see [`architecture.md`](architecture.md) § Module hooks and
`kestrel.health()`), read afresh on every request: 503 once a module reports
`restartRequired: true`, because the process cannot recover without a restart, and 200 otherwise —
also while `ok` is false, since a module that is not ok but needs no restart recovers on its own. The
body carries nothing else; which module is not ok, and why, stays in `kestrel.health().modules`, for
code that holds the booted `Kestrel` instance to expose behind its own access check. A readiness
probe routes on `ok`; a host that needs one answers its own route from `kestrel.health()`.

Request and response behaviour — headers, the `http` log line, client-address resolution, binary
results — is described in [`pipelines.md`](pipelines.md) § HTTP Operation.

## Command line

The `kestrel` command lives in `@michaelthielemann/kestrel-cli`, a regular dependency of a backend
project. The package installs the same program under a second name, `kestrel-cli`, which is the one
`npx`/`pnpm dlx` run.

```
kestrel [start]
kestrel check    [--root <dir>] [--json] [--fail-on error|warning] [--run-setup <use>]... [--no-plugins]
kestrel explain  <pipeline> [--json | --mermaid] [--depth <n>] [--root <dir>] [--run-setup <use>]... [--no-plugins]
kestrel explain  --event <name> [--json | --mermaid] [--depth <n>] [--root <dir>] [--run-setup <use>]... [--no-plugins]
kestrel manifest [--json] [--root <dir>] [--run-setup <use>]... [--no-plugins]
kestrel openapi  [--out <file>] [--title <t>] [--version <v>] [--server <url>] [--mount <path>]
                 [--root <dir>] [--run-setup <use>]... [--no-plugins]
kestrel upgrade  check|fix|data [options]
kestrel help [<command>] | kestrel --help | -h | kestrel --version | -v
```

Results go to stdout (text, JSON, Mermaid, OpenAPI); diagnostics go to stderr. Every command except
`upgrade` refuses an unknown option or a missing value with exit 2 and its usage. `--version` is
global only as the first argument; after `openapi` it is the document's version.

**`start`** (also no command at all) takes no options. It loads `kestrel.config.ts`, the modules
named in `use` and every `*.ts` file in `pipelinesDir` (excluding `*.test.ts`), all relative to the
current directory, then boots and starts the triggers and logs `kestrel started`. Module configs
resolve their relative paths (a SQLite `file`, a blob store `root`) against the current directory
too, so run it from the project root; a systemd unit sets `WorkingDirectory=`. `SIGINT`/`SIGTERM`
run the shutdown; it exits 0 once drained and 1 when the deadline is hit or the shutdown fails, and
logs `unhandledRejection`/`uncaughtException` before stopping with exit 1. A boot failure logs one
`boot failed` line and exits 1. It runs the project's own installed `@michaelthielemann/kestrel`
and loads nothing else of the CLI: no inspection, OpenAPI or upgrade code. When that core is missing
or its major differs from the CLI's, it exits 2 before loading anything.

**`check`, `explain`, `manifest`, `openapi`** load the project named by `--root` (default: the
current directory) into a scratch copy, which is also the process's working directory while they
run, and remove the copy afterwards. Nothing is written into the project. Storage modules are
rewritten into the copy by the sandbox described below; a module the sandbox does not know runs its
`setup()` only when `--run-setup <use>` names it, and otherwise its pipelines are reported as not
checked.

- `check` runs `checkBoot()` of the project's core and lists every load issue, boot problem, warning
  and not-checked item with its module and cause, plus the problems a host package's plugin finds
  (see below). `--json` prints `{ schema: 1, tool, project, plugins, issues, errors, warnings,
  notChecked, host, sandbox }`. Exit `0` when nothing is at or above `--fail-on` (default `error`;
  `warning` also fails on warnings and not-checked items), `1` otherwise, `2` when it could not run.
  It is a ready-made CI gate for the boot check.
- `explain <pipeline>` prints the pipeline's triggers and steps (owning module, atomic group,
  `reads`/`writes`, the event an `events.emit` step emits, the `events.relay` step), the events its
  modules declare in `emits`, and for each event every listening pipeline with its delivery:
  `direct`, or `queue` with the lane and whether the request relays it, read from the effective
  config of `events-queue`. Listeners are followed up to `--depth` levels (default 4); an edge back
  into the current path is marked `cycle`. `explain --event <name>` starts from an event: its
  senders, then its listeners. `--json` prints the graph with `schema: 1`, `--mermaid` a Mermaid
  flowchart. An unknown pipeline or event exits 2 and names close matches.
- `manifest` prints what `describe()` returns for the checked project (modules, contracts,
  pipelines, routes, event triggers, crons, warnings) as tables, or `--json` exactly as `Manifest`,
  with every config variable of a module the sandbox rewrote marked `sandboxed: true`.
- `openapi` boots the sandboxed project without HTTP and writes an OpenAPI 3.1 document to stdout,
  or to `--out` (resolved against the current directory, followed by `wrote <file> (<n> paths)` on
  stderr). Title and version default to the project's `package.json`. A module outside the sandbox
  stops it with exit 2, naming the module, unless `--run-setup` names it, so it never opens the
  project's own database or files. A boot failure exits 1.

**`upgrade`** hands the rest of its arguments unchanged to `@michaelthielemann/kestrel-upgrade`; see
[`upgrading.md`](upgrading.md).

**Host packages.** A project a host package loads in its own shape is inspected through that
package's plugin. The package declares it in its own `package.json`:

```json
"kestrel": { "plugin": "./cli/plugin.mjs", "pluginApi": 4, "engine": "^6.0.0" }
```

The CLI reads this field only from the project's direct `dependencies` and `devDependencies`, as
data, before importing anything. A malformed field, or one whose plugin path leaves its package,
stops every command except `start` with exit 2 naming the package. A plugin built for another
version (`engine` not matching the CLI, `pluginApi` below the engine's minimum) is never run:
`check` reports it as `deps/host-outdated` and exits 1, the other commands exit 2. Two plugins that
both detect the project stop the command, naming both. `--no-plugins` loads no plugin and uses the
built-in loader; an outdated or refused host package still stops the command. `start` never loads a plugin; on a boot failure it names the dependency that
declares one. [`upgrading.md`](upgrading.md) § Registering a plugin has the details.

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `start` | clean shutdown | boot failure, shutdown deadline, fatal error | any argument; project core missing or another major |
| `check` | nothing at or above `--fail-on` | a problem at or above `--fail-on`, `deps/host-outdated` | could not run |
| `explain` | graph printed | — | bad arguments, unknown pipeline or event, could not run |
| `manifest` | printed | — | could not run |
| `openapi` | written | boot failure | bad arguments, a module outside the sandbox, could not run |
| `upgrade` | nothing at or above `--fail-on` | a finding at or above `--fail-on` | could not run, a refused plugin, `fix --write` or `data` with an outdated host package |

"Could not run" means bad arguments, no `kestrel.config.ts` and no plugin that detects the project,
the project's core missing or of another major, a refused plugin, or more than one detecting plugin.

## Checking a boot without starting it

`checkBoot(input, { setup })`, exported from the package root, runs every check `boot()` runs —
config, module order, module config, setup, step registration, pipeline resolution, triggers,
dataflow, hooks, output declarations, attach — and returns every problem as data (`errors`,
`warnings`, `notChecked`) instead of throwing at the first one. `setup` has no default: `"none"`
runs no module code beyond `configSchema`, `"all"` runs every module's `setup()`, and
`{ only: [...] }` names the config `use` entries whose `setup()` may run, since `setup()`,
`attach()` and `teardown()` reach whatever storage a module's config names. Each problem's `code` is
covered by semver from 6.0.0 and a reader must handle one it does not recognize; `reason` and every
message text are not covered and may change in any release.

The result also carries `manifest`, what `describe()` returns for the checked engine (the same
shape as `kestrel.describe()`), taken before the modules are torn down. It is present whenever the
check got as far as resolving the modules, also when problems were found. A module whose `setup()`
did not run contributes no steps, so a pipeline using it is missing from `manifest.pipelines` and
listed in `notChecked`.

### Error codes

Every `BootProblem.code` `boot()` and `checkBoot()` can produce, grouped by what finds it. A future
minor release may add one; code reading `kestrel.warnings` or a `checkBoot()` result must handle a
code it does not recognize rather than assume this list is complete.

| Group | Codes |
|---|---|
| Config | `invalid-config`, `module-count`, `module-listed-twice`, `module-entry-mismatch` |
| Module order | `contract-provided-twice`, `before-and-requires`, `missing-provider`, `provides-itself`, `dependency-cycle`, `module-name-contract` |
| Module setup | `invalid-config-schema`, `invalid-module-config`, `setup-failed`, `instance-locked`, `missing-methods` |
| Step registration | `steps-threw`, `invalid-read-path`, `invalid-write-path`, `step-not-function`, `step-registered-twice`, `step-undescribed`, `describe-shape`, `describe-threw`, `describe-unknown-step` |
| Pipeline resolution | `pipeline-defined-twice`, `pipeline-empty`, `unknown-step`, `step-argument`, `describe-threw`, `atomic-unsafe-step` |
| Triggers | `svg-without-sanitizer`, `invalid-allowlist`, `unknown-trigger-pipeline`, `invalid-trigger`, `duplicate-route` |
| Dataflow | `unsatisfied-read`, `optional-read-order` |
| Hooks | `event-hooks-twice`, `event-hook-missing`, `atomic-scope-twice`, `atomic-scope-missing` |
| Output declarations | `undeclared-output`, `undeclared-required`, `output-fold-contradiction`, `terminal-output-misplaced` |
| Attach | `attach-failed` |
| Loading (`loadConfig`/`loadModule`/`loadPipelineFile`) | `load-failed`, `no-default-export`, `not-a-module`, `not-a-pipeline`, `module-unresolved`, `config-not-object`, `pipelines-not-directory` |

A module's `setup()` that throws is `setup-failed`, naming the module, unless it throws a
`KestrelBootError` of its own: the problem then keeps that error's code, module and reason.
`instance-locked` is one such code: a module that keeps a second process off its database file
throws it from `setup()` through `acquireInstanceLock` (`@michaelthielemann/kestrel/instanceLock`)
when another live process holds the file. The reason names that process's host, PID and start
time, and the module setting that allows several processes on purpose.

Module code that throws while boot registers or resolves steps is reported like any other problem.
A module's `steps()` that throws is `steps-threw`, its `describe()` `describe-threw`, both naming
the module; a pipeline using a step of that module is listed in `notChecked`. A step factory that
throws for a pipeline's argument is `step-argument`, and a factory step's `describe()` that throws
for it `describe-threw`; both name the pipeline, the step and the module that registered it. When
either throws a `KestrelBootError` of its own, the problem keeps that error's code.

`kestrel check` (see Command line above) is the ready-made CI gate built on this. For a gate of
your own, `@michaelthielemann/kestrel-upgrade` (`docs/upgrading.md`) exports `sandboxBootInput()`,
which rewrites a loaded project's storage modules to write into a scratch directory, so
`checkBoot()` can run on a real project without touching it:

```ts
import { checkBoot } from "@michaelthielemann/kestrel";
import { sandboxBootInput } from "@michaelthielemann/kestrel-upgrade/sandbox";

const box = sandboxBootInput(input, { dir: scratchDir });
const result = await checkBoot(box.input, { setup: box.setup });
```

## Logging

The `kestrel` binary logs JSON lines to stdout: one `step` line per step (`runId`, pipeline, step,
duration, outcome) and one `info` line with the message `http` per request. There is no log level or
format setting — an embedded host passes its own `Logger` to `boot({ logger })` instead.

The `http` line has the same fields in the core server and in `kestrel-h3`'s handler (given a
`logger`):

| Field | Value |
|---|---|
| `runId` | The `X-Kestrel-Run-Id` of the response; a refusal has one too, though no run exists for it |
| `requestId` | A valid incoming `X-Request-Id` (printable ASCII, at most 200 characters), echoed in the response; absent otherwise |
| `method`, `path` | The request method and URL path, without the query string |
| `pipeline` | The pipeline the route names; absent when no route matched |
| `status`, `ms`, `ip` | The response status, the time to answer, the client address (see `http`) |
| `reason` | Only on a request answered without running its pipeline, at most 200 characters |
| `declaredBytes` | Only on a 413, 408 or closed connection: the `Content-Length` the request declared |

| Status | `reason` |
|---|---|
| 204 | core server only: `cors preflight` (an `OPTIONS` request with `corsOrigin` set; no `pipeline`) |
| 400 | `invalid path: dot segment` (no `pipeline`, `path` as sent), `invalid body: malformed JSON`, `invalid body: body must be a JSON object`, `invalid multipart body: <cause>` |
| 400 | `invalid body: malformed HTTP framing` (the HTTP parser rejected the request's framing while the body was read; a connection that ends early stays `body not received: connection closed`) |
| 400 | `body not received: connection closed` (the client closed the connection before the body was complete, so no answer reaches it) |
| 403 | core server only: `client not allowed` (outside `http.allow`), `missing trusted client header` |
| 404 | `no route` |
| 408 | `body not received: request timeout` (the server's request timeout, `http.timeouts.requestMs` in the core server, ended the upload; Node answers the 408) |
| 413 | `body exceeds <n> bytes`, `multipart body has more than <n> <parts>` |
| 415 | `unsupported content type`, `this route does not accept multipart/form-data` |
| 500 | `handler failed` (the handler threw; the core server also logs `http handler failed` with the stack) |

`ms` runs from the moment the request's header section has been read and the request handler
starts, so it includes the time the body took to arrive but not the time the header section took.
Node's request timeout counts from the first byte of the request instead, so the `ms` of a 408 line
is at least `http.timeouts.requestMs` minus the time between the request's first byte and the start of
the request handler. A line
holds no body, no cookie, no query string and no header value except a valid `X-Request-Id`
(`requestId`), the declared `Content-Length` (`declaredBytes`) and the client address derived under
the peer policy (`ip`, which may come from `X-Forwarded-For` or the trusted header). The health path
writes no line, and neither does a request Node refuses before the request handler runs (header
section too large, malformed request line, header timeout): it never reaches kestrel, so the proxy's
log is its only record. A refusal starts no run, so it writes no `step` line and
does not reach a run observer such as `insights/default`; its `http` line is its only record. A
request that never reaches kestrel (refused or timed out by a proxy in front of it) is in that
proxy's log only; passing `X-Request-Id` through the proxy and writing it to the proxy's access log
lets both logs be joined on it.
