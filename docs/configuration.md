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
the module. Modules are set up in the listed order after a topological sort by their `requires`, so
a provider always runs before its consumers. Relative paths inside a module's config resolve
against `deps.root`, the directory of the loaded config file.

## `triggers`

Three forms, all equal-standing inputs to the same runner:

```ts
{ http: "GET /pages/:id",  pipeline: "readPage" }
{ event: "page.created",   pipeline: "invalidateCache" }
{ cron: "0 3 * * *",       pipeline: "cleanupSessions" }
```

- **http** — `<METHOD> <path>` with `GET|POST|PUT|PATCH|DELETE`. `:name` captures one segment,
  `*name` as the last segment captures the rest of the path; exact routes beat wildcards. Route
  parameters arrive as `ctx.params`.
- **event** — needs a module providing the event trigger hook (`events-inmemory` or
  `events-queue`); without one, configured event triggers abort the boot. An event that nothing
  emits is a boot warning, not an error.
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
| `healthPath` | string \| `null` | `"/health"` | Answers `{ ok, uptimeSeconds }` without a pipeline |
| `inlineTypes` | string[] | `[]` | Content types served `inline` beyond the built-in safe set |
| `timeouts.requestMs` | integer | `30000` | `server.requestTimeout` |
| `timeouts.headersMs` | integer | `10000` | `server.headersTimeout` |
| `timeouts.keepAliveMs` | integer | `5000` | `server.keepAliveTimeout` |

`allow` is checked before routing, for health and CORS preflight too; an entry that is neither an
address nor a CIDR range aborts the boot. `image/svg+xml` in `inlineTypes` requires a module that
registers the step `sanitize.svg`, otherwise the boot aborts.

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

## Logging

The `kestrel` binary logs JSON lines to stdout: one `step` line per step (`runId`, pipeline, step,
duration, outcome) and one `info` line per request. There is no log level or format setting —
an embedded host passes its own `Logger` to `boot({ logger })` instead.
