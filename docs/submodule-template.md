# Submodule Template

A submodule is a package `@michaelthielemann/kestrel-<module>-<submodule>` (in the repository:
`packages/<module>-<submodule>/`) with `module.ts` as its shell and `impl.ts` as the entry
point, plus `package.json`. It doesn't have to fulfill a contract (`provides: []`) — a submodule
may also provide only steps, e.g. `audit/persistence` with the step `audit.record`.

## When a new package is warranted
A new package earns its own version, README, trusted-publishing setup, release checklist entry and
generated docs — real, recurring cost for a maintainer. Reach for one only when:

- a second, realistic implementation of the same contract exists or is foreseeable (blobstore on S3
  vs. the filesystem, authn single-user vs. multi-user, events delivered directly vs. through a
  queue), so consumers actually swap the package; or
- the module encapsulates a dependency heavy enough that a consumer who doesn't need it shouldn't pay
  for it (an S3 SDK, an image-processing library).

Domain logic without either property is an additional step set in an existing module, not a new package
— e.g. a new step reading from an already-configured store belongs next to that store's other steps.
Existing packages are not merged retroactively to fit this rule; splitting an already-published
package back together is a break with no benefit to a consumer.

This page describes the packaged form. A submodule that stays inside one consumer project needs no
package at all: a `module.ts` somewhere in the project, referenced by a relative `use` path, is
enough — `getting-started.md` § Your own module shows the smallest working one. Everything below
about `module.ts`, `describe()` and the checklist applies to both.

```
module.ts        Shell: name, provides, requires, optional?, configSchema, setup, steps, optional emits/attach/quiesce/teardown
impl.ts          Entry point. Imports only kestrel-contracts, its own files, Node, package.json deps
impl.test.ts     Calls the contract test, plus its own tests
README.md        Required content: what, why, config, steps, what's not included
```

Alongside `module.ts`/`impl.ts`, further **flat** `.ts` files are allowed if they form a
self-contained unit with its own test — e.g. `rules.ts`, `sizes.ts`/`generate.ts`, `wal.ts`,
`sanitize.ts`. No subfolders. Other packages import only `module.ts`/`impl.ts` or deliberately
published exports (`exports` in `package.json`, e.g. `./wal`); ESLint (`no-restricted-imports`)
enforces this.

Pattern: a small named shell (`module.ts`) plus a vertical slice — everything for one submodule
lives in one folder, no layers.

`package.json`: `peerDependencies` on `@michaelthielemann/kestrel` and `-contracts`, export
`"."` → `./module.ts`, `publishConfig.exports` → `dist/`, script `build: tsc -b`.
`tsconfig.json` with `composite: true` and `references` on `../core` and `../contracts`.
Nothing else.

## `module.ts` – example `packages/authn-multi/module.ts`

