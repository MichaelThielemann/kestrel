# Contracts

A contract is a TypeScript interface plus a `defineContract(name, methods)` object with a
versioned name. It describes a *capability*, never *data*. The compiler checks the interface,
boot checks the method list (is every method present?).

The standard contracts live in the package `@michaelthielemann/kestrel-contracts`. A consumer
may define its own contracts with the same `defineContract`; the core treats them identically.

## Rules

- Name: `<capability>@<major>`, e.g. `persistence@1`. A new major version = a new contract.
- Domain-neutral. No words like `user`, `page`, `email` in the contract.
- Every contract has exactly one file `<name>.ts` and one test `<name>.contract.test.ts`
  (in the package under `packages/contracts/src/`).
- The package exports each shared suite by name
  (`@michaelthielemann/kestrel-contracts/<name>.contract.test`), listed in the package's `exports`
  and in the `files` of its `tsconfig.json`. Every other `*.test.ts` in the package is its own unit
  test: it is not built, not published and not importable.
- New contracts only when a different *implementation* is needed, not different *fields*.
  `blobstore@1` is its own contract (different technology), `user-persistence@1` is not.
- Contracts don't change once frozen. A capability that needs a different shape becomes a new
  major (`persistence@2`) next to the old one.
- A frozen contract freezes its methods, their meaning and the types its own file defines. A core
  type it returns by reference, such as `Manifest` from `insights@1`'s `manifest()`, belongs to the
  core and grows additively with the core's major; an implementation that passes the core's value
  through needs no change.
- A contract's shared suite states its meaning in executable form. A suite may tighten that
  meaning only in a major release of the contracts package, and only to close a leak of
  unpublished data; it never weakens one. `site@1`'s suite did so in 6.0.0: a provider falls back
  only from a published default locale, narrows `_translations` to the locales that pass the
  filter, and answers 404 for a path reachable only through a draft slug. Boot cannot tell a
  provider written against the looser suite, so a provider runs the new major's suite before it
  widens its dependency range to that major.
- The query vocabulary types (`Filter`, `Condition`, `FindOptions`, `Page`) live in
  `contracts/query.ts` and are shared by `persistence@1`, `content@1` and `site@1`, so no contract
  file has to import another one for them.
- **Every async contract method returns `Promise<Result<T, E>>`**, never a rejection. Absence
  stays inside `Ok` (`Result<T | null, E>` — a `findOne`/`resolve`/`get` that finds nothing is
  not an error); only the *mutation* of something that must exist (`updateOne`, `move`)
  answers `NOT_FOUND`. `throw` is reserved for wiring errors: an unknown type/field/collection/
  format, an invalid key, `create` on a single-kind type. Synchronous methods (`model`,
  `validate`, `pathOf`, `formats`, `targets`, `check`, `on`) are unaffected. Every contract
  declares its `E` as the smallest possible code union plus `TRANSIENT` (any IO can fail
  transiently); an implementation may return fewer codes than the union, never more.
  `packages/contracts/src/errors.ts` re-exports `KestrelError`, `CoreCode`, `failure`,
  `customFailure`, `Result`, `ok`, `err`, `isErr`, so a contract file needs only one import
  path. Details, the code list and the builder functions: `pipelines.md` § Errors as values.

## Example: `contracts/persistence.ts`

