# Submodule Template

A submodule is a package `@michaelthielemann/kestrel-<module>-<submodule>` (in the repository:
`packages/<module>-<submodule>/`) with `module.ts` as its shell and `impl.ts` as the entry
point, plus `package.json`. It doesn't have to fulfill a contract (`provides: []`) — a submodule
may also provide only steps, e.g. `audit/persistence` with the step `audit.record`.

```
module.ts        Shell: name, provides, requires, optional?, configSchema, setup, steps, optional teardown
impl.ts          Entry point. Imports only kestrel-contracts, its own files, Node, package.json deps
impl.test.ts     Calls the contract test, plus its own tests
README.md        Required content: what, why, config, steps, what's not included
```

Alongside `module.ts`/`impl.ts`, further **flat** `.ts` files are allowed if they form a
self-contained unit with its own test — e.g. `rules.ts`, `sizes.ts`/`generate.ts`, `wal.ts`,
`sanitize.ts`. No subfolders. Other packages import only `module.ts`/`impl.ts` or deliberately
published exports (`exports` in `package.json`, e.g. `./wal`); ESLint (`no-restricted-imports`)
enforces this.

Pattern: **Fastify plugin** (a shell with `name` and registration) + **vertical slice**
(everything in one folder, no layers).

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

  // Optional: runs in reverse boot order on kestrel.stop(). Errors are logged but don't abort
  // stop(). For resources the submodule itself holds (connections, watchers).
  // teardown: (authn) => authn.close(),

  // Steps that pipelines may use. The name becomes "authn.<key>". Every step returns
  // Result<Context, KestrelError>: success is ok(ctx)/ok({ ...ctx, ... }), an expected failure
  // is ctx.fail(code, message, details?) or ctx.fail(error) for an existing KestrelError from
  // the contract. throw is reserved for wiring errors.
  steps: (authn) => ({
    requireUser: async (ctx: Context) => {
      const token = tokenFromHeaders(ctx.headers);          // bearer or cookie, the submodule's concern
      if (!token) return ctx.fail("UNAUTHENTICATED", "not authenticated");
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

## Contributing triggers

Modules can contribute triggers as well as steps: `triggers.event(instance, entries, run, logger)`
receives the event triggers from `kestrel.config.ts` at startup and returns the stop function
that the core calls in `stop()`. The core knows no contract name for this — it only looks for
the module with the hook; without such a module, boot aborts as soon as event triggers are
configured, and two modules with the hook are also a boot error. `events-inmemory` provides the
reference implementation.

## `impl.ts` – example

```ts
import type { Authn, AuthnError, Session } from "@michaelthielemann/kestrel-contracts/authn";
import type { Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import { scryptSync, timingSafeEqual, randomBytes } from "node:crypto";   // or argon2 as a package.json dep
import { randomUUID } from "node:crypto";

type Config = { identifier: "username" | "email"; minPasswordLength: number; sessionTtlSeconds: number };

export async function createAuthnMulti(config: Config, db: Persistence): Promise<Authn> {
  const id = config.identifier;
  await db.ensureCollection("authn_users", { [id]: "string", passwordHash: "string" });
  await db.ensureCollection("authn_sessions", { userId: "string", expiresAt: "number" });

  return {
    async login(creds): Promise<Result<Session | null, AuthnError>> {
      const user = await db.findOne<{ id: string; passwordHash: string }>("authn_users", { [id]: creds[id] });
      if (isErr(user)) return user;   // pass TRANSIENT through — no Err on wrong credentials
      if (!user.value || !verify(creds.password, user.value.passwordHash)) return ok(null);
      const token = randomUUID();
      const created = await db.createOne("authn_sessions", { id: token, userId: user.value.id, expiresAt: Date.now() + config.sessionTtlSeconds * 1000 });
      if (isErr(created)) return created;
      return ok({ token, identity: { id: user.value.id, claims: {} } });
    },
    async resolve(token) {
      const s = await db.findOne<{ id: string; userId: string; expiresAt: number }>("authn_sessions", { id: token });
      if (isErr(s)) return s;
      if (!s.value || s.value.expiresAt < Date.now()) return ok(null);
      return ok({ id: s.value.userId, claims: {} });
    },
    async logout(token) {
      return db.deleteOne("authn_sessions", token);
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
§ reads/writes). A step that reads `ctx.payload` (directly or through a helper) must declare
what it reads: `input` (a JSON Schema for the body, with `additionalProperties` stated
explicitly — `false` unless the step deliberately takes open objects) and/or `query` (a map of
query-parameter name → schema; never closed, undeclared parameters are ignored). The runner
enforces both before the step in every environment (`pipelines.md` § Payload Validation), a
static test in the core's suite fails for undeclared reads, and the module's `module.test.ts`
runs every step once through `testing/runPipeline` with `modules: [{ module, instance }]`.
Further optional fields — output schema, errors, security, etc. — feed `kestrel-openapi`; a step that extends `ctx.result` with fields instead of replacing it
(e.g. `redirects.export`) sets `extendsOutput` instead of `output` — the generator merges it
into the predecessor's output schema. `extendsItems` behaves the same but merges the schema into
`properties.items.items` of the predecessor when its output is a list (otherwise it merges at
the root like `extendsOutput`) — for steps like `images.attach` that extend each list item.

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
(~30 lines).

```
# authn/multi
Multi-user login with username or email plus password. Sessions via token in persistence@1.
Requires persistence@1. Creates collections authn_users and authn_sessions; `bootstrap` creates
the first user. Steps for user management (createUser, setPassword, deactivateUser …).
Not included: self-service registration, password reset (own pipelines).
```

## Checklist before "done"

- [ ] `module.ts`/`impl.ts` present, further flat files only with their own test, no subfolders
- [ ] Steps with an argument (`name:arg`) are marked with `stepFactory()`
- [ ] No imports from other submodule packages except deliberately published exports (ESLint
      `no-restricted-imports` enforces this)
- [ ] `setup()` returns the contract type, `tsc` is satisfied
- [ ] Every step returns `Result<Context, KestrelError>` (`ok(ctx)`/`ok({ ...ctx, … })` on
      success, `ctx.fail(code, message, details?)` or `ctx.fail(error)` on an expected
      failure); `throw` only for wiring errors
- [ ] `describe()` is present and covers every step, including `reads`/`writes`
- [ ] Every step that reads the payload declares `input` and/or `query`; body schemas state
      `additionalProperties`; `module.test.ts` runs every step once through
      `testing/runPipeline` with `modules: [{ module, instance }]`, including one schema violation
- [ ] Contract test passes
- [ ] Invalid config is caught by `configSchema` (Zod throws)
- [ ] No route, no `emit`, no pipeline, no flow logic in the submodule
- [ ] Step names are verbs (`login`, `requireUser`, `createOne`), see the vocabulary in
      `pipelines.md`
- [ ] If the submodule holds a connection, a watcher, etc.: `teardown` closes it
- [ ] If the submodule contributes a trigger (`triggers.event`): the returned stop function
      unregisters all of it
