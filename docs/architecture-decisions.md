# Architecture Decisions

Lightweight ADR log — newest first. Each entry: **Context · Decision · Consequences · Future**.

## ADR-0006 — A page picks its layout, and the page owns the `<NuxtLayout>`

**Status:** accepted.

**Context.** A consumer needed its legal pages rendered without the consent SDK its layout injects
unconditionally — the kind of per-page template choice every CMS offers and Kestrel had no answer for. There
was no per-record layout concept: `CollectionDef` carries `fieldLayout` (admin editor rows) and `editor`
(which admin body component), both admin-only. The public catch-all set no `definePageMeta({ layout })` and
`layers/public/app/app.vue` renders `<NuxtLayout>` with no `name`, so the layout always came from route meta
that nothing ever set.

The obvious alternatives are each closed. A second layout selected at runtime needs `setPageLayout()` or
`<NuxtLayout :name>` in `app.vue` — and that prop *wins over route meta*, so it would strip every admin page
of its `layout: 'admin'`. `definePageMeta` is a compile-time macro and cannot read a DB value.
`routeRules.appLayout` exists but freezes into the build, while `output.auto` means the runtime publisher
outlives it, so an editor's change would need a redeploy. The `seo` column cannot carry it either:
`seoSchema` is a closed `z.object`, so an extra key is stripped on save — a silent data loss.

**Decision.**
- A nullable `layout` **system column**, gated on `pageLike` like `path` — not a field on `pages.ts`.
  Collection files dedupe by basename with the consumer winning, so a consumer shadowing `pages.ts` would
  *drop* a field-based column and turn it into a destructive `rebuild_table` that both gates withhold. A
  system column follows any shadowing def that keeps `pageLike: true`, and covers a consumer's own pageLike
  collections too.
- The column is **deliberately not an enum** of the discovered layouts. The edit form re-sends every key on
  every save, so an enum would 400 every future save of a page whose layout file was later deleted — locking
  the record out of the admin. An unknown name degrades at render instead.
- The catch-all declares **`definePageMeta({ layout: false })`** and renders its own
  `<NuxtLayout :name fallback="default">`. Without `layout: false` both layouts nest.
- The resolver **coalesces every empty form to `default`**, and this is the subtle part: `layout: false`
  makes `route.meta.layout` the literal `false`, and NuxtLayout resolves `props.name ?? route.meta.layout`,
  where `??` keeps `false`. Passing an unset column through as `undefined`/`''` therefore renders the page
  with *no layout wrapper at all*, and `fallback` does not rescue it — it only applies to a truthy name
  missing from the layout map. Verified against prerendered output, not reasoned about.
- **Discovery reuses Nuxt's own resolution.** Nuxt already collects `app/layouts/*.vue` across the layers
  with the same name-first, consumer-wins dedup and fills `app.layouts` just before `app:resolve`, which
  runs inside `generateApp` ahead of template writing. So the module reads that map rather than scanning,
  filters out the `admin` shell, and emits a build-time constant. No `collectLayoutSfcs` sibling.
- The select **hides itself below two layouts**: a project with only `default` has nothing to choose. Its
  fallback entry stores `NULL`, never `''` — an unset value must stay distinguishable from a failed save,
  and `default` is not offered as its own value because an unset column already means it.

**Consequences.** A page's layout is editorial data, so changing it re-renders that route through the
existing invalidation path with no new plumbing. Existing projects are unaffected: the column is nullable
and additive, and a single-layout project sees no new control. One deliberate limit — the layout hangs per
**row**, not per translation group, so each locale is set independently.

A side effect worth more than the feature in some projects: the layout is now a **child** of the page rather
than its parent, so `usePublicPageState()` finally holds during SSR. As the parent it rendered before the
page had written the state, which made the composable's contract quietly untrue in static output.

**Future.** If a project wants the choice constrained (only these two layouts for these collections), that
belongs in a validation hook over the same column, not in the column's type — the render-time fallback is
what keeps a deleted layout from blanking a live page.

## ADR-0005 — Two scaffolder entry points over one template, and a build-time app-shell guard

**Status:** accepted.

**Context.** `pnpm add @michaelthielemann/kestrel` produces a project that does nothing. Nuxt does not
auto-load an installed package as a layer, so without a `nuxt.config.ts` that extends it, every route —
`/admin` included — serves the default Nuxt welcome page. Starting instead from `nuxi init` fails more
quietly: its `app/app.vue` renders `<NuxtWelcome />` and no `<NuxtPage />`, and because Nuxt resolves the
app root as `app.mainComponent ||= findPath(layerDirs…)` with the consumer's layer first, that file
shadows `layers/public/app/app.vue`. The router still runs (the URL rewrites to
`/admin/login?redirect=/admin`) but nothing renders, which reads as a missing admin route. A third step
then blocks anyone who gets past those two: sign-in answers 503 until `KESTREL_ADMIN_PASSWORD_HASH` is
set. Three independent, silent gaps between installing the package and reaching the admin — all
documented, none enforced or automated.

