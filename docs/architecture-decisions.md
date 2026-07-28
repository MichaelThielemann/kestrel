# Architecture Decisions

Lightweight ADR log — newest first. Each entry: **Context · Decision · Consequences · Future**.

## ADR-0004 — A real typecheck gate (`pnpm typecheck`)

**Status:** accepted.

**Context.** vitest and `nuxt build` both compile with esbuild — no type analysis — so type-class bugs
could reach `main` undetected (e.g. a helper's return object used as a string index: a runtime no-op only
caught by review). A real `tsc` pass surfaced two genuine defects — `FieldDef`'s open consumer arm made
`type` a non-discriminant, so no `f.type === 'x'` narrowing worked anywhere, and runtime-built tables were
typed `Record<string, never>`, breaking every Drizzle call — plus a wave of noise from Nuxt's
`noUncheckedIndexedAccess` default, which the project had never opted into.

**Decision.**
- Fix the two real defects: a generic `FieldTypeDescriptor<T>` gives each built-in descriptor its specific
  arm (`FieldOf<T>`); a `fieldIs(field, 'x')` type-guard restores narrowing at the call sites the open arm
  broke; runtime-built columns are typed `Record<string, AnySQLiteColumn>` (the honest shape). Both are
  type-only changes.
- Turn `noUncheckedIndexedAccess` off (in both `typescript.tsConfig` and `nitro.typescript.tsConfig` — Nitro
  generates the server tsconfig separately and must be set too). It was an unopted-into Nuxt default, not a
  project choice.
- The gate covers the full app, `.vue`, and server, tests excluded: `pnpm typecheck`
  (`scripts/typecheck.mjs`) prepares the playground (engine layers + both extensions + a consumer app) and
  runs two passes — `vue-tsc` over the app/`.vue`/config aggregator, `tsc` over the Nitro server project.

**Consequences.** Type regressions across app, `.vue`, and server now fail one gate. `typescript.tsConfig`
is not inherited from an extended layer, so a consumer composing `extends: ['@thielemann/kestrel', …]`
repeats the `noUncheckedIndexedAccess: false` override in their own config. A few intentional `as`-casts
remain at the Drizzle dynamic-table seam (`crud.ts`, `buildCollection.ts`) — the honest price of a
runtime-built schema.

## ADR-0003 — Reference integrity: precise invalidation, warned-stale references, unique slugs

**Status:** accepted; revised once after the initial version left a gap (see Revision below).
Full treatment: [reference-integrity.md](./reference-integrity.md).

**Context.** The runtime publisher re-renders static pages on content writes. A write to record *A* can
affect *A*'s own page, listing pages that query *A*'s collection, and explicit referrers that link/embed
*A*. The naive options are both wrong: re-render everything on every write (a cascade — slow, and
partially-built output mid-flight), or re-render only *A* (stale listings + dangling links). There was
also a data hazard: nothing stopped two records from claiming the same URL.

**Decision.**
- **Precise, per-event invalidation.** Capture, per published route, the data tags it read — `<coll>` for
  a listing, `<coll>:<id>` for an explicit referrer — in a durable `publish_deps` index (survives
  restarts). A write maps its changed tags back to exactly the affected routes: freshening (content/path
  change) re-renders listings and referrers; availability changes (publish/unpublish/delete) re-render
  listings **and referrers**, so a referrer is never left pointing at a stale live URL.
- **Links to a missing or draft target render `#`**; only a resolved, published target gets its real path.
- **Stale references are warned, not silently allowed.** A durable `record_refs` index over all reference
  types feeds dead-reference warnings, derived on read (so they auto-clear) — a list badge, page-builder
  markers, a `/admin/references` report, and a pre-delete "N records link here" check.
- **Output ≡ DB, pruning always-on** (no toggle): a record's own artifact is rendered when published and
  pruned when unpublished/deleted, on every target; a media delete prunes the original + all derivatives.
- **Slugs: required + auto-generated + globally unique per resolved route.** A blank slug is slugified
  from the title; uniqueness is on `localePath(path, locale, …)` across all pageLike collections (one
  route = one file). Enforced app-layer; the per-table `(path, locale)` index stays a within-collection
  backstop.

