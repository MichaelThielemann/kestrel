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
| `corsOrigin` | string | – | Single allowed origin; omitted means no CORS headers |
| `maxBodyBytes` | integer | `10485760` | A larger body answers 413 |
| `trustProxy` | boolean | `false` | Read the client address from `X-Forwarded-For` |
| `proxyHops` | integer | `1` | Which `X-Forwarded-For` entry, counted from the right |
| `trustedHeader` | string | – | A platform's client header; its first value wins over `trustProxy` |
| `allow` | string[] | `[]` | IPv4/IPv6 addresses or CIDR ranges; empty means open |
| `healthPath` | string \| `null` | `"/health"` | Answers `{ ok, restartRequired }` from `kestrel.health()` without a pipeline |
| `inlineTypes` | string[] | `[]` | Content types served `inline` beyond the built-in safe set |
| `timeouts.requestMs` | integer | `30000` | `server.requestTimeout` |
| `timeouts.headersMs` | integer | `10000` | `server.headersTimeout` |
| `timeouts.keepAliveMs` | integer | `5000` | `server.keepAliveTimeout` |

`allow` is checked before routing, for health and CORS preflight too; an entry that is neither an
address nor a CIDR range aborts the boot. `image/svg+xml` in `inlineTypes` requires a module that
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

`kestrel` takes no arguments. It loads `kestrel.config.ts`, the modules named in `use` and every
`*.ts` file in `pipelinesDir` (excluding `*.test.ts`), all relative to the current directory, then
boots and starts the triggers. `SIGINT`/`SIGTERM` run the shutdown; it exits 1 when the deadline is
hit, and logs `unhandledRejection`/`uncaughtException` before stopping.

`kestrel-openapi` (package `@michaelthielemann/kestrel-openapi`) boots the same project without
HTTP and writes an OpenAPI 3.1 document:

```
kestrel-openapi --out openapi.json [--title t] [--version v] [--server url] [--mount /api]
```

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

### Error codes

Every `BootProblem.code` `boot()` and `checkBoot()` can produce, grouped by what finds it. A future
minor release may add one; code reading `kestrel.warnings` or a `checkBoot()` result must handle a
code it does not recognize rather than assume this list is complete.

| Group | Codes |
|---|---|
| Config | `invalid-config`, `module-count`, `module-listed-twice`, `module-entry-mismatch` |
| Module order | `contract-provided-twice`, `before-and-requires`, `missing-provider`, `provides-itself`, `dependency-cycle`, `module-name-contract` |
| Module setup | `invalid-module-config`, `setup-failed`, `missing-methods` |
| Step registration | `steps-threw`, `invalid-read-path`, `invalid-write-path`, `step-not-function`, `step-registered-twice`, `step-undescribed`, `describe-shape`, `describe-threw`, `describe-unknown-step` |
| Pipeline resolution | `pipeline-defined-twice`, `pipeline-empty`, `unknown-step`, `step-argument`, `describe-threw`, `atomic-unsafe-step` |
| Triggers | `svg-without-sanitizer`, `invalid-allowlist`, `unknown-trigger-pipeline`, `invalid-trigger`, `duplicate-route` |
| Dataflow | `unsatisfied-read`, `optional-read-order` |
| Hooks | `event-hooks-twice`, `event-hook-missing`, `atomic-scope-twice`, `atomic-scope-missing` |
| Output declarations | `undeclared-output`, `undeclared-required`, `output-fold-contradiction`, `terminal-output-misplaced` |
| Attach | `attach-failed` |
| Loading (`loadConfig`/`loadModule`/`loadPipelineFile`) | `load-failed`, `no-default-export`, `not-a-module`, `not-a-pipeline`, `module-unresolved`, `config-not-object`, `pipelines-not-directory` |

Module code that throws while boot registers or resolves steps is reported like any other problem.
A module's `steps()` that throws is `steps-threw`, its `describe()` `describe-threw`, both naming
the module; a pipeline using a step of that module is listed in `notChecked`. A step factory that
throws for a pipeline's argument is `step-argument`, and a factory step's `describe()` that throws
for it `describe-threw`; both name the pipeline, the step and the module that registered it. When
either throws a `KestrelBootError` of its own, the problem keeps that error's code.

`@michaelthielemann/kestrel-upgrade` (`docs/upgrading.md`) builds on this: its exported
`sandboxBootInput()` rewrites a loaded project's storage modules to write into a scratch directory,
so a CI gate can call `checkBoot()` on a real project without touching it:

```ts
import { checkBoot } from "@michaelthielemann/kestrel";
import { sandboxBootInput } from "@michaelthielemann/kestrel-upgrade/sandbox";

const box = sandboxBootInput(input, { dir: scratchDir });
const result = await checkBoot(box.input, { setup: box.setup });
```

## Logging

The `kestrel` binary logs JSON lines to stdout: one `step` line per step (`runId`, pipeline, step,
duration, outcome) and one `info` line per request. There is no log level or format setting —
an embedded host passes its own `Logger` to `boot({ logger })` instead.