```ts
import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import { type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Filter, FindOptions, Page } from "@michaelthielemann/kestrel-contracts/query";

export type { Condition, Filter, FindOptions, Page } from "@michaelthielemann/kestrel-contracts/query";

export type FieldType = "string" | "number" | "boolean" | "json";
export interface FieldDefinition { type: FieldType; unique?: boolean }   // unique: a second non-null value is CONFLICT with details.field
export type Schema = Record<string, FieldType | FieldDefinition>;

export interface Document { id: string; [field: string]: unknown }

export type NewDocument<T extends Document> = Omit<T, "id"> & { id?: string };   // no id → UUID

export type PersistenceError = KestrelError<"CONFLICT" | "NOT_FOUND" | "TRANSIENT">;

export interface Persistence {
  ensureCollection(name: string, schema: Schema): Promise<Result<void, PersistenceError>>;   // throws when stored rows already violate a new unique field
  createOne<T extends Document>(collection: string, data: NewDocument<T>): Promise<Result<T, PersistenceError>>;   // CONFLICT: id or a unique value already exists
  createMany<T extends Document>(collection: string, data: NewDocument<T>[]): Promise<Result<T[], PersistenceError>>;   // all or nothing
  findOne<T extends Document>(collection: string, filter: Filter): Promise<Result<T | null, PersistenceError>>;   // nothing found is Ok(null), never an Err
  findMany<T extends Document>(collection: string, filter: Filter, options?: FindOptions): Promise<Result<Page<T>, PersistenceError>>;
  count(collection: string, filter: Filter): Promise<Result<number, PersistenceError>>;
  updateOne<T extends Document>(collection: string, id: string, patch: Partial<Omit<T, "id">>): Promise<Result<T, PersistenceError>>;   // NOT_FOUND: id does not exist; CONFLICT: a unique value already exists
  updateMany<T extends Document>(collection: string, filter: Filter, patch: Partial<Omit<T, "id">>): Promise<Result<number, PersistenceError>>;
  deleteOne(collection: string, id: string): Promise<Result<void, PersistenceError>>;   // a missing id is Ok, not NOT_FOUND
  deleteMany(collection: string, filter: Filter): Promise<Result<number, PersistenceError>>;
}

export const PERSISTENCE = defineContract<Persistence>()("persistence@1", [
  "ensureCollection", "createOne", "createMany", "findOne", "findMany", "count",
  "updateOne", "updateMany", "deleteOne", "deleteMany",
]);
```

A raw value in a `Condition` means equality; every condition within a filter is AND-combined
(`{ like: string }` follows SQL semantics: `%` any number of characters, `_` one character).

`E = PersistenceError` is everywhere `CONFLICT | NOT_FOUND | TRANSIENT`; only `createOne`/
`createMany` answer `CONFLICT`, only `updateOne` answers `NOT_FOUND`, every method can return
`TRANSIENT` (e.g. `SQLITE_BUSY`). An unknown collection, an unknown field, `id` inside the
schema, a non-string for a string column all stay `throw` — wiring errors, not a `Result`.

Deliberately not included: transactions, joins, `upsert`, a free-form query language. Whatever
only one technology can do is not a neutral contract. More capability = its own contract (e.g.
`search@1`), not more methods here.

## Example: `contracts/authn.ts`

```ts
import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import { type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";

export interface Identity {
  id: string;
  /** Arbitrary extra data that authz may evaluate later. */
  claims: Record<string, unknown>;
}

// Only importing this contract puts token/identity on the context.
declare global {
  namespace Kestrel {
    interface ContextExtensions { token?: string; identity?: Identity }
  }
}

export interface Session {
  token: string;
  identity: Identity;
}

export type AuthnError = KestrelError<"TRANSIENT">;

export interface Authn {
  /** Creates a session and returns it, or Ok(null). Never Err on wrong credentials. */
  login(credentials: Record<string, string>): Promise<Result<Session | null, AuthnError>>;
  /** Resolves a session token. */
  resolve(token: string): Promise<Result<Identity | null, AuthnError>>;
  logout(token: string): Promise<Result<void, AuthnError>>;
}

export const AUTHN = defineContract<Authn>()("authn@1", ["login", "resolve", "logout"]);
```

Wrong credentials are `Ok(null)`, never an `Err` — here, an `Err` means exclusively "could not
be checked" (`TRANSIENT`), never "checked and rejected".

## Example: `contracts/authz.ts`

```ts
export type AuthzError = KestrelError<"TRANSIENT">;

export interface Authz {
  /** resource is optional: `admin-only` ignores it, a policy submodule might evaluate e.g. ownership. */
  can(identity: Identity, permission: string, resource?: Record<string, unknown>): Promise<Result<boolean, AuthzError>>;
}

export const AUTHZ = defineContract<Authz>()("authz@1", ["can"]);
```

A step's `anonymous: "required"` (on `StepDescription`) marks its output as also published without
an access check: whichever module attaches to the booted instance is responsible for checking, for
every pipeline that runs such a step, that an anonymous caller actually passes it. `authz-roles`
does this at `attach()` and fails boot otherwise. `authz@1` itself carries no anonymous verdict, so
this is a residual gap: another `authz@1` provider has to perform the same check itself, or the flag
goes unchecked for that provider.

A step's `narrows` (on `StepDescription`) declares that the step only removes members from `result`:
`shape` says where the items of the answer are (`item`, `list` for `{ items, total }`, `array`,
`file`), and `answers` lists, per audience label, the member paths that audience keeps of one item.
Boot accepts it as the declaration of the step's `result` write, the folded output schema passes
through the step unchanged, and under `validateOutput` the answer after the step must be a
member-wise subset of the answer it received (no new member, no changed value), which the step that
wrote it has already checked against that schema. The core never evaluates the labels or the paths; `kestrel-openapi` documents one
answer per label.