```ts
import { z } from "zod";
import { AUTHN, type Authn } from "@michaelthielemann/kestrel-contracts/authn";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { crossOriginRefusal, requestToken } from "@michaelthielemann/kestrel-contracts/helpers/session";
import { createAuthnMulti } from "./impl";

export const configSchema = z.object({
  identifier: z.enum(["username", "email"]).default("username"),
  minPasswordLength: z.number().int().min(8).default(16),
  sessionTtlSeconds: z.number().int().positive().default(86400),
});

export default defineModule({
  name: "authn/multi",
  provides: [AUTHN],
  requires: [PERSISTENCE],
  // optional: [CONTRACT] orders this submodule after the provider of CONTRACT, if it is loaded; deps.find(CONTRACT) then returns it, else undefined (deps.get stays strict and throws). Counts like requires for cycle detection.
  configSchema,

  async setup(config, deps): Promise<Authn> {
    deps.logger.info("authn/multi: setup");             // deps.logger writes JSON lines like the core
    // deps.root: absolute directory of the loaded kestrel.config (defaults to process.cwd()); resolve relative file paths in config against it, not process.cwd().
    return createAuthnMulti(config, deps.get(PERSISTENCE));
  },

  // Optional: runs once at the start of kestrel.stop(), synchronously, in reverse boot order,
  // before the in-flight runs drain. For a submodule that starts work of its own (a worker
  // claiming queued jobs, a poller): stop starting new work here, let started work finish.
  // Errors are logged but don't abort stop().
  // quiesce: (instance) => instance.stopPolling(),

  // Optional: runs in reverse boot order on kestrel.stop(), after the drain. Errors are logged but
  // don't abort stop(). For resources the submodule itself holds (connections, watchers).
  // teardown: (authn) => authn.close(),

  // Optional: runs once at the end of boot with the read-only view of the booted instance —
  // describe() is the manifest, observe(observer) sees every run and step start/end; the returned
  // function runs on stop(). For modules that watch the instance (insights), never for wiring.
  // attach: (instance, kestrel) => kestrel.observe(instance.observer),

  // Steps that pipelines may use. The name becomes "authn.<key>". Every step returns
  // Result<Context, KestrelError>: success is ok(ctx)/ok({ ...ctx, ... }), an expected failure
  // is ctx.fail(code, message, details?) or ctx.fail(error) for an existing KestrelError from
  // the contract. throw is reserved for wiring errors.
  steps: (authn) => ({
    requireUser: async (ctx: Context) => {
      const found = requestToken(ctx.headers);              // bearer or cookie, from kestrel-contracts/helpers/session
      if (!found) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      const refused = found.source === "cookie" ? crossOriginRefusal(ctx.trigger, ctx.headers) : undefined;
      if (refused !== undefined) return ctx.fail("FORBIDDEN", refused);
      const token = found.token;
      const identity = await authn.resolve(token);
      if (isErr(identity)) return ctx.fail(identity.error);
      if (!identity.value) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      return ok({ ...ctx, token, identity: identity.value });
    },
    login: async (ctx: Context) => {
      const session = await authn.login(ctx.payload);
      if (isErr(session)) return ctx.fail(session.error);
      if (!session.value) return ctx.fail("UNAUTHENTICATED", "invalid credentials");
      return ok({ ...ctx, token: session.value.token, identity: session.value.identity, result: session.value });
    },
  }),

  // describe() is required as soon as a module provides steps: summary, reads, writes per step
  // (both may be []) — see pipelines.md § Step catalogue / reads/writes.
  describe: () => ({
    requireUser: { summary: "Authenticate the request and set identity/token", reads: [], writes: ["token", "identity"], errors: { 401: "not authenticated" } },
    login: { summary: "Exchange credentials for a session", reads: [], writes: ["token", "identity", "result"], errors: { 401: "invalid credentials" } },
  }),
});
```

## Events from a contract method

A module that emits an event from a contract method instead of an `events.emit` step declares it:
`emits: ["migrations.applied"]` (`migrations/default`). Boot collects the events the pipelines emit
plus every module's `emits`; an event trigger on a name in neither set is logged as a warning
(`pipelines.md` § Triggers). The declaration shows up in the manifest as `ModuleManifest.emits`.

`emits` also decides setup order: `sortModules` sets up a module that declares `emits` after the
module providing the event trigger hook (unless it already depends on it), so the hook is already
subscribed once the module's own `setup()` raises its event. Skipping the declaration is not just a
missed warning — with `events-queue` as the delivery module, an event raised during a `setup()`
that runs before the queue exists is lost, since nothing is subscribed yet to store it.

## Contributing triggers

Modules can contribute triggers as well as steps: `triggers.event(instance, entries, run, logger)`
receives the event triggers from `kestrel.config.ts` at startup and returns the stop function
that the core calls in `stop()`. The core knows no contract name for this — it only looks for
the module with the hook; without such a module, boot aborts as soon as event triggers are
configured, and two modules with the hook are also a boot error. `events-direct` provides the
reference implementation; the bus module `events-inmemory` registers no hook at all — delivering
event-trigger pipelines is a separate module's job (also `events-queue`, an outbox).

## `impl.ts` – example