**Consequences.** A write re-publishes the minimum; the site is never half-rebuilt. Availability changes
re-render more pages than a naive per-record model — bounded by the durable `publish_deps` index, still
far short of a full cascade. Slug enforcement is a behaviour change (a blank path used to mean "no URL";
it now auto-generates).

**Revision.** The first version took the cheaper option on two points: a link always rendered its target's
real path (so publishing later needed no re-render), and availability changes only re-rendered listings,
not referrers. That traded a *correct* referrer for a *cheap* one — an unpublished/deleted target left its
referrers pointing at a dead URL indefinitely, and a draft target's real path was a public 404 until it
went live. The decision above (dead/draft → `#`, availability re-renders referrers too) closes that gap;
the cost is a wider — but still bounded — re-render on availability changes.

**Future.** A reverse-index-backed "what links here" graph view; optional incremental re-render of
referrers behind a flag for sites that prefer freshness over build cost.

## ADR-0002 — Collection-derived DB schema with a runtime sync engine

**Status:** accepted — supersedes a static, consumer-facing drizzle-kit workflow.

**Context.** Kestrel ships as an installable Nuxt layer — the *consumer* defines collections
(`defineCollection`), so the table set is dynamic and unknown at Kestrel's build time. The static
drizzle-kit model (committed `schema.ts` + committed SQL migrations) can't cover collections it never
sees.

**Decision.**
- Schema is derived from collections (`buildTable(def)` → Drizzle table). Read the desired shape via
  `getTableConfig()`, introspect the live DB via `PRAGMA`, then diff → DDL. A thin sync engine over
  drizzle-ORM metadata handles consumer-defined collections without drizzle-kit.
- **Dev auto-syncs at boot; prod applies schema explicitly via `kestrel db migrate`** (boot never
  auto-DDLs destructively in production) — mirrors Prisma's push/deploy split.
- **drizzle-kit is retained** for Kestrel's own built-in collections' committed migrations;
  `drizzle.config.ts` reads the same `kestrel.config.ts` as the app, so migrations and the runtime target
  one DB.
- **SQLite-first behind a `Dialect` interface** — Postgres is a defined but unimplemented slot.

**Consequences.** Define a collection, a table appears — no consumer-side migration authoring. The risk
surface is schema diffing: additive changes auto-apply; destructive/rename changes are gated (a rename
looks like drop+add — data loss risk); SQLite's ALTER limits force a table-rebuild for drop/rename/type
changes. Block content stays JSON (one column), keeping the diff surface small.

## ADR-0001 — Password hashing: native `scrypt`, not an Argon2/bcrypt addon

**Status:** accepted.

**Context.** Single-user admin auth; the repo stays slim (minimal compiled/native deps). Node ships a
memory-hard KDF (`crypto.scrypt`) built in — it does **not** ship Argon2. Both bcrypt and Argon2 require a
compiled native addon.

**Decision.** Hash with the built-in `node:crypto` scrypt (`N=2¹⁷, r=8, p=1, keylen=64`), stored
self-describing as `scrypt$N$r$p$salt$hash` (base64url). No third-party hashing dependency.
`scripts/hash-password.mjs` is only the operator one-liner that emits this exact format — it is **not**
used at runtime (the runtime path is `layers/auth/server/utils/password.ts`).

**Consequences.** Zero dependency / zero supply-chain surface for auth. `scrypt@2¹⁷` is far more than
enough for one admin login. Trade-off: Argon2id (the PHC winner, more tunable) is not used today.

**Future (multi-user / multi-role).** Argon2id is a clean drop-in when we get there — *because the stored
hash is self-describing*:

- `verifyPassword` already branches on the leading `scrypt$` tag. Add an `argon2id$…` branch (e.g.
  `@node-rs/argon2`, a prebuilt native addon — no node-gyp build step).
- New/changed passwords write `argon2id`; existing `scrypt` hashes keep verifying. On a successful login
  against an old scrypt hash, transparently re-hash to argon2id (**rehash-on-login**). No forced reset.
- I.e. algorithm-agility is already latent in the hash format; the swap is **additive**, not a migration.