`authz-roles` uses it for field grants. `anonymousFields` (resource → field paths) and `fields` (role
→ resource → field paths) say which members of an answer a caller keeps, and its step
`authz.fields:<resource>?shape=<shape>`, last in a pipeline, cuts the answer to them: a caller
without an identity, or with one that holds no configured role, keeps the anonymous grant and never
everything; any other signed-in caller keeps everything when one of its roles has no grant for the
resource, otherwise the union of its roles' grants and the anonymous one. At `attach()` boot fails
when a pipeline an anonymous caller reaches over HTTP does not end with the step or its resource has
no anonymous grant, when the declared output does not fit the shape parameter or `?shape=item` cuts
a list whose granted paths only its elements declare, when a grant names a
field no pipeline of its resource declares, and when an answer a step ends the run with before the
step carries a member the anonymous grant or a role's grant does not cover. Such an early answer is
always a declared one: a step that ends the run without declaring `terminalOutput` fails the run. Like
`anonymous: "required"`, this is `authz-roles`' own check: another `authz@1` provider has neither the
step nor the checks, so under it every caller receives the whole answer.

## Contract test: `contracts/persistence.contract.test.ts`

Every implementation calls this function with a factory.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { expectOk, expectErr } from "./testing/result.ts";
import type { Persistence } from "./persistence.ts";

export function persistenceContractTests(make: () => Promise<Persistence>) {
  describe("persistence@1", () => {
    let db: Persistence;
    beforeEach(async () => {
      db = await make();
      expectOk(await db.ensureCollection("things", { name: "string", n: "number" }));
    });

    it("createOne then findOne", async () => {
      expectOk(await db.createOne("things", { id: "a", name: "x", n: 1 }));
      expect(expectOk(await db.findOne("things", { name: "x" }))).toEqual({ id: "a", name: "x", n: 1 });
    });

    it("createOne with an existing id is a conflict", async () => {
      expectOk(await db.createOne("things", { id: "a", name: "x", n: 1 }));
      expectErr(await db.createOne("things", { id: "a", name: "y", n: 2 }), "CONFLICT");
    });

    it("findMany filters, sorts and pages", async () => {
      expectOk(await db.createMany("things", [{ name: "a", n: 1 }, { name: "b", n: 2 }, { name: "c", n: 3 }]));
      const page = expectOk(await db.findMany("things", { n: { gte: 2 } }, { sort: { n: "desc" }, limit: 1 }));
      expect(page.total).toBe(2);
      expect(page.items.map((d) => d.name)).toEqual(["c"]);
    });
    // ... full suite in the repository
  });
}
```

Called from the submodule (`packages/persistence-sqlite/impl.test.ts`):

```ts
import { persistenceContractTests } from "@michaelthielemann/kestrel-contracts/persistence.contract.test";
import { createPersistenceSqlite } from "./impl.ts";