```ts
import type { Authn, AuthnError, Session } from "@michaelthielemann/kestrel-contracts/authn";
import type { Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import { createHash, scrypt, timingSafeEqual, randomBytes } from "node:crypto";   // or argon2 as a package.json dep

const digest = (token: string) => createHash("sha256").update(token).digest("base64url");   // a copy of the table holds no usable token
const derive = (password: string, salt: Buffer, length: number) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, length, (e, key) => (e ? reject(e) : resolve(key))));   // thread pool, not the event loop
async function verify(password: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split("$");
  const expected = Buffer.from(hash, "hex");
  return timingSafeEqual(await derive(password, Buffer.from(salt, "hex"), expected.length), expected);
}
const DUMMY_HASH = `scrypt$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`;

type Config = { identifier: "username" | "email"; minPasswordLength: number; sessionTtlSeconds: number };

export async function createAuthnMulti(config: Config, db: Persistence): Promise<Authn> {
  const id = config.identifier;
  await db.ensureCollection("authn_users", { [id]: "string", passwordHash: "string" });
  await db.ensureCollection("authn_sessions", { userId: "string", expiresAt: "number" });

  return {
    async login(creds): Promise<Result<Session | null, AuthnError>> {
      const user = await db.findOne<{ id: string; passwordHash: string }>("authn_users", { [id]: creds[id] });
      if (isErr(user)) return user;   // pass TRANSIENT through — no Err on wrong credentials
      const matches = await verify(creds.password ?? "", user.value?.passwordHash ?? DUMMY_HASH);   // same work for an unknown user
      if (!user.value || !matches) return ok(null);
      const token = randomBytes(32).toString("base64url");
      const created = await db.createOne("authn_sessions", { id: digest(token), userId: user.value.id, expiresAt: Date.now() + config.sessionTtlSeconds * 1000 });
      if (isErr(created)) return created;
      return ok({ token, identity: { id: user.value.id, claims: {} } });
    },
    async resolve(token) {
      const s = await db.findOne<{ id: string; userId: string; expiresAt: number }>("authn_sessions", { id: digest(token) });
      if (isErr(s)) return s;
      if (!s.value || s.value.expiresAt < Date.now()) return ok(null);
      return ok({ id: s.value.userId, claims: {} });
    },
    async logout(token) {
      return db.deleteOne("authn_sessions", digest(token));
    },
  };
}
```

Note: `authn_users` and `passwordHash` are decisions made by *this* submodule. `persistence@1`
knows nothing about them. A different authn submodule is free to use a different schema. Every
async contract method returns `Result<T, E>` (`contracts.md`); an `Err` from `persistence@1`
(`TRANSIENT`) is passed through unchanged (`if (isErr(x)) return x;`), wrong credentials are
`Ok(null)`, never an `Err` — only `throw` is reserved for wiring errors.

`describe()` is required as soon as a module provides `steps` (if missing, boot aborts with
`step "<name>" has no describe() entry`), and provides a `StepDescription` per step with the
required fields `summary`, `reads` and `writes` (path grammar and semantics: `pipelines.md`
§ reads/writes). A factory step's `describe(arg)` is called once at registration with the
placeholder argument `"<arg>"`; if it throws, boot aborts naming the step and the cause, so it
must work without a real argument. The runner compares what a step actually wrote against its
`writes` after every successful step and ends the run with 500 `INTERNAL` on a mismatch, so a
write that only happens on some paths is marked `"<path>?"`.

A step that reads `ctx.payload` (directly or through a helper) must declare what it reads: `input`
(a JSON Schema for the body, with `additionalProperties` stated explicitly — `false` unless the
step deliberately takes open objects) and/or `query` (a map of query-parameter name → schema;
never closed, undeclared parameters are ignored).

The runner enforces both before the step in every environment (`pipelines.md` § Payload
Validation). A static test in the core's suite fails for undeclared reads, and the module's
`module.test.ts` runs every step once through `testing/runPipeline` with
`modules: [{ module, instance }]`.

Further optional fields — output schema, errors, security, etc. — feed `kestrel openapi`. A step
that extends `ctx.result` with fields instead of replacing it (e.g. `redirects.export`) sets
`extendsOutput` instead of `output`, so the generator merges it into the predecessor's output
schema. `extendsItems` behaves the same but merges the schema into `properties.items.items` of the
predecessor when its output is a list (otherwise it merges at the root like `extendsOutput`) — for
steps like `images.attach` that extend each list item.

A step whose `writes` touches `result` must declare `output`, `extendsOutput`, `extendsItems`,
`narrows` for a step that only removes members of the answer (`authz.fields`), or `binary: true`
for a step whose result is a binary body rather than JSON (`media.download`, `images.serve`). Boot
checks this against every pipeline's resolved steps and fails, naming the pipeline and the step, for
one with none of the five. Every object schema inside `output`,
`extendsOutput` or `extendsItems` — nested properties, array items and object-valued
`additionalProperties` included — must declare `required`, listing exactly the properties the step
always returns (`required: []` when none are guaranteed); boot fails, naming the pipeline, the step
and the JSON path of the offending schema, for one that has `properties` but no `required`.
`boot({ validateOutput: true })` and `testing/runPipeline`
(always on) additionally validate `ctx.result` after every step that writes it (skipped when the
write is declared optional, `result?`, and `ctx.result` is unchanged) against the schema its
`output`/`extendsOutput`/`extendsItems` fold to at that point, failing the run on a mismatch; the
log names the step and the JSON path, and a `testing/runPipeline` test given no `logger` gets it as
the answer's `error`. A `narrows` step is checked differently: the answer after it must be a
member-wise subset of the answer it received. Production leaves
`validateOutput` off by default, so it pays nothing for this check unless a deployment opts in.

