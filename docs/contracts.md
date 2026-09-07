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
- New contracts only when a different *implementation* is needed, not different *fields*.
  `blobstore@1` is its own contract (different technology), `user-persistence@1` is not.
- Contracts don't change once frozen. A change request → ask a human.
- The query vocabulary types (`Filter`, `Condition`, `FindOptions`, `Page`) live in
  `contracts/query.ts` and are shared by `persistence@1`, `content@1` and `site@1`; `content@1`
  therefore no longer imports anything from `persistence.ts`.
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
  createMany<T extends Document>(collection: string, data: NewDocument<T>[]): Promise<Result<T[], PersistenceError>>;   // all or nothing, as today
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
| `authn@1` | Who you are | `KestrelError<"TRANSIENT">` — wrong credentials are `Ok(null)`, never `Err` | `single` (one user from config), `multi` (users + sessions in persistence), later `siam` |
| `authz@1` | Are you allowed to (role/capability, optionally object-scoped) | `KestrelError<"TRANSIENT">` | `admin-only`, `roles` |
| `persistence@1` | Store/find documents (raw storage for modules) | `KestrelError<"CONFLICT" \| "NOT_FOUND" \| "TRANSIENT">` | `sqlite`, `mariadb` |
| `content@1` | Typed documents from a config-declared model: `single`/`multi`, field types, validation, timestamps. Generic document CRUD, no website vocabulary | `KestrelError<"VALIDATION" \| "NOT_FOUND" \| "CONFLICT" \| "TRANSIENT">` | `default` (on persistence), later `external` |
| `site@1` | Website vocabulary over `content@1`: `resolve` (path → document per `SiteRules`), `pathOf` (document → path), `resolveLinks` (internal references → public paths) | `KestrelError<"TRANSIENT">` — an unresolvable path is `Ok(null)` | `default` (on content) |
| `blobstore@1` | Binary files: `put`, `get`, `remove`, `move`, `list(prefix)` | `KestrelError<"NOT_FOUND" \| "TRANSIENT">` — `move` from a missing key is `NOT_FOUND`, `get`/`remove` of a missing key is `Ok` | `filesystem`, `s3` |
| – (steps only) | Media: upload into blobstore, metadata in persistence | – | `media-default` |
| – (steps only) | Image variants: size registry, generation on upload, resumable sync, prune, delivery by path | – | `images-default` |
| – (steps only) | Backup of a SQLite snapshot into blobstore, restore on start | – | `backup-blobstore` |
| – (steps only) | Continuous SQLite replication (snapshots + WAL segments), point-in-time restore | – | `replication-sqlite` |
| – (steps only) | Reference integrity for `ref` fields | – | `references-default` |
| – (steps only) | Find, check, report external links | – | `links-default` |
| – (steps only) | Redirects: validate rules, resolve within the site pipeline, export `redirects.json` | – | `redirects-default` |
| – (steps only) | Sanitize uploaded SVGs | – | `sanitize-svg` |
| `events@1` | Emit/listen to events; synchronous; listener errors → AggregateError | unchanged (no `Result`, `emit` still throws `AggregateError`) | `inmemory` |
| `renderer@1` | Render a document into a format (`formats()`, `render()` with assets) | `KestrelError<"TRANSIENT" \| "RENDER_FAILED">` — both contract-specific or core codes, status 503/500 respectively | `plain` (reference), a Nuxt renderer in the kestrel-web layer (separate repository) |
| – (steps only) | Static delivery: render, store in blobstore, per-language status | – | `delivery-static` |
| `validate@1` | Check a payload field against a schema: `targets()` (`"<collection>.<field>"`), `check(target, value)` → `{ ok, problems: [{ path, message }] }` | unchanged (synchronous, no `Promise`) | `jsonschema` (ajv; HTML sanitization stays a step) |
| `migrations@1` | Manage content migrations (`{ id, collection, up }`): `list`/`check` (pending/applied), `apply` (also `dry`) — applies every migration to every document and every stored language exactly once, logs to a ledger | `KestrelError<"CONFLICT" \| "TRANSIENT" \| "MIGRATION_FAILED">` — `MIGRATION_FAILED` (500) carries `details: { migration, document, locale?, problems? }` | `default` (on content, persistence, events; validate optional) |

`blobstore@1.move(from, to)` against a missing `from` key fails with an error message that
contains `not found` (pinned by the contract test) — an adapter must not let a technical error
(e.g. `NoSuchKey`) through untranslated.

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
(`references_index`): `references.check:<type>` before `content.create/update` (the target must
exist), `references.index:<type>` afterwards and `references.unindex:<type>` after
`content.remove` maintain the index, `references.guard:<target>` reads it before deletion (409),
`references.scan` marks broken references via cron, `references.report` lists them,
`references.rebuild` rebuilds the index from scratch. Targets are declared by its config:
content types by name, everything else (media) by persistence collection.

Two origins are indexed, distinguished by the `via` field of each index row: `"field"` for
`ref` fields, `"body"` for internal references **inside the block tree** — every
`kestrel:<type>:<id>` and every `{ type: "internal", collection, id }` inside a `json` field
(all languages), i.e. exactly what `site.resolveLinks` later rewrites into paths. A `<type>`
that is not a configured target is ignored. The deletion guard therefore also sees media and
pages that are only used inside a block. `references.referrers`/`referrersMany`/`report`
include `via` in their output; rows from before the field existed read as `"field"`.

**i18n** is part of the model, not a module: `localized` fields are stored per language,
`required`/`unique` apply per language. Reading with `locale` is **strict** — a missing
translation is `null`, the frontend decides what to do. `fallback: true` (step argument
`?fallback=true`) fills in from `defaultLocale` and names the origin per field in `_locales`.
Website routing is not `content@1`'s job but `site@1`'s (`site-default`, activated after
`content-default`): `site.resolve:pages?home=home&status=published&fallback=true` on a
wildcard route (`GET /site/*path`): `/`, `/<slug>`, `/<lang>`, `/<lang>/<slug>` — the primary
language without a prefix. Translation *workflow* (missing translations, per-language approval)
will later be a steps-only module.

**Status** is an `enum` field the consumer defines. The rule "public only shows published" is a
pipeline concern: `content.list:pages?status=published` — a fixed filter in the step argument
that the client cannot override.

A type only becomes its own module once it needs *behavior* (media: upload into `blobstore@1`).
Noted for later: custom field types defined by the consumer (needs a registration mechanism).
