# Pipelines – Functional Wiring

Pattern: **Pipes and Filters** / middleware chain (like Express, Koa, Hono).
This is where all business logic lives. A pipeline file shows one complete flow.

## Context

Each step receives a `Context` and returns a `Result<Context, KestrelError>`
(details: [Errors as Values](#errors-as-values)). The context is shallow-frozen: fields of
the input object cannot be overwritten (a `TypeError` in strict mode); on success a step
returns either the input object unchanged (`ok(ctx)`) or a copy with changes
(`ok({ ...ctx, result })`). The contents of `payload`, `params`, `headers`, `files`, `result`
are not frozen.

```ts
// @michaelthielemann/kestrel/context
export interface Context {
  readonly runId: string;               // assigned by the runner, never derivable from payload or headers
  requestId?: string;                   // from the X-Request-Id header, if short printable ASCII
  trigger: { kind: "http" | "event" | "cron"; name: string };
  payload: Record<string, unknown>;     // { ...query, ...body } for HTTP, event data, ...
  body: Record<string, unknown>;        // the HTTP body alone (the payload for other triggers)
  query: Record<string, unknown>;       // the HTTP query parameters alone, as strings (empty for other triggers)
  params: Record<string, string>;       // route parameters
  headers: Record<string, string>;      // HTTP headers (lowercased), empty otherwise
  files: UploadedFile[];                // multipart uploads: { field, filename, contentType, data }
  ip?: string;                          // client IP (behind a proxy only with http.trustProxy/trustedHeader; absent when refused)
  result?: unknown;                     // set by the last business step; binaryResult() for downloads
  fail(code: CoreCode, message: string, details?: Record<string, unknown>): Err<KestrelError>;
  fail(error: KestrelError): Err<KestrelError>;   // passes a contract's error through unchanged
  done(result: unknown): Ok<Context>;   // ends the pipeline successfully with result, no step after it runs
}
export type StepResult = Result<Context, KestrelError>;
export type Step = (ctx: Context) => Promise<StepResult>;
export type StepFactory = (arg: string) => Step;
```

A step never returns a bare `Context`, always a `Result` — see
[Errors as Values](#errors-as-values).

The core context knows nothing about identity or tokens. Contracts that need this extend
the context through the global `Kestrel.ContextExtensions` namespace (declaration merging,
like `NodeJS.ProcessEnv`) — so a project with no login never sees these fields:

```ts
// @michaelthielemann/kestrel-contracts/authn.ts
declare global {
  namespace Kestrel {
    interface ContextExtensions { token?: string; identity?: Identity }   // set by authn.requireUser
  }
}
```

## Pipeline File

```ts
// pipelines/createPage.ts
import { definePipeline } from "../modules.ts";   // bound to the step catalogue, see below

export default definePipeline({
  name: "createPage",
  steps: [
    "authn.requireUser",
    "authz.require:pages.write",
    "validate.check:pages.body",
    "validate.sanitize:pages.body",
    "validate.check:pages.body",
    "references.check:pages",
    "content.create:pages",
    "references.index:pages",
    "links.extract:pages",
    "delivery.publish:pages",
    "events.emit:page.created",
  ],
});
```

Steps are strings so they can live in config/JSON, and Kestrel resolves them against the
step registry at boot. An unknown step aborts boot. A step may appear more than once:
`validate.check` comes before `validate.sanitize` (sanitizing needs a schema-conformant
structure) and once more after it, so the stored body is guaranteed schema-conformant.

### Atomic Groups

An entry of `steps` may also be `{ atomic: [...] }`, a run of steps the runner executes inside
one all-or-nothing scope: either every write inside it commits, or none does.

```ts
steps: [
  "authn.requireUser",
  "authz.require:pages.write",
  { atomic: ["references.check:pages", "content.create:pages", "references.index:pages", "links.extract:pages"] },
  "delivery.publish:pages",
  "events.emit:page.created",
],
```

Rules:

- A group must not be empty and must not nest another group; `definePipeline` rejects both at
  the point the pipeline arrives (JSON or code).
- A pipeline may have several groups; each is a separate transaction, run in list order.
- Every step inside a group must declare `atomicSafe: true` in its `describe()` (default
  `false`). It means: the step writes only through the scoped `persistence@1` and has no effect
  outside it, so a rollback undoes everything it did. It reaches nothing else, issues those calls
  from its own async flow (not a queue, timer or worker pool of its own), starts no work it does
  not await and never runs another pipeline. It says nothing about how long the step runs: a step
  whose work grows with a collection, such as `events.purgeDone` or `references.report`, is
  atomic-safe too. Boot rejects a step inside a group that does not declare it, naming the
  pipeline and the step.
- A group holds the store's write lock for its whole duration. On `persistence/sqlite` every call
  made outside the group, reads included, waits in one queue until the group commits or rolls
  back. A call or another group still waiting for the connection after `acquireTimeoutMs` gives up
  with `TRANSIENT` (503) and never runs afterwards. A group still open `scopeTimeoutMs` after its
  `BEGIN` rolls back and answers 503 `TRANSIENT`, which bounds how long a group holds the lock.
  Both budgets are timers enforced when the event loop gets a turn: synchronous SQLite work blocks
  the loop, so a budget that runs out during a statement takes effect once it returns, and neither
  covers SQLite's own busy wait on a lock another connection holds, which `busyTimeoutMs` bounds.
  Group only the steps that must commit together; a step whose work grows with a collection holds
  the lock that long.
- A group needs a module that provides the scope (the `atomicScope` hook on `ModuleDefinition`,
  next to `attach` and `triggers.event`) — in practice the module providing `persistence@1`. Boot
  rejects a grouped pipeline with no such module, and rejects two modules that both provide one.
- `ctx.done()` inside a group **commits**: the work up to that point is intentional, and treating
  an early, successful exit as a rollback would make `done()` mean two different things depending
  on where it is called. It also ends the run right there, so `events.relay` (placed after the
  group) does not run — see "`events.relay`" below for what that means with each delivery module.
- An `Err` or a `throw` inside a group rolls the group back and reports the same outcome the
  client would see outside a group — same status, code, retryable and step. The database is
  simply unchanged in addition.
- A contended or timed-out group answers 503 `TRANSIENT`, which is retryable; the runner never
  retries a group itself, because steps before it (validation, sanitizing) already ran and would
  re-run against a context they already mutated.
- Nothing inside a group can tell it is inside one: no step function, no logging line, no
  observer event and no validation rule changes because of grouping.

### Step Arguments

`name:arg` passes a fixed argument. `authz.require:pages.write` calls the step
`authz.require` with `"pages.write"`. The argument is everything after the first colon; a
step may parse it further, e.g. `content.list:pages?status=published` (type plus a fixed
filter the client cannot override). A step with an argument is a factory in `module.ts`,
marked with `stepFactory()` from `@michaelthielemann/kestrel/context` — that's the only way
the core tells a factory apart from a plain step at boot (both are single-argument
functions). A factory with no argument, or a plain step called with one, fails at boot. If a
step doesn't change the context it returns `ok(ctx)` (the case here); otherwise
`ok({ ...ctx, … })` with the changes — see [Errors as Values](#errors-as-values):

```ts
steps: (authz) => ({
  require: stepFactory((permission: string) => async (ctx) => {
    if (!ctx.identity) return ctx.fail("UNAUTHENTICATED", "not authenticated");
    const can = await authz.can(ctx.identity, permission);
    if (isErr(can)) return ctx.fail(can.error);
    if (!can.value) return ctx.fail("FORBIDDEN", permission);
    return ok(ctx);
  }),
}),
```

## Anonymous and Logged In: One Pipeline

`ctx.identity` means "proven to be logged in" — there is no fake "anonymous" user. Instead,
authz knows the permissions for *nobody*: `anonymous: ["pages.read"]` in the config.
`authz.require:<permission>` lets a request without an identity through if `anonymous` has
that permission, otherwise 401; an identity without the permission gets 403. Ahead of it
sits `authn.identifyUser`, which sets an identity if a valid token is present but never
aborts (`requireUser` enforces login).

```ts
steps: ["authn.identifyUser", "authz.require:pages.read", "content.list:pages?status=published", "authz.fields:pages?shape=list"]
```

### What an Anonymous Caller Receives

The same pipeline serves both callers, so its answer is cut at the end.
`authz.fields:<resource>?shape=<shape>` keeps of `result` only the members the caller may see:
`anonymousFields` in the authz config names them for a caller without an identity and for a
signed-in one without a configured role (`pages: ["id", "slug", "title", …]`), `fields` names them
for a role that should see less than everything, and a signed-in caller one of whose roles has no
such grant keeps the whole answer. The parameter says where the items are: `item` (one document,
also one with an `items` member of its own; boot refuses it on a bare `{ items, total }` answer),
`list` (every element of `items` in `{ items, total }`; `total` stays), `array` (every element),
`file` (bytes, type and name stay; the grant names response headers as `headers.<name>`). Boot
checks that the pipeline's declared output fits it. A path reaches into an item —
`provenance.origin`, `variants[].path` — and a map or a free-form value (`_translations`, a `json`
field) is granted whole.

Boot fails for a pipeline an anonymous caller reaches over HTTP that does not end with the step, for
a resource without an anonymous grant and for a grant naming a field no pipeline declares, so a field
the grant does not name — one a module adds later included — never reaches a visitor. An answer a
step ends the run with before the cut (`resolvePage`'s redirect hit) must be closed and fully granted.

### What a Client Can Rely On

A client never gets the pattern matcher. `authz.describePipelineAccess`, behind
`authn.requireUser`, answers per booted pipeline whether the caller passes its
`authz.require:<perm>` steps: `granted`, `denied`, or `unknown` when the pipeline has no such step.
Rendering a control means checking the pipeline it calls, not hardcoding role names or expanding
patterns client-side.

The instance's configured role names are a separate, narrower fact: `authz.listRoles` writes
`result.roles` (config order). The role table itself is gated like any other admin data — put
`authz.listRoles` behind whatever permission a deployment already uses for user management
(`examples/minimal` uses `authz.require:users.manage`), not behind bare `authn.requireUser`.

Whether a route is public, and what it answers a visitor, is therefore decided by the authz
config, not by a second pipeline.

### Validating Role Names on Write

A user-writing module (such as `authn-multi`'s `createUser`/`updateUser`) does not know the role
table and accepts any role string it is given. `authz.validateRoles:<path>` reads
`payload.<path>`, checks every entry against the configured role names, and fails with 400
`VALIDATION` and the unknown names in `details.unknown` if any entry is not configured; an absent
value passes, since an update may omit roles. Put it in the pipeline after `authz.require:*`,
before the step that writes the roles:

```ts
steps: ["authn.requireUser", "authz.require:users.manage", "authz.validateRoles:roles", "authn.createUser"]
```

A pipeline that omits this step still runs; it simply does not reject an unknown role name.

## Triggers (in `kestrel.config.ts`)

This section covers what a trigger does to a run. Every config key with its type and default is in
`configuration.md`.

```ts
export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data.db" } },
    { use: "@michaelthielemann/kestrel-authn-multi", config: { identifier: "email" } },
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-events-direct", config: {} },
    { use: "./modules/my-authz/module.ts", config: {} },   // local submodule instead of a published package
  ],
  triggers: [
    { http: "POST /login",       pipeline: "login" },
    { http: "POST /pages",       pipeline: "createPage" },
    { http: "GET /pages/:id",    pipeline: "readPage" },
    { event: "page.created",     pipeline: "invalidateCache" },
    { cron: "0 3 * * *",         pipeline: "cleanupSessions" },
  ],
});
```

Routes: `:name` captures one segment, `*name` as the last segment captures the rest of the
path (possibly empty); exact routes win over wildcards, and per segment the order is literal,
`:param`, end of route, `*rest`. A percent-encoded `/` inside a segment never matches, because it
would make the rest of the path indistinguishable from a deeper one. `use` is a package name or a
relative path; the default export must be a `defineModule()`. Only installed or listed
modules are active — Kestrel brings nothing along implicitly.

HTTP, event and cron are equal-standing inputs. An event trigger is served by the module
that supplies the `triggers.event` hook — the one configured delivery module, `events-direct`
(here) or `events-queue`, never the bus module `events-inmemory` itself; if none is present, boot
aborts. Boot also warns (once per trigger, never aborting) when an event trigger names an
event that no pipeline emits through an `events.emit:<name>` step and no module declares in
its `emits` — the symptom of a typo like `auth.logedIn`, whose listener pipeline would
otherwise never run; an event emitted from a contract method instead of a pipeline
(`migrations.applied`) is covered by the module's `emits`. An endpoint has no logic of its
own, it only starts a pipeline with the body as `payload` and the route parameters as
`params`. JSON bodies land in `payload`,
`multipart/form-data` puts text fields in `payload` and files in `files`
(`http.maxBodyBytes`, default 10 MB, otherwise 413: a declared `Content-Length` over the limit is
refused before any byte of the body is read, and a body without one stops being read the moment it
passes the limit). A multipart body is parsed part by part against the one `boundary` parameter of a well-formed
`Content-Type`; a malformed or repeated parameter, a missing boundary or a body that never reaches its
closing delimiter answers 400. The first part past `http.multipart` (`maxParts` 120, `maxFiles` 20,
`maxFields` 100 by default) answers 413 before it is decoded, so the rest of the body is never parsed.
Multipart is accepted only by a route whose pipeline has a step that reads `files`; any other route
answers 415 (`UNSUPPORTED`) to a `multipart/form-data` body without reading it, so a request that
fails authentication later never has its parts parsed. If `ctx.result` is a
`binaryResult(data, contentType, filename?)`, the HTTP trigger responds with the raw bytes
instead of JSON — with `nosniff` and a sandboxed CSP; `inline` only for known image/audio/
video types plus `http.inlineTypes` from the config, otherwise `attachment` (uploads run on
the app origin; SVG is only inline if it was sanitized on upload). The core enforces this:
if `image/svg+xml` is in `http.inlineTypes` without a module registering the step
`sanitize.svg`, boot aborts.

`trigger.name` for HTTP triggers is method plus path relative to the mount (e.g.
`GET /pages`), not the raw `url.pathname` — an instance embedded under
`mountPath: "/api"` sees the same name as a standalone one. Trailing slashes are stripped
in the process: `GET /pages/new/` matches the route `GET /pages/:id`, and a wildcard path
without a trailing slash yields `path: "foo"` instead of `"foo/"`. Repeated query
parameters (`?tag=a&tag=b`) land as `string[]` in the payload (`{ tag: ["a", "b"] }`), a
single value stays a `string` (`{ tag: "a" }`). The core and the h3 adapter parse this
identically. Steps expecting a scalar value get it via `first(value)` from
`@michaelthielemann/kestrel/context` (returns the string, for arrays the first element,
otherwise `undefined`); array-valued headers are discarded — except `cookie`, which
survives as a comma-separated string, which is why cookie auth works.

### HTTP Operation

Every response carries `X-Kestrel-Run-Id` (error responses also in the body),
`X-Content-Type-Options: nosniff` and, by default, `Cache-Control: no-store`. A binary result may
set headers of its own. They add to the mandatory ones and never replace `X-Content-Type-Options`,
`Content-Type`, `Content-Length`, `Content-Disposition` or the sandboxing
`Content-Security-Policy`, which are written last. `Cache-Control` is the one header a binary result
decides itself: when it sets one, that value is sent (`media.serve` marks an original
`immutable`); when it does not, the response stays `no-store`. A step may also leave
`responseHeaders` (a `Record<string, string>`, declared in its `writes`) on the context; the headers
it holds after the last step go out with the response the same way, under the same mandatory ones —
this is how `authn.login` sets the session cookie. A response that needs more than one cookie takes
the further `set-cookie` values from `responseCookies` (a `string[]`, declared in `writes` like
`responseHeaders`), each sent as a header of its own; `ratelimit.rememberDevice` adds the device
cookie this way next to the session cookie. A submitted
`X-Request-Id` shows up as `requestId` in the context, in the `http` log line and again in
the response header. Each request produces one `http` line; its fields and the
refusal reasons are in [`configuration.md`](configuration.md) § Logging. `http.timeouts` sets `requestMs`
(30 s), `headersMs` (10 s) and `keepAliveMs` (5 s) on the server. `http.healthPath` (default
`/health`, `null` disables it) answers without running a pipeline, with `{ ok, restartRequired }`
from `kestrel.health()`: 503 once a module reports `restartRequired`, 200 otherwise.

**Dot segments.** A request target whose path has a `.` or `..` segment, literal or
percent-encoded (`%2e`), with `/` or `\` as separator, answers 400 on the core server and in the h3
adapter. A URL parser would resolve the segment and route a different path than the one the request
named, which a host's own path checks in front of the adapter would not see.

**Client address.** `ctx.ip` (also used in the `http` log line and by `http.allow`) is the socket
peer. Forwarding headers count only when that peer is a trusted proxy: an address in
`http.trustedProxies` (default loopback, `["127.0.0.0/8", "::1"]`). A connection without a peer
address, such as a Unix domain socket or an in-process call, counts as loopback. A request from any
other peer is attributed to the peer itself, whatever headers it sends, so a client that reaches the
port directly cannot choose its own address for `http.allow` or a rate limit. From a trusted proxy,
with `http.trustProxy`, `ctx.ip` is the `X-Forwarded-For` entry `http.proxyHops` (default 1) counted
from the right — the end proxies append to, never the client-supplied left end; a chain shorter than
`proxyHops` yields no address. `http.trustedHeader` (a header the proxy sets to the client address,
e.g. nginx's `proxy_set_header X-Real-IP $remote_addr;` or a platform's trusted-client header) wins
over `trustProxy`: the value the proxy set last is the client, so with `X-Forwarded-For` as the
trusted header it is the rightmost entry. The core server answers `403 forbidden` to a request from a
trusted proxy that lacks the trusted header, with or without `http.allow`; the proxy is expected to
set it on every request. The one exception is a `GET` of `http.healthPath`: a liveness probe from a
load balancer or the platform rarely carries the header, so it is answered and judged by its peer
address against `http.allow`; its body is only `{ ok, restartRequired }`. A request from a peer outside
`trustedProxies` that carries the header the policy reads is attributed to the peer, and the server
logs `forwarding header from <peer> ignored` once per peer and hour, so a proxy missing from the list
shows up in the log (`forwardingWarner` gives a host the same warning). An in-process call counts as
loopback, so forwarding headers it passes on are believed; a host that forwards a client's headers into
such calls should not rely on `ctx.ip` there. `clientIpResolver(options)` compiles the same policy for a
host of its own and reports these cases as `missingHeader` and `forwardingIgnored`.

**IP allowlisting.** `http.allow` (default `[]`, meaning open) restricts the whole server to a list
of IPv4/IPv6 addresses or CIDR ranges, e.g. `["203.0.113.0/24", "2001:db8::/32", "10.0.0.5"]`.
Every request — health check, CORS preflight, or a normal route — is checked against it before
routing. An IPv4-mapped IPv6 peer (`::ffff:10.0.0.5`) counts as IPv4, and an IPv6 zone id
(`fe80::1%eth0`) is stripped first, so both sides compare the same address family. No address, or
one outside the list, answers `403 forbidden` with no further detail; an entry that's neither a
valid address nor a CIDR range stops the boot and names the bad entry.

Rate limits are a step: `ratelimit.check:login` before `authn.login` (module `ratelimit-memory`).
A bucket counted per account can give each device the account signed in from before a budget of its
own (`knownDevices`, with `ratelimit.rememberDevice` after the login), so a third party who blocks the
account for unknown devices does not lock its owner out; the module's README shows the pipeline.

## Runner Behavior (in the core, `runner.ts`)

For every run:

1. Build a new `Context`, assign a `runId` and put it on the context.
2. Run the steps in order. Before every step the body and the query are checked against
   that step's `describe().input` and `describe().query`
   (see [Payload Validation](#payload-validation)); a violation ends the run with
   `VALIDATION` 400 before the step runs.
3. Log per step: `runId`, pipeline, step name, duration in ms, `ok | fail(<code>) | error`;
   every JSON log line starts with `time` (local ISO-8601 time with milliseconds and UTC
   offset). If the run was triggered by another run (an event trigger), that run's id also
   appears as `parentRunId` in every step line.
4. A step returns a `Result<Context, KestrelError>` (no `throw`, no bare `Context`).
   `ctx.fail(...)` returns an `Err` — the run ends immediately, and the result carries the
   status from `STATUS_OF[code]`. `ctx.done(result)` returns an `Ok<Context>`, which ends
   the run immediately with status 200 and `result`. No step after it runs. Details:
   [Errors as Values](#errors-as-values).
5. An unexpected `throw` (a bug, not an expected error message), a step that doesn't
   return a `Result<Context>`, or a step whose writes do not match its declaration
   ([reads/writes](#readswrites)) → status 500, code `INTERNAL`, full stack in the log,
   pipeline and step name in the error text (unchanged: `"<pipeline>/<step>: <message>"`).
6. Every error result carries `code`, `retryable`, `step` (the step it originated in) and —
   if the `KestrelError` has any — `details`; all four appear in the HTTP error body
   (`api.md`).
7. After the run ends: `ctx.result` is returned to the trigger (HTTP response, event
   result).
8. Independently of the logger, every observer registered with `kestrel.observe()` (or through
   a module's `attach` hook) sees `runStart`, `stepStart`, `stepEnd` (duration, status,
   `ok | fail(<code>) | error`) and `runEnd` (duration, status, `ok | fail | error`, code, step,
   message and details of a failure, the client `ip` and the `identityId` known at the end) — the
   source of `insights` stats and of `audit-persistence`'s security entries. A throwing observer is logged and never touches
   the run.

This makes pipelines **traceable** (a log line per step), **testable** (steps are pure
functions, a pipeline can be tested with a fake context) and **measurable** (duration per
step).

## Errors as Values

Expected errors are values, not a `throw`. `@michaelthielemann/kestrel/result` exports
`Result<T, E> = Ok<T> | Err<E>` with `ok`, `err`, `isOk`, `isErr`, `match`, `unwrapOr` — no
`unwrap()` that throws. The call idiom for a contract is two lines:

```ts
const row = await content.get(type, ctx.params.id);
if (isErr(row)) return ctx.fail(row.error);
```

`@michaelthielemann/kestrel/errors` defines the one error model:

```ts
export interface KestrelError<C extends string = string> {
  readonly code: C;
  readonly status: number;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}
```

The core code (`CoreCode`) and the single code-to-status table (`STATUS_OF`) — no other
place in the code maps codes to HTTP status:

| Code | Status | retryable |
|---|---|---|
| `VALIDATION` | 400 | no |
| `DANGLING_REF` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `FORBIDDEN` | 403 | no |
| `NOT_FOUND` | 404 | no |
| `CONFLICT` | 409 | no |
| `PAYLOAD_TOO_LARGE` | 413 | no |
| `UNSUPPORTED` | 415 | no |
| `RATE_LIMITED` | 429 | yes |
| `INTERNAL` | 500 | no |
| `TRANSIENT` | 503 | yes |

`failure(code, message, options?)` builds a `KestrelError<CoreCode>` (the status comes from
`STATUS_OF`); `customFailure(code, status, message, options?)` is for codes a contract
defines itself (the status lives in the contract file, never at the call site) — see
`contracts.md`. A contract may extend the code union with its own string literals (e.g.
`MigrationsCode = "CONFLICT" | "TRANSIENT" | "MIGRATION_FAILED"`).

Inside a step, `ctx.fail` builds the `Err`:

```ts
ctx.fail(code: CoreCode, message: string, details?: Record<string, unknown>): Err<KestrelError>
ctx.fail(error: KestrelError): Err<KestrelError>   // passes a contract's error through unchanged
```

There is no status parameter — the status follows from `code` alone. A step that
needs a different status (e.g. `MIGRATION_FAILED` with 500) passes a ready-made
`KestrelError` from a contract's `helpers/*` error constructor:
`ctx.fail(migrationFailed(message, details))`.
Success is `ok(ctx)` or `ok({ ...ctx, result })`; `ctx.done(result)` remains the only way to
end a pipeline *successfully* ahead of time.

### What may stand in `message`

`message` leaves the process three ways: in the HTTP error body, in the log, and — for a
failed run — in `runEnd.message`, from where `insights` keeps it in its ring buffer of recent
failures and the admin UI shows it. A module author therefore writes only text a logged-in
admin may read: no passwords, tokens, connection strings, API keys or raw rows. Secrets belong
in `logger.error`, never in the error. The runner truncates the message at 500 characters, and
an unexpected `throw` contributes only `"<pipeline>/<step>: unexpected <ErrorName>"` to the
event — the thrown text and the stack stay in the log.

`throw` stays reserved for wiring bugs (a bug, not an expected runtime error message): an
unknown contract type, a step running without a precondition the boot dataflow check was
supposed to guarantee, a step returning something other than a `Result<Context>`. Both
become status 500 with code `INTERNAL`.

## Errors and Side Effects

An atomic group (see [Atomic Groups](#atomic-groups)) changes what "the request failed" means
for the steps inside it, and is deliberately narrow about what it does not cover:

- It guarantees one database: `persistence@1`'s writes inside the group either all commit or
  all roll back. It says nothing about a second system — a blob store, a rendered static
  artefact, an outbound webhook, another process. No `delivery.*` step that renders or writes
  the published output is atomic-safe for exactly this reason: a render plus blob I/O under the process's only write lock is the failure
  the design exists to prevent, not a case it should also cover. A failed publish after a
  committed write leaves the database consistent and the published artefact stale; the existing
  repair path (`delivery.publishAll` / a status read) fixes that independently.
- No step inside a group can call the runner again (start a nested pipeline run). On
  `persistence/sqlite` a nested run's writes would join the same transaction through the ambient
  store, which is almost never intended and is why the rule is enforced structurally: no step
  that may call the runner is `atomicSafe`, so boot rejects it in a group.
- A group is not retried. A contended or timed-out group answers 503 `TRANSIENT`; retrying is
  the client's decision, not the runner's, because steps before the group already ran.

## Step Catalogue

Step names are a type, not a plain string: `ModuleDefinition<Name, Steps>` carries the
module name and step map in its type, `StepsOf<M>` / `StepCatalogue<Modules>`
(`@michaelthielemann/kestrel/catalogue`) build the union of every registered step name from
a module list (factory steps as `` `<prefix>.<step>:${string}` ``), and
`pipelineDefiner<Known>()` binds `definePipeline` to that union:

```ts
// modules.ts
import { pipelineDefiner, type StepCatalogue } from "@michaelthielemann/kestrel";
import contentDefault from "@michaelthielemann/kestrel-content-default";
// … further modules

const modules = [contentDefault /* … */] as const;   // same order as config.modules
export default modules;
export type KnownStep = StepCatalogue<typeof modules>;
export const definePipeline = pipelineDefiner<KnownStep>();
```

Every pipeline file imports `definePipeline` from `../modules.ts` instead of from
`@michaelthielemann/kestrel/definePipeline`:

```ts
// pipelines/createPage.ts
import { definePipeline } from "../modules.ts";

export default definePipeline({ name: "createPage", steps: ["authn.requireUser", "content.create:pages"] });
```

A typo or a step that wasn't loaded is then a `tsc` error instead of a boot error:

```
pipelines/createPage.ts:5:12 - error TS2322: Type '"authn.requireUsr"' is not assignable to type
  '"authn.login" | "authn.identifyUser" | "authn.requireUser" | … 90 more …'.
```

The part after the `:` stays a boot check (`` `content.get:${string}` `` type-checks for
any string), as do duplicates and `describe()` names that don't reference a step.

## `reads`/`writes`

Every step declares in `describe()` what it reads from and writes to the context —
mandatory fields, may be `[]`:

```ts
export interface StepDescription {
  summary: string;
  reads: readonly ContextPath[];
  writes: readonly ContextPath[];
  // … input?, output?, extendsOutput?, extendsItems?, query?, errors?, security?, multipart?, binary?
}
```

A `ContextPath` is a context key, optionally followed by dotted sub-keys
(`^[a-zA-Z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)*\??$`); a trailing `?` is allowed in both `reads` and
`writes`. In `writes` it means "may write" (`authn.identifyUser` writes `identity?`) — an optional
write never satisfies a read. In `reads` it means "may be absent"
(`revisions.reportRestore` reads `restoreReport?`) — an optional read does not need an earlier step,
or the trigger, to supply the key. A read on `a.b` is satisfied if an earlier step wrote `a.b` or
`a`; a read on `a` is satisfied if an earlier step wrote `a` or any `a.x`. A `result` write with no
sub-key replaces the whole object, and with it every previously written `result.<key>`.
`payload.*` reads are never checked (the client owns the payload; [Payload
Validation](#payload-validation) checks it against `describe().input`/`query` instead).

After resolving each pipeline, boot runs a dataflow check (`checkDataflow`, from
`@michaelthielemann/kestrel`): for every step in order, each field it reads must already
have been written by an earlier step, or boot aborts with a `KestrelBootError` naming the pipeline,
step, path, and the writes seen so far. An optional read is exempt from that rule, but not from
ordering: if no earlier step supplies the key but a *later* step in the same pipeline writes it
(with or without `?`), boot aborts, naming the pipeline, the reading step, the writing step and the
key — the read would silently see nothing on every run, which is what an unordered pair of steps
almost always means, not what "optional" is for. A key nothing in the pipeline ever writes is fine;
the step is expected to run stand-alone as often as chained. If no step of *any* booted pipeline
ever writes the key and no trigger provides it either, `boot()` adds an `unwritten-optional-read`
entry to `kestrel.warnings` naming the pipeline, the step and the key — almost always a typo, since
a step genuinely meant to run stand-alone still names a key some other pipeline populates. Once a
step passes the check, its `writes` are applied.

What's available from the start: `payload`, `headers`, `files`, `ip`, `params`, plus `params.<p>`
for every route parameter that all of the pipeline's HTTP routes bind. Under an event trigger, any
`params.<p>` read counts as satisfied, since the envelope can carry arbitrary params. In a pure
cron pipeline, or when no HTTP route binds a given parameter, that read is never satisfied —
except in a pipeline with no trigger at all (reachable only via a direct `run()` call, as in a
test), where the caller supplies the params itself.

This is why a step never needs a defensive fallback for context it declared: `delivery.publish:<type>`
declares `reads: ["result.id"]`, boot has already proven every pipeline supplies it, so a leftover
`if (typeof id !== "string") throw …` would only ever catch a bug, never a real gap.

The runner holds a step to that declaration at run time, in every environment (like the
payload validation). After a step returned `Ok<Context>` it compares the context it passed in
with the one it got back, key by key (`Object.keys`, `!Object.is`, no deep comparison):

- A top-level key whose value changed must be the root of a declared `writes` path (with or
  without `?`), otherwise the run ends as `500 INTERNAL` with
  `step "<name>" writes "<key>" without declaring it`.
- Every declared path without `?` must exist afterwards, walked segment by segment
  (`Object.hasOwn`; a `null` or `undefined` value counts as written as long as the property is
  there), otherwise `step "<name>" declares writes "<path>" but did not write it (declare
  "<path>?" for a conditional write)`.

Both are wiring errors, not client errors: the stack is logged, the step name is in the error
object, and observers see `stepEnd` with status 500, outcome `error`. A step that writes only
on some paths (`validate.sanitize` when the field is absent, `redirects.lookup` when nothing
matches) declares the `?` form; a step that replaces `ctx.result` wholesale declares `result`.

## Payload Validation

Every step declares the input it reads in `describe()`: `input` is a JSON Schema for the
request body (`ctx.body`), `query` a map of query-parameter name → JSON Schema (`ctx.query`).
The runner checks both before the step runs, in every environment, so a request that does not
match the step's own declaration never reaches the step:

- The body is validated against `input` as it is. Body schemas state `additionalProperties`
  explicitly; `false` is the rule, `true` only for steps that deliberately accept open objects
  (a consumer document in `persistence.createOne`, the field a consumer JSON schema governs in
  `validate.check`). Body values are never converted.
- Query parameters arrive as strings (repeated keys as string arrays). For the check the runner
  builds a coerced copy of the declared keys only: `"10"` → `10` for `integer`/`number`,
  `"true"`/`"false"` → boolean, a single string → `[string]` for an `array`; text that does not
  convert stays a string and fails the declared type. Undeclared query parameters are ignored
  (cache busters, tooling). The context is not touched: steps keep reading strings through
  `first()` and their own parsers.
- A violation is a client error: `ctx.fail("VALIDATION", "<step>: payload does not match
  schema (…)", { problems })` with `details.problems: [{ path: "$.field", message }]`, `step`
  set, log outcome `fail(VALIDATION)`. Because the check runs per step, it happens after
  `authn.requireUser` and `authz.require:*`: an anonymous client still gets 401, not 400.
- Semantic validation stays with the modules (`content@1` `validate()`: unknown fields,
  uniqueness, references; `authn` `credentials()`): the schema catches shape and type, the
  module catches meaning.

The validator is `@michaelthielemann/kestrel/schema` (`validateSchema(schema, value)`,
`coerceQuery(query, values)`), not ajv: it covers the JSON Schema keywords the shipped
`describe()` blocks use (`type` including `"integer"` and the array form, `properties`,
`required`, `additionalProperties`, `items`, `enum`, `const`, `oneOf`, `anyOf`, `pattern`,
`minimum`, `maximum`, `minLength`, `maxLength`, `minItems`; `format` is ignored) and every
keyword has a positive and a negative test.

Two checks keep the declarations honest: a static test in the core's suite parses every
`packages/*/module.ts` and fails when a step whose handler (or a helper it calls) reads
`ctx.payload` has neither `input` nor `query`, or when a literal object `input` leaves
`additionalProperties` unstated; and every module with steps has a `module.test.ts` that runs
each step once through `testing/runPipeline` with `modules: [{ module, instance }]`, so the
real schemas apply to a representative payload.

## Output Validation

A step whose `writes` touches `result` declares the shape of what it produces: `output` (a JSON
Schema, replacing whatever the pipeline's result schema was so far), `extendsOutput` (merges into
it — becomes the output if there was none yet), `extendsItems` (merges into
`properties.items.items` of a list output, or at the root otherwise), `binary: true` for a step
whose result is a binary body rather than JSON (`media.download`, `images.serve`), or — only when
the step's sole `result` write is optional (`result?`) — `terminalOutput` alone (see below). A step
that writes `result` with none of these fails `boot()`, naming the pipeline and the step
(`"step writes result without declaring output, extendsOutput, extendsItems or binary: true
(terminalOutput alone only covers an optional "result?" write)"`).

An object schema inside `output`, `extendsOutput` or `extendsItems` — the schema itself, a nested
property, an array's `items`, an object-valued `additionalProperties` or a `oneOf`/`anyOf`/`allOf`
branch — that declares `properties` without a `required` key fails `boot()`, naming the pipeline,
the step and the JSON path of the offending schema (`"output schema at $.output… declares
properties without declaring required"`). `required: []` is a schema's explicit statement that
none of its properties are guaranteed; it satisfies the check like any other `required` array.

`extendsOutput` merges into an active object schema, or into every branch of a `oneOf`/`anyOf` (the
keyword itself is kept); `extendsItems` merges into `properties.items.items` of a list-shaped
schema, or at the root of a non-list object schema, and onto a union applies whichever of the two
to each branch. Anything else — another `type`, a type array, an `allOf` schema, a schema without a
declared `type`, a union with a non-object branch, a union with no list-shaped branch for
`extendsItems`, or an extension that is not itself an object schema — fails `boot()`, naming the
pipeline, the step, which keyword it used, the reason, and the earlier step that set the active
schema when there was one (`"step "<s>"'s extendsOutput cannot fold onto the active output schema:
type "<t>", not "object" (set by step "<earlier>")"`).

`@michaelthielemann/kestrel/schema` folds a pipeline's step descriptions, in order, into the
schema its result ends up matching (`resolveOutputSchema`, from the `schema` subpath) — this is
what `kestrel openapi` uses for a route's response schema. Passing `validateOutput: true` to
`boot()` (off by default) applies the same fold at runtime: after every step that writes `result`
— except a step whose write is declared optional (`result?`) and left `ctx.result` unchanged —
it validates the result against the schema folded up to that point and fails the run naming the
step and the JSON path, the way a `writes` mismatch already does. `testing/runPipeline` always
validates this way, so a module's own tests catch a mismatch before it ships; turn the same check
on in a running deployment by passing `validateOutput: true` to `boot()`.

A step that may end the run with `ctx.done()` declares the complete shape of that result as
`terminalOutput`, never folded with any other step's `output`, `extendsOutput` or `extendsItems`
and never applied to a run that continues past the step. `resolveResultSchema` (also from the
`schema` subpath) reports every shape a successful run can end in: the fold above, then each
step's distinct `terminalOutput`, as one `anyOf` — this is what `kestrel openapi` publishes as a
route's 200 when a pipeline can end more than one way, for example `redirects.lookup`'s
`{ redirect: { to, status } }` next to the page a resolver otherwise returns. A `ctx.done()` at a
step without `terminalOutput` fails the run with `INTERNAL` in every mode, so no early answer is
ever undeclared. Under `validateOutput`, a `ctx.done()` whose result does not match its
`terminalOutput` fails the run naming the step, and a step that declares only `terminalOutput` (no
`output`) but changes `result` without calling `ctx.done()` fails as well. **Boot cannot see a
`ctx.done()` call; a missing `terminalOutput` is found at run time and by
`kestrel upgrade`'s source scan, a wrong one only under `validateOutput`.** Boot does reject `terminalOutput` on a step
with no write to `result`, and `terminalOutput` together with a `binary` step in the same pipeline.

These checks, like the dataflow check above, run after every module's `setup()` has already
run, so a boot that fails on one of them can still leave behind what `setup()` created — a database
file, a migration, a seeded user.

## Pipeline Test

```ts
// pipelines/createPage.test.ts
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import createPage from "./createPage";

it("rejects without identity", async () => {
  const res = await runPipeline(createPage, { payload: { title: "x" } }, { steps: fakeSteps });
  expect(res.status).toBe(401);
  expect(res.code).toBe("UNAUTHENTICATED");
});
```

`fakeSteps` is a step registry of stand-ins, no database needed. A stand-in is registered with
`writes: ["result?"]`, so it may set `ctx.result` or leave the context alone; one that seeds
another key (an identity, a param) declares it through `writes: { "<module>.<step>": ["identity"] }`
next to `steps`, since the runner checks every step against its declaration. To run a module's
real steps with their `describe()` schemas, pass `modules: [{ module, instance }]` (the instance
from `module.setup(...)` against fakes) instead of or next to `steps`.

## Vocabulary

A developer should never have to guess what something is called.

| What | Form | Example |
|---|---|---|
| Contract | Noun, `@major` | `persistence@1` |
| Step | `<contract>.<verb>[Object][:arg]`, camelCase. Object only if the verb alone would be ambiguous. | `authn.login`, `authn.requireUser`, `persistence.createOne:pages` |
| Pipeline | Imperative, camelCase, globally unique | `login`, `createPage` |
| Event | Fact in the past tense, `<subject>.<participle>` | `auth.loggedIn`, `page.created` |
| Collection | Plural noun, snake_case with a module prefix when a submodule owns it | `pages`, `authn_sessions`, `audit_entries` |

Even a pure read is a verb: `read<Thing>` for a single object, `list<Things>` for a
collection — never a noun-like step name such as `status` or `sizes`. Collections are
prefixed with the module segment (`delivery_`, `images_`, `media_`, …), even when the
segment differs from the word in the collection name (`delivery-static` creates
`delivery_publish_status`, not `publish_status`).

Events are facts, not hooks. There is no "before X": whoever wants to check or intervene
before an action writes a *step* ahead of it in the pipeline. Events can't prevent
anything.

Steps are named after the *contract*, not the submodule: `authn/single` and `authn/multi`
both register `authn.login`. Pipelines say *what*, config says *with what*. Swapping a
submodule changes no pipeline.

## Pipelines Live Only in `pipelines/`

Submodules supply steps, not pipelines. A submodule's README may recommend what a typical
flow looks like; the consumer creates the file for it themselves. That way there is exactly
one place to read any flow in full, and no naming collisions between submodules.

## Event Data

`events.emit:<name>` sends `{ eventId, event, at, runId, identity, params, id, ip }` for the
running pipeline; `ip` is the client address of the run, `null` for a cron or event run. `eventId` is a fresh UUID per emit (a dedup key for consumers like
`audit.record`), `runId` is the id of the triggering run; the pipeline started by the event
receives it as `parentRunId` and logs it in every step line. Cron runs have no parent. The
raw `payload` (request body) is never passed on, and `result` is absent by default — the
event payload therefore doesn't depend on `ctx.result`, nor on which steps (e.g.
`delivery.publish`) ran before it. `id` is derived from `ctx.result.id` →
`ctx.result.document.id` → `ctx.params.id` → `null`. If `ctx.result` additionally carries
`ids: string[]` (e.g. a bulk upload of several files), that appears as `ids` in the
envelope too — `id` then stays `null`, since no single document is meant. `identity` is the
resolved identity (`{ id, claims }`), never a token or session secret. A pipeline started by
an event receives this data as its `payload`.

| Event | `id` is |
|---|---|
| `auth.loggedIn` / `auth.loggedOut` | user id |
| `page.created` / `page.updated` / `page.deleted` / `page.restored` | document id |
| `media.uploaded` / `media.updated` / `media.deleted` | document id (for a bulk upload of several files: `null`, plus `ids: string[]` — the newly stored items only; after a folder delete or `media.purge`: `null`, plus the `ids` deleted, which may be empty when every selected item was skipped) |
| `media.trashed` / `media.restored` | `null`, plus `ids: string[]`: every requested id that is trashed (`media.trash`) or ready (`media.restore`) after the step, including those that already were (`unchanged`), and for `media.trashFolder` every item of the subtree in the trash afterwards; never the skipped ones. A repeated request therefore raises the event again for the same ids, so a subscriber that records each move compares with what it recorded. A pipeline that marks the pages showing a medium subscribes to both, as it does to `media.deleted` |
| `user.created` / `user.updated` / `user.deactivated` / `user.deleted` | document id |
| `images.variantsChanged` | `null`, plus `ids: string[]` (the items whose variants changed, at most 200 per event), with `identity: null` and `params: {}`. Raised by `images-default` itself through `events@1` whenever what a page shows of an item's variants changed: it placed an item (made it `available`), or a size-set change or `images.prune` touched it. That happens in its background job or sync, outside any pipeline, so no `events.emit` step could raise it; the module declares it in `emits`. It is not `media.updated`: that name belongs to the pipeline that edits a medium. A pipeline that marks the pages showing a medium subscribes to both |
| `migrations.applied` | – (no envelope: the `migrations/default` module sends its own `{ migrations: [id], documents }` after a run; deliberately no `page.updated` per document it migrated). Raised by `migrations-default` itself through `events@1`, an exception to the rule that submodules provide steps and emit nothing themselves (`architecture.md` § The five rules): `apply()` is a contract method that also runs at boot, and after a partial failure the event still has to cover the migrations already applied — an `events.emit` step after a failing `migrations.apply` would never run. The module declares it as `emits: ["migrations.applied"]`, so a trigger on it boots without the warning above |
| `delivery.outputStale` | – (no envelope: `delivery-static` sends its own `{ type, docId, locale, coalesceKey }`, the output to re-render and its status id as the coalescing key). Raised by `delivery-static` itself through `events@1` with `dependencies.render: "events"`, once per output that `delivery.markDependents:<type>` or `delivery.resumeStale` marked: one step marks any number of outputs, and each needs a job of its own, which an `events.emit` step (one event per run) cannot express. The module declares it in `emits`; boot fails unless a trigger runs a pipeline with `delivery.republishOutput` on it |
| `delivery.llmsStale` | – (no envelope: `delivery-static` sends its own `{ coalesceKey: "llms" }`). Raised by `delivery-static` itself through `events@1` with `dependencies.render: "events"`, from `delivery.requestLlms` and after a re-render by `delivery.republishOutput`, so `llms.txt` is exported once after a run of re-renders instead of inside each; the re-render path runs in a job, not in a pipeline that could end in an `events.emit` step. The module declares it in `emits`; boot fails unless a trigger runs a pipeline with `delivery.exportLlms` on it |

Whatever the bus delivers is a shallowly frozen copy of the emitted data, like the context between
steps: a handler cannot change what the next handler sees, and assigning to the object throws in
the handler (which `emit` reports in its `AggregateError`). Nested objects are shared, not frozen.

A step that changed nothing can keep the emit from happening at all: `ctx.done(result)` ends the
pipeline successfully right there, so no later step runs — including `events.emit`. `media.upload`
uses this for an idempotent re-upload (same folder, same filename, same bytes): it answers 200 with
the item that was already stored and no `media.uploaded` goes out, so nothing regenerates variants
for a file that did not change. The alternative — emitting anyway and asking every listener to
recognise the repeat — would spread one module's knowledge across all of them. A step that suppresses
an event this way says so in its `describe().summary`, because the pipeline file does not show it,
and declares the shape of that early result as `terminalOutput` (see "Output Validation" above).

`events.emit:<name>?with=result` additionally adds `result: ctx.result` unchanged (a
deliberate opt-in, not the default). **Careful:** the shape of `result` then depends on the
steps that ran before `events.emit` in the triggering pipeline (e.g. `delivery.publish`
merges `_delivery` into it) — an event pipeline that consumes `with=result` is coupled to
that pipeline's step order and can vary per consumer configuration.

`events-inmemory` is the `events@1` bus and nothing else: it registers no step and delivers
nothing. Every instance additionally configures exactly one **delivery** module, `events-direct`
or `events-queue`, which owns `events.emit` and the event trigger hook.

With `events-direct`, `emit` is synchronous: the step calls the bus, the triggering pipeline waits
for every listener pipeline, and the HTTP response only goes out afterward. A listener pipeline
that ends with a failure status, or a programmatic `events.on` handler that throws, makes the
`events.emit` step itself answer 500 `INTERNAL` with the failure as `cause`; long-running work
belongs in a job the listener starts (like `images.sync`). The event trigger hook subscribes
listener pipelines to the bus only once `start()` runs, so an event raised through `events@1`
during another module's own `setup()` (for example `migrations.applied`) reaches a programmatic
bus subscriber but runs no pipeline — the same as with the bus alone.

With `events-queue` instead (same steps and envelope), `emit` writes one row per pipeline
subscribed to the event directly to the `events_queue` collection of `persistence@1` and returns
immediately, without touching the bus; the HTTP response goes out before any listener runs. A
programmatic bus subscriber therefore sees only events raised through `events@1` by a module (for
example `migrations.applied`), never an event a pipeline step emitted.

A worker in the same process claims due rows every `pollMs` and runs the pipeline named on each
row. If that run ends with a failure status, that row's attempt failed: it is requeued after
`backoffSeconds[attempt - 1]`, and after `maxAttempts` it moves to the dead-letter state (managed
via the admin steps `events.readQueueStatus`, `events.listDead`, `events.retryDead:all|one`,
`events.purgeDone`; each dead-letter entry names its `pipeline`). A row stuck at `running` because
its process crashed is picked up again after `lockTtlSeconds`. **No ordering is guaranteed between
the pipelines subscribed to one event:** each is its own row, claimed and retried independently.

**With either delivery module, the pipelines subscribed to one event are independent of each
other; work that must happen in sequence belongs in one pipeline.** `events-direct` happens to run
them one at a time, in registration order, and isolates a throwing one from the rest — that is an
implementation property of today's inline delivery, not a guarantee to build on.

### `events.relay`

Both delivery modules also register `events.relay`, placed as its own entry immediately after a
pipeline's last `events.emit:` — after the `COMMIT` when that emit sits inside an atomic group,
since the step is not `atomicSafe` and boot rejects it inside one. It adds `_events: { status:
"done" | "error" | "pending", pipelines: [{ event, pipeline, status, attempts, dead, error }] }` to
the result, one entry per pipeline the run's own emits raised (an entry's own `status` also takes
`"queued"` with `events-queue`, see below); a run whose emits had no subscriber reports `{ status:
"done", pipelines: [] }`. The summary status is `"error"` if any entry is `"error"`, else
`"pending"` if any entry is `"pending"` or `"queued"`, else `"done"`. `events.relay` always answers
`ok`: a failed delivery is reported in `_events`, never turned into a failure of the run that raised
it. When `ctx.result` is `undefined` the relay creates an object for it; a defined non-object result
(an array, for example) is left untouched, with one `warn` logged, since there is nothing to merge
into.

With `events-direct`, the subscribed pipelines have already run inline, during `events.emit`; the
relay only reports what the wrapper saw (`status`/`attempts`/`dead` are always `1`/`true` on an
error, since nothing here retries). With `events-queue`, the relay **delivers**: it claims this
run's own rows by id — the ones `events.emit` just wrote — and runs each one through the exact
`attempts`/backoff/dead-letter machinery the worker uses, before the response goes out. Whatever it
does not reach within the config key `relayMs` (default 5000 ms, checked before every claim
including the first, never enforced mid-pipeline) is reported `"pending"` and stays for the worker,
which takes it once its row's `availableAt` (`createdAt + relayMs` for a row belonging to a run)
comes due — the head start that keeps a live worker from racing the relay for the same row.
`relayMs: 0` disables the relay entirely: every row is immediately the worker's. A run that
enqueued nothing costs the relay no persistence query.

`events-queue`'s config key `relayPipelines` narrows which subscribed pipelines the relay is
allowed to claim: an array of pipeline names, or `"all"` (the default, the behaviour described
above for every subscribed pipeline). A row of a pipeline left out of the list is written with
`availableAt = createdAt` instead of getting the head start, and the relay never claims it by id —
it is the worker's from the moment the response goes out, immediately available rather than waiting
`relayMs`. `_events.pipelines` still names it, with `status: "queued"`, so a client can see that
delivery is still pending without the relay having attempted it. This is the setting for a
subscriber whose work is too heavy for the request (rendering image variants on upload, writing a
login audit) while another subscriber of the same event still gets its head start (publishing the
page). Naming a pipeline unknown to the booted manifest, or one no event trigger runs, fails boot
at `attach()`, once every pipeline is resolved, naming the module, the pipeline(s) and which of the
two it is.

A relayed delivery is an ordinary run: it carries `parentRunId`, so it appears in the logs and in
insights' recent failures linked to the request that raised it, and a delivery pipeline that hangs
hangs the request — exactly as an inline `delivery.publish` does today. `ctx.done()` before the
relay (see below) skips it: with `events-queue` the rows stay `pending` for the worker and the
response has no `_events` member; with `events-direct` the pipelines have already run and only the
report is lost.

Guarantees: at-least-once delivery, no ordering across events — so a listener pipeline must be
idempotent (the envelope's `eventId` is the dedup key, guaranteed present on every delivered event
including one raised through `events@1` directly). If persistence itself fails on write, the
`events.emit` step fails with 503 `TRANSIENT` rather than silently dropping the event. Payload
rules are unchanged: no tokens (only `identity`), a frozen shallow copy per handler.

### `events.readDeliveryStatus`

Both delivery modules also register `events.readDeliveryStatus`, one portable step with one shared
shape: `{ dead, scope, since, lastDeadAt }`. It answers the deliveries the module gave up on —
"dead" reuses the vocabulary `events.relay`'s `dead` already has — but what each field means depends
on the module, named by `scope`. `events-queue` answers `scope: "store"`: `dead` is the dead-letter
count across every process, the same number `events.readQueueStatus.dead` already carries, lowered
by `events.retryDead`; `since` is always `null`. `events-direct` answers `scope: "process"`: `dead`
counts the failed deliveries of the process that answers, since it started at `since` — another
process of the same site keeps its own count, and a restart starts at 0, because nothing here
retries and every failure is final at once. Neither number is a readiness or liveness signal:
`kestrel.health()` never reads it, so neither does `http.healthPath` or a host's own readiness
probe, and a module never puts it in its own `health()` hook. A consumer wires one route to it — the step and its shape are identical across
both delivery modules, so the route works whichever one is configured.

## Replaying a Stored Payload

A flow that has to save something the system stored earlier — restoring a revision, replaying an
import — does not get a second write path. One step puts the stored fields into `body` and
`payload` (declaring both in its `writes`), and behind it stands the ordinary write chain:

```ts
steps: ["authn.requireUser", "authz.require:pages.write", "revisions.restore:pages",
        "validate.check:pages.body", "validate.sanitize:pages.body", "validate.check:pages.body",
        "references.check:pages", "content.update:pages", "revisions.record:pages",
        "references.index:pages", "links.extract:pages", "delivery.publish:pages",
        "delivery.exportLlms", "revisions.reportRestore", "events.emit:page.restored"]
```

Everything between the third step and `revisions.reportRestore` is `updatePage` verbatim. Old
content therefore passes the same validation, sanitizing, reference check and delivery as a
hand-typed edit, the schema check the runner performs per step applies to it (which is why `body` is
written, not only `payload`), and a change to the write flow cannot be forgotten in the replay. A
step that needs to tell a later step *how* the payload came about puts that on the context, not in
the payload: `revisions.restore` writes `revisionParent`, and `revisions.record` optionally reads it
(`revisionParent?`) to hang the new revision off the restored one instead of off the head, since a
plain save never restores anything and never sets it. The same channel carries what the replay had
to leave out — `restoreReport` — which `revisions.reportRestore` optionally reads (`restoreReport?`)
and adds to the finished result, last because only there is the response shape settled.

## Rules

- No branching in the step list. If a flow needs an "if", that's two pipelines or a step
  that uses `fail`.
- A step does one thing. There is no `validateAndSave`.
- Pipelines import nothing from `modules/`. Only step names as strings.
- Zero trust: every input is validated on the backend (type, shape, allowlist, otherwise
  400). HTML-capable fields additionally get allowlist sanitizing (`validate.sanitize`,
  `validate.sanitizeHtml`, `sanitize.svg`); plain-text fields are only validated — length,
  no control characters — and escaped on output, since sanitizing would corrupt legitimate
  text like `5 < 6`. The frontend also escapes; the backend never relies on that alone.