## `impl.test.ts`

```ts
import { authnContractTests } from "@michaelthielemann/kestrel-contracts/authn.contract.test";
import { createAuthnMulti } from "./impl";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";

authnContractTests(async () => {
  const db = createFakePersistence();
  const authn = await createAuthnMulti({ identifier: "username", minPasswordLength: 8, sessionTtlSeconds: 60 }, db);
  await db.createOne("authn_users", { id: "u1", username: "alice", passwordHash: await hash("secret") });
  return { authn, validCredentials: { username: "alice", password: "secret" } };
});
```

## `README.md`

Required content, one paragraph each: **What** (the core function in one sentence) · **Why**
(context, distinction from alternatives) · **Config** (options, defaults) · **Steps** (what the
submodule provides for pipelines) · **Not included** (deliberately left out, where that belongs
instead). No examples or how-tos — those belong in `docs/`. Rule of thumb: fits on one screen
(~30 lines) — plus the generated section between `<!-- kestrel-docs:start -->` and
`<!-- kestrel-docs:end -->` that `pnpm docs:generate` writes from the manifest (config variables,
steps, the example's pipelines); never edit it by hand, CI compares it.

```
# authn/multi
Multi-user login with username or email plus password. Sessions via token in persistence@1.
Requires persistence@1. Creates collections authn_users and authn_sessions; `bootstrap` creates
the first user. Steps for user management (createUser, setPassword, deactivateUser …).
Not included: self-service registration, password reset (own pipelines).
```

## Checklist before publishing

- [ ] `module.ts`/`impl.ts` present, further flat files only with their own test, no subfolders
- [ ] Steps with an argument (`name:arg`) are marked with `stepFactory()`
- [ ] No imports from other submodule packages except deliberately published exports (ESLint
      `no-restricted-imports` enforces this)
- [ ] `setup()` returns the contract type, `tsc` is satisfied
- [ ] Every step returns `Result<Context, KestrelError>` (`ok(ctx)`/`ok({ ...ctx, … })` on
      success, `ctx.fail(code, message, details?)` or `ctx.fail(error)` on an expected
      failure); `throw` only for wiring errors
- [ ] `describe()` is present and covers every step, including `reads`/`writes`; a factory
      `describe(arg)` also works for the placeholder argument `"<arg>"`
- [ ] `writes` matches what every success path of the step really writes — conditional writes
      carry `?`, otherwise the runner ends the run with 500 `INTERNAL`
- [ ] Events the module emits from a contract method (not from a pipeline step) are listed in
      `emits`
- [ ] Every step that reads the payload declares `input` and/or `query`; body schemas state
      `additionalProperties`; `module.test.ts` runs every step once through
      `testing/runPipeline` with `modules: [{ module, instance }]`, including one schema violation
- [ ] Contract test passes
- [ ] Invalid config is caught by `configSchema` (Zod throws)
- [ ] No route, no `emit`, no pipeline, no flow logic in the submodule
- [ ] Step names are verbs (`login`, `requireUser`, `createOne`), see the vocabulary in
      `pipelines.md`
- [ ] If the submodule holds a connection, a watcher, etc.: `teardown` closes it
- [ ] If the submodule starts work of its own (claims queued jobs, polls on a timer): `quiesce`
      stops it synchronously, so nothing new starts while `stop()` drains
- [ ] If the submodule contributes a trigger (`triggers.event`): the returned stop function
      unregisters all of it
- [ ] Config fields that hold credentials carry `.describe("secret")`: the manifest
      (`kestrel.describe()`, `insights`) shows every other variable's effective value, and a marked
      one only `value: null, redacted: true` — no default, nothing derived. Key names that read like
      a credential (`password`, `token`, `apiKey`, …) are redacted by a second net and are checked
      against the marker by `scripts/workspace.test.ts`, but the marker is what a reviewer reads
- [ ] `pnpm docs:generate` after changing `configSchema` or `describe()`: the generated section of
      the README (between the `kestrel-docs` markers) and `examples/minimal/manifest.json` are
      checked by CI