persistenceContractTests(async () => createPersistenceSqlite({ file: ":memory:" }));
```

## List of contracts (expected for the CMS)

| Contract | Capability | `E` (async, `Result<T, E>`) | Typical submodules |
|---|---|---|---|
| `authn@1` | Who you are | `KestrelError<"TRANSIENT">` — wrong credentials are `Ok(null)`, never `Err` | `single` (one user from config), `multi` (users + sessions in persistence) |
| `authz@1` | Are you allowed to (role/capability, optionally object-scoped) | `KestrelError<"TRANSIENT">` | `roles` |
| `persistence@1` | Store/find documents (raw storage for modules) | `KestrelError<"CONFLICT" \| "NOT_FOUND" \| "TRANSIENT">` | `sqlite` |
| `content@1` | Typed documents from a config-declared model: `single`/`multi`, field types, validation, timestamps. Generic document CRUD, no website vocabulary | `KestrelError<"VALIDATION" \| "NOT_FOUND" \| "CONFLICT" \| "TRANSIENT">` | `default` (on persistence) |
| `site@1` | Website vocabulary over `content@1`: `resolve` (path → document per `SiteRules`), `pathOf` (document → path), `resolveLinks` (internal references → public paths) | `KestrelError<"TRANSIENT">` — an unresolvable path is `Ok(null)` | `default` (on content) |
| `blobstore@1` | Bytes by key: `put(key, bytes, { contentType? })` (the type is a write-time hint for stores that serve objects directly), `get` → bytes, `remove`, `move`, `list(prefix)` → `{ key, size }` | `KestrelError<"NOT_FOUND" \| "TRANSIENT">` — `move` from a missing key is `NOT_FOUND`, `get`/`remove` of a missing key is `Ok` | `filesystem`, `s3` |
| `media@1` | Read the ready files a media provider stores: `file`, `files`, `load` (file and bytes), `scan` (by type pattern, creation time, resumable cursor), `count`. Readiness is the provider's: only a file whose bytes are all stored and whose removal has not begun is visible, and a removal ends readiness before any byte goes | `KestrelError<"TRANSIENT">` — an unknown or not-ready id is `Ok(null)`; a `scan` limit outside 1–500 throws | `default` (`media-default`: upload into blobstore, metadata in persistence, plus its own steps) |
| – (steps only) | Image variants: size registry, generation on upload, resumable sync, prune, delivery by path; requires `media@1` | – | `images-default` |
| – (steps only) | Backup of a SQLite snapshot into blobstore, restore on start | – | `backup-blobstore` |
| – (steps only) | Continuous SQLite replication (snapshots + WAL segments), point-in-time restore | – | `replication-sqlite` |
| – (steps only) | Reference integrity for `ref` fields | – | `references-default` |
| – (steps only) | Find, check, report external links | – | `links-default` |
| – (steps only) | Redirects: validate rules, resolve within the site pipeline, export `redirects.json` | – | `redirects-default` |
| – (steps only) | Sanitize uploaded SVGs | – | `sanitize-svg` |
| `events@1` | Emit/listen to events; synchronous; listener errors → AggregateError | no `Result`: `emit` throws an `AggregateError` | `inmemory` (the bus only; delivering event-trigger pipelines is a separate module, `events-direct` or `events-queue`, neither of which provides this contract) |
| `renderer@1` | Render a document into a format (`formats()`, `render()` with assets) | `KestrelError<"TRANSIENT" \| "RENDER_FAILED">` — both contract-specific or core codes, status 503/500 respectively | `plain` (reference); a site brings its own, built on its frontend framework |
| – (steps only) | Static delivery: render, store in blobstore, per-language status | – | `delivery-static` |
| `validate@1` | Check a payload field against a schema: `targets()` (`"<collection>.<field>"`), `check(target, value)` → `{ ok, problems: [{ path, message }] }` | no `Result`: synchronous, no `Promise` | `jsonschema` (ajv; HTML sanitization stays a step) |
| `revisions@1` | Append-only version history per (collection, document, locale): `record` a full snapshot, `list`/`read`, `label`, `head`, `prune`, `remove`. Branching follows from `parentId` alone; no merge | `KestrelError<"NOT_FOUND" \| "TRANSIENT">` — an unknown revision in `read` is `Ok(null)`, only `record` with an unknown parent and `label` answer `NOT_FOUND` | `default` (on persistence; content optional, only for the default locale) |
| `insights@1` | One view of the running instance: `manifest()` (what is wired) and `stats()` (how it runs) | no `Result`: both synchronous | `default` (reads the core's manifest and run observer) |
| `migrations@1` | Manage content migrations (`{ id, collection, up }`): `list`/`check` (pending/applied), `apply` (also `dry`) — applies every migration to every document and every stored language exactly once, logs to a ledger | `KestrelError<"CONFLICT" \| "TRANSIENT" \| "MIGRATION_FAILED">` — `MIGRATION_FAILED` (500) carries `details: { migration, document, locale?, problems? }` | `default` (on content, persistence, events; validate optional) |

`blobstore@1.move(from, to)` against a missing `from` key fails with an error message that
contains `not found` (pinned by the contract test) — an adapter must not let a technical error
(e.g. `NoSuchKey`) through untranslated.

## Reads a render can see

`delivery-static` re-renders a published page when something its last render read changes. It learns what a render
read through `@michaelthielemann/kestrel/reads`: `observeReads(fn)` runs `fn` in a read scope and returns the reads
noted inside it, `noteRead(read)` records one, and `unobserved(fn)` hides the reads of lookups a provider makes on its
own behalf. A `content@1` or `site@1` provider (and any provider a renderer reads through) should note what it
answers: `content-default` notes a `document` read per `get` of a multi type (also when the answer is `null`), a
`type` read per single type, and a `query` read plus one `document` read per returned item for `list`;
`site-default` notes the document `resolve` answered with (or the slug lookup that found nothing) and one `path`
read per link `resolveLinks` resolved, with its locale and rules. A provider that notes nothing still works, but the
pages that read from it refresh only on their own publish.

A provider must keep no process-wide in-flight dedupe or memo of reads: the scope lives in the async context of the
render, so a cached answer shared between two callers attributes one render's reads to the other render, or to
none. `noteRead` outside a scope, inside `unobserved`, or after the scope's function settled records nothing, and
concurrent scopes never see each other's reads. Inside a scope it keeps a plain JSON copy of the read, so a provider
can pass its own filter or rules objects as they are. Reads made in another process, over a socket, or answered from a
cache kept across requests are not observed.

## Content is configuration, not modules

`content@1` knows no "Page". What makes up a website is declared by the consumer in the model:

```ts
{ use: "@michaelthielemann/kestrel-content-default", config: {
  locales: ["de", "en"], defaultLocale: "de",
  types: {
    settings: { kind: "single", fields: { title: { type: "text", required: true, localized: true }, navigation: "json" } },
    pages:    { kind: "multi",  fields: {
      slug:   { type: "slug", required: true, unique: true, localized: true },
      title:  { type: "text", required: true, localized: true },
      body:   { type: "json", localized: true },                       // the page builder's block tree
      status: { type: "enum", options: ["draft", "finished", "published"], required: true },
    } },
  },
}}
```

Field types: `text richtext number boolean date slug json enum ref`. Per field: `required`,
`unique`, `localized`, `options` (enum), `to` (ref).

**References**: `{ type: "ref", to: "media" }` stores an ID. `content@1` only validates the
format; the steps-only module `references-default` takes care of the rest with its own index
(`references_index`):

- `references.check:<type>` runs before `content.create`/`content.update` and confirms the target
  exists.
- `references.index:<type>` runs afterwards and adds the reference to the index.
- `references.unindex:<type>` runs after `content.remove` and removes it from the index.
- `references.guard:<target>` reads the index before deletion and answers 409 if something still
  refers to the target.
- `references.scan` marks broken references via cron.
- `references.report` lists them.
- `references.rebuild` rebuilds the index from scratch.

Targets are declared by its config: content types by name, everything else (media) by persistence
collection.

Two origins are indexed, distinguished by the `via` field of each index row: `"field"` for
`ref` fields, `"body"` for internal references **inside the block tree** — every
`kestrel:<type>:<id>` and every `{ type: "internal", collection, id }` inside a `json` field
(all languages), i.e. exactly what `site.resolveLinks` later rewrites into paths. A `<type>`
that is not a configured target is ignored. The deletion guard therefore also sees media and
pages that are only used inside a block. `references.referrers`/`referrersMany`/`report`
include `via` in their output; a row without `via` reads as `"field"`.

**i18n** is part of the model, not a module: `localized` fields are stored per language,
`required`/`unique` apply per language. Reading with `locale` is **strict** — a missing
translation is `null`, the frontend decides what to do. `fallback: true` (step argument
`?fallback=true`) fills in from `defaultLocale` and names the origin per field in `_locales`.
Website routing is not `content@1`'s job but `site@1`'s (`site-default`, activated after
`content-default`): `site.resolve:pages?home=home&status=published&fallback=true` on a
wildcard route (`GET /site/*path`): `/`, `/<slug>`, `/<lang>`, `/<lang>/<slug>` — the primary
language without a prefix. `content@1`'s own `fallback: true` fills a field from `defaultLocale`
unconditionally, since `content@1` carries no notion of "published"; every module that builds a
public view on top of it adds that on top, through `@michaelthielemann/kestrel-contracts/content-locale`'s
`publishedLocale`: it only uses `content@1`'s fallback once the default locale's own values pass the
given filter too, and narrows `_translations` to the locales that pass it themselves. `site@1`,
`delivery-static` and `content-default`'s own `get`/`list` steps (whenever their step argument
carries a fixed filter) all apply this the same way, using `narrowListTranslations` for a list page
so the narrowing is batched, not per item.

**Status** is an `enum` field the consumer defines. The rule "public only shows published" is a
pipeline concern: `content.list:pages?status=published` — a fixed filter in the step argument
that the client cannot override. That same step refuses to also carry `?fallback=true`: fallback is
status-unaware by contract, so a filtered read must never use it; combining them fails to boot,
naming the step and pointing at `site.resolve` instead.

A type only becomes its own module once it needs *behavior* (media: upload into `blobstore@1`).