**Decision.**
- Ship a scaffolder as a `bin` on the **engine package** (`kestrel` → `scripts/kestrel.mjs`) with the
  template in `templates/starter/`. `bin` resolves by path from the package root, so it coexists with
  `main: './nuxt.config.ts'` and needs no `exports` map (which packaging forbids for unrelated reasons).
- Add a second, unscoped `create-kestrel` package for `pnpm create kestrel my-site`, because that is the
  command people already know from Nuxt and Vite. It carries **no dependencies**: its `templates/` and
  `lib/` are copied in from the engine by `prepack` and removed again by `postpack`, so there is exactly
  one source and drift is structurally impossible rather than merely tested for. From a checkout the bin
  falls back to the engine's paths, so it runs unpacked. Depending on the engine instead would pull the
  ~800-package tree the instant download exists to avoid.
- The two entry points do **not** behave the same, and that is the point: `create-kestrel` refuses a
  non-empty directory and names `kestrel init` as the tool for that case, while `kestrel init` merges.
  A `create-*` command that silently rewrote an existing project would be a footgun.
- The version is **not** rewritten at pack time. npm reads a manifest before running `prepack`, so a
  rewrite reaches the tarball contents but not the registry metadata — verified: the tarball is named
  from the pre-`prepack` version. Instead the two manifests are committed in lockstep, a test asserts it,
  and `prepack` refuses to pack a mismatch. This also keeps release.yml's tag guard meaningful, since it
  only ever reads the root manifest.
- `init` is **idempotent and additive**, because the most common caller is a project that already ran
  `pnpm add`: existing files are kept, `package.json` is merged key-wise with the project's own values
  winning, and `.env` is filled only where a key is absent or empty — re-running never rotates a live
  session secret. It asks once for a new admin password and writes the scrypt hash itself, so the
  documented three-command dance disappears.
- Keeping a file cannot mean declaring success. `init` ends with the `doctor` pass and exits non-zero
  while anything still breaks `/admin` — the `nuxi init` `app.vue` is precisely the case that survives a
  non-destructive scaffold.
- The engine reports the app-shell failure itself, at build time, from the `app:resolve` hook: an error
  when the resolved `app.vue` has no `<NuxtPage />`, a warning when it has no `<NuxtLayout>`. It only ever
  reports — assigning `mainComponent` here would defeat a legitimate consumer override, and the `||=`
  means a module-set value beats even the consumer's own file.
- The template emits `app/app.vue` rather than omitting it. Omitting it is what the layer already handles;
  emitting a *correct* one puts the trap in front of the operator with a comment explaining why both
  wrappers are load-bearing.
- Prerendering is exempt from the `KESTREL_SECURE_COOKIES=false is not allowed in production` assertion.
  `nuxt generate` runs at `NODE_ENV=production` and renders every page through `/api/route`, which passes
  the access guard and so calls `sessionSettings()`; a dev `.env` therefore made each page throw, dropped
  it from the static output, and still exited 0. A prerender request never issues a cookie, so the flag
  has nothing to protect there — the secret requirement still applies.
- Build-time approval of the native dependencies ships as `pnpm-workspace.yaml` with `allowBuilds:`, not
  as `pnpm.onlyBuiltDependencies` in the manifest. Verified: pnpm 11 ignores the manifest form outright
  (`ERR_PNPM_IGNORED_BUILDS`), so `better-sqlite3` and `sharp` never build and the scaffolded app cannot
  start; the workspace-file form is honoured by both pnpm 10 and 11.

**Consequences.** A consumer reaches a working admin in one command, and a broken project gets a named
cause instead of a blank page. The costs are real and permanent. A second publishable package means
another trusted-publisher registration on npmjs.com, a manual first publish (a trusted publisher cannot
be configured for a package that does not exist), a fourth `npm publish` step, and a release that can now
fail between packages. Releases must bump two manifests. And the `app.vue` rule has a second home: the
CLI is plain `.mjs` with no build step, so it cannot import the TypeScript guard, and the check exists in
both `scripts/lib/scaffold.mjs` and `layers/core/modules/kestrel/app-shell.ts` — a test drives both over
the same fixtures so they cannot drift. Two packaging traps are now load-bearing and pinned by tests: the
`files` whitelist's `!**/*.test.ts` negations are global, so nothing under `templates/` may be named that
way, and npm strips a literal `.gitignore` from a tarball *and then applies it*, taking its listed
siblings with it — template dotfiles are therefore `_`-prefixed and renamed on the way out.

**Future.** `kestrel db migrate` — referenced by ADR-0002 but never implemented — now has an obvious home
on this bin. Further template variants (`--template blog`, an extension-composing one) fit the same
`templates/<name>/` layout with no change to the copy mechanism.

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
is not inherited from an extended layer, so a consumer composing `extends: ['@michaelthielemann/kestrel', …]`
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
