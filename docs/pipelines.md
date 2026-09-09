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
steps: ["authn.identifyUser", "authz.require:pages.read", "content.list:pages?status=published"]
```

Whether a route is public is therefore decided by the authz config, not by a second
pipeline.

## Triggers (in `kestrel.config.ts`)

```ts
export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data.db" } },
    { use: "@michaelthielemann/kestrel-authn-multi", config: { identifier: "email" } },
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
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
path (possibly empty); exact routes win over wildcards. `use` is a package name or a
relative path; the default export must be a `defineModule()`. Only installed or listed
modules are active — Kestrel brings nothing along implicitly.

HTTP, event and cron are equal-standing inputs. An event trigger is served by the module
that supplies the `triggers.event` hook (here `events-inmemory`); if none is present, boot
aborts. An endpoint has no logic of its own, it only starts a pipeline with the body as
`payload` and the route parameters as `params`. JSON bodies land in `payload`,
`multipart/form-data` puts text fields in `payload` and files in `files`
(`http.maxBodyBytes`, default 10 MB, otherwise 413). If `ctx.result` is a
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
`X-Content-Type-Options: nosniff` and `Cache-Control: no-store`. A submitted
`X-Request-Id` shows up as `requestId` in the context, in the `http` log line and again in
the response header. Each request produces one `http` log line with method, path, pipeline,
status, duration, IP and — if present — `requestId`. `http.timeouts` sets `requestMs`
(30 s), `headersMs` (10 s) and `keepAliveMs` (5 s) on the server. `http.healthPath` (default
`/health`, `null` disables it) answers without running a pipeline, with
`{ ok, uptimeSeconds }`. The client address (`ctx.ip`, the `http` log line, `http.allow`) is the
socket peer unless a proxy sits in front: with `http.trustProxy` it is the `X-Forwarded-For` entry
`http.proxyHops` (default 1) counted from the **right** — the end the proxies append to; the left
end is whatever the client sent and is never used — and a chain shorter than `proxyHops` yields no
address at all. `http.trustedHeader` (e.g. a platform's trusted-client header) wins over both: its
first value is the client, a missing header yields no address. `http.allow` (default `[]` = open)
restricts the whole server to a list of IPv4/IPv6 addresses or CIDR ranges
(`["203.0.113.0/24", "2001:db8::/32", "10.0.0.5"]`): every request — health, CORS preflight and
routes alike — is checked before routing against that client address, an IPv4-mapped IPv6 peer
(`::ffff:10.0.0.5`) counts as IPv4, no address or one outside the list answers `403 forbidden`
without details; an entry that is neither an address nor a CIDR range stops the boot naming the
entry. Rate limits are a step:
`ratelimit.check:login` before `authn.login` (module `ratelimit-memory`).

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
5. An unexpected `throw` (a bug, not an expected error message) or a step that doesn't
   return a `Result<Context>` → status 500, code `INTERNAL`, full stack in the log,
   pipeline and step name in the error text (unchanged: `"<pipeline>/<step>: <message>"`).
6. Every error result carries `code`, `retryable`, `step` (the step it originated in) and —
   if the `KestrelError` has any — `details`; all four appear in the HTTP error body
   (`api.md`).
7. After the run ends: `ctx.result` is returned to the trigger (HTTP response, event
   result).

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

There is no status parameter anymore — the status follows from `code` alone. A step that
needs a different status (e.g. `MIGRATION_FAILED` with 500) passes a ready-made
`KestrelError` from its contract file: `ctx.fail(migrationFailed(message, details))`.
Success is `ok(ctx)` or `ok({ ...ctx, result })`; `ctx.done(result)` remains the only way to
end a pipeline *successfully* ahead of time.

`throw` stays reserved for wiring bugs (a bug, not an expected runtime error message): an
unknown contract type, a step running without a precondition the boot dataflow check was
supposed to guarantee, a step returning something other than a `Result<Context>`. Both
become status 500 with code `INTERNAL`.

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
(`^[a-zA-Z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)*\??$`); a `?` is only allowed in `writes` and
means "may write" (`authn.identifyUser` writes `identity?`) — an optional write never
satisfies a read. A read on `a.b` is satisfied if an earlier step wrote `a.b` or `a`; a read
on `a` is satisfied if an earlier step wrote `a` or any `a.x`. A `result` write with no
sub-key replaces the whole object, and with it every previously written `result.<key>`.
`payload.*` reads are never checked (the client owns the payload; [Payload
Validation](#payload-validation) checks it against `describe().input`/`query` instead).

After resolving each pipeline, boot checks the dataflow (`checkDataflow`,
`@michaelthielemann/kestrel/dataflow`): available from the start are `payload`, `headers`,
`files`, `ip`, `params` plus `params.<p>` for every route parameter that **all** of the
pipeline's HTTP routes bind; a `params.<p>` read is always satisfied under an event trigger
(the envelope carries arbitrary params); in a pure cron pipeline, or when no HTTP route
binds the parameter, it is never satisfied — except for a pipeline with no trigger at all,
reachable only by calling `run()` directly (as in a test), where the caller supplies the
params itself. For every step in order: every read must be covered by an earlier write,
otherwise boot aborts with a `KestrelBootError` (naming the pipeline, step, path and the
writes so far); afterwards the step's `writes` are applied. This is why the old defensive
fallbacks are gone, like using `params.id` as a stand-in for a missing `result.id` — a step
like `delivery.publish:<type>` declares `reads: ["result.id"]`, the boot check proves every
pipeline supplies it, and the remaining `if (typeof id !== "string") throw …` is a pure bug
path.

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

`fakeSteps` is a step registry of stand-ins, no database needed. To run a module's real steps
with their `describe()` schemas, pass `modules: [{ module, instance }]` (the instance from
`module.setup(...)` against fakes) instead of or next to `steps`.

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

Steps are named after the *contract*, not the submodule: `authn/single` and `authn/siam`
both register `authn.login`. Pipelines say *what*, config says *with what*. Swapping a
submodule changes no pipeline.

## Pipelines Live Only in `pipelines/`

Submodules supply steps, not pipelines. A submodule's README may recommend what a typical
flow looks like; the consumer creates the file for it themselves. That way there is exactly
one place to read any flow in full, and no naming collisions between submodules.

## Event Data

`events.emit:<name>` sends `{ eventId, event, at, runId, identity, params, id }` for the
running pipeline. `eventId` is a fresh UUID per emit (a dedup key for consumers like
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
| `page.created` / `page.updated` / `page.deleted` | document id |
| `media.uploaded` / `media.updated` / `media.deleted` | document id (for a bulk upload of several files: `null`, plus `ids: string[]`) |
| `user.created` / `user.deactivated` | document id |
| `migrations.applied` | – (no envelope: the `migrations/default` module sends its own `{ migrations: [id], documents }` after a run; deliberately no `page.updated` per document it migrated). The named exception to rule 3: `apply()` is a contract method that also runs at boot, and after a partial failure the event still has to cover the migrations already applied — an `events.emit` step after a failing `migrations.apply` would never run |

Whatever the bus delivers is a shallowly frozen copy of the emitted data, like the context between
steps: a handler cannot change what the next handler sees, and assigning to the object throws in
the handler (which `emit` reports in its `AggregateError`). Nested objects are shared, not frozen.

`events.emit:<name>?with=result` additionally adds `result: ctx.result` unchanged (a
deliberate opt-in, not the default). **Careful:** the shape of `result` then depends on the
steps that ran before `events.emit` in the triggering pipeline (e.g. `delivery.publish`
replaces `ctx.result` with `{ document, delivery }`) — an event pipeline that consumes
`with=result` is coupled to that pipeline's step order and can vary per consumer
configuration.

`emit` is synchronous: the triggering pipeline waits for every listener, and the HTTP
response only goes out afterward. Listener errors are logged and don't fail the response;
long-running work belongs in a job the listener starts (like `images.sync`).

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

## Presets in kestrel-web

In the kestrel-web layer (separate repository), a preset supplies the default pipelines,
triggers and schemas for a typical setup, grouped by feature and wired to the configured
Kestrel modules. Pipelines remain exactly the model described above — strings plus
`definePipeline`; the preset only composes existing pipelines (base → feature patches →
overrides/exclude/schedules) and introduces no new concept. See the kestrel-web
documentation for details.
