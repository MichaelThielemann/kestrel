# Architecture Decisions

Lightweight ADR log — newest first. Each entry: **Context · Decision · Consequences · Future**.

## ADR-0009 — CMS-managed redirects publish an artifact on save, through a fail-able write effect

**Status:** accepted.

**Context.** Editors need to manage SEO redirects, and a redirect has to go live without a deployment —
the whole point of a redirect is that someone is already hitting the old URL. Kestrel has no live public
SSR, so it cannot serve the 30x itself; the edge (NGINX/njs, CloudFront) has to, from a small artifact
Kestrel publishes. That artifact is only useful if it is never behind the database: an editor who saw a
green save and a stale edge is exactly the failure mode this feature cannot have.

Nothing in the write path could express that. `registerWriteListener` is fire-and-forget **by design** —
`emitWrite` wraps every listener in a `try/catch` so a publishing failure can never break a content write
— and it is synchronous, so an async rejection escapes as an unhandled rejection instead. The obvious
alternative, a dedicated `PUT /api/redirects` route shadowing the generic `/api/[collection]` one, was
tried and rejected on evidence: registering a static `/api/redirects` node in the router **steals the
whole `/api/redirects/**` subtree**. h3's per-method fallback does find the generic handler for a `GET`,
but `event.context.params` comes from the originally matched (static) node, so `collection` is
`undefined` and the singleton's load 404s; every sub-path stops resolving altogether. Media only gets
away with a partial static directory because its admin UI is bespoke and never calls the generic
sub-routes.

**Decision.**
- **A second, narrow seam in core: post-write EFFECTS** (`write-effects.ts`), awaited by the singleton
  PUT route, whose rejection becomes the save's error response. Effects sit beside the listener bus
  rather than changing it: the invariant that a publish failure must not break a content write is worth
  keeping, and the redirects artifact is the case where the opposite is true.
- **Deliberately only the singleton PUT runs effects.** Widening them to create/update/delete would make
  every content write fail-able, which is the invariant the listener bus exists to protect.
- **A save is not atomic with the artifact, and the message says so.** The row is committed before an
  effect runs (better-sqlite3 writes are synchronous and CRUD holds no transaction), so a failed write
  means "saved, but the edge still serves the previous rules — press Save again". Writing the artifact
  first would only invert the divergence; there is no transaction spanning SQLite and S3. The retry has
  to actually work, so the failing PUT hands the committed row's new `updatedAt` back in the error and
  the editor takes it as its baseline — otherwise the optimistic-concurrency precondition refuses the
  very save the message asks for, deterministically rather than as a race.
- **The wildcard→regex translation happens in Kestrel, not at the edge.** `redirects.json` carries
  compiled, anchored regex source strings, so the njs handler only matches and substitutes. Editors never
  write a regex; `*` is one path segment, `**` is one or more.
- **A rule that cannot compile is a pre-write 400, not a post-write error.** That needed a whole-record
  validation seam (`CollectionDef.validate`), because a Zod field validator sees one field at a time and
  cannot tell that `to: '/x/$2'` needs a second wildcard in `from`. Without it an unpublishable row could
  be stored, then fail every later publish and the prerender of `/redirects.json`.
- **The artifact is also produced at build time**, exactly like `sitemap.xml`/`robots.txt`/`llms.txt`: a
  route, a prerender seed, a re-render on every full publish, and an exclusion from the build-asset
  mirror. Not redundancy — a build-time S3 deploy reconciles the bucket against `.output/public` and
  would otherwise prune a save-time key as stale. The four lists that used to spell those names out are
  now one `META_KEYS`.
- **An empty rule list publishes `[]`.** Zero redirects is a supported state, not an absent file; the
  edge must be able to tell it apart from a failed fetch, which it has to survive by keeping its last
  good list.
- **A capture is untrusted input, so the PATTERN is the guard.** `normalizeTarget` can only vouch for
  what the editor typed; `$n` is spliced in from the request. The emitted character classes therefore
  exclude a backslash and the control characters that split a header, and forbid a `**` capture from
  starting with `/` — so `/\evil.com/shop/x` and `/blog//evil.com` do not match at all rather than
  producing an off-site `Location`. A placeholder inside an absolute target's host is rejected at
  authoring time, since no character class can fix where `$n` sits.

**Consequences.** Consumers need a `db:migrate` for the new (additive) `redirects` table. The artifact
lands at the output **driver's** root — `output.dir` locally (`.data/published/` by default), the
configured prefix on S3 — as a sibling of `index.html`, not "alongside `published/`"; the local driver
refuses a key that escapes that root. Save-time publishing only reaches the live site where that target
is what the site is served from (`output.auto: true`, or `auto: false` + `driver: 's3'`); in the classic
`auto: false` + local build model the deployed tree is `.output/public` and a redirect goes live with the
next `nuxt generate`. Redirects are global, not per-locale. `redirects.json` is inert until an edge reads
it; the NGINX/njs side is deployment infrastructure and lives with the deployment.

**Future.** The editor has no per-field help text (`BaseFieldDef` has no `help`), so the priority rule
and the wildcard syntax ride along in the field labels. A real `help` affordance is its own slice. Also
open: per-row error addressing inside a repeater (a server issue at `['rules', 2, 'to']` currently
collapses onto the repeater's legend, which is why every message names its row in prose), and metrics
for redirect hits beyond the edge's access log.

## ADR-0008 — Saving and publishing are two actions, and previewing is neither

**Status:** accepted.

**Context.** Until now a save WAS a publish. `registerWriteListener` classified every content write and
enqueued an incremental republish, so editing a published page put the edit on the live site seconds later,
with no step in between. The only way to work on a live page without the work being live was to unpublish
it first — which takes the current page offline, the opposite of what an editor wants. The editor's
open-in-new-tab button made the gap visible: it opens the record's saved URL, so the tab shows the last
saved state and looks like nothing happened (it never saved anything — verified), while the in-editor
iframe shows unsaved content over postMessage. Two previews, two different answers.

**Decision.**
- **A save writes the DB; publishing writes the static output.** The write listener plans through
  `planWrite` → `planSaveInvalidation`, which passes through only what a save must still REMOVE — an
  unpublished or deleted record's page. Everything renderable waits for `POST /api/publish`, which plans the same invalidation the
  write listener used to (`planInvalidation`) and enqueues it on the same queue.
- **Removal stays immediate, and that asymmetry is the point.** A page that was unpublished or deleted must
  not stay live while its record says otherwise; a page whose *content* changed is still a page the site can
  legitimately serve, in its last published version. Losing content is recoverable, serving withdrawn
  content is not.
- **Every publish holds back routes with unpublished changes — full and incremental alike.** Re-rendering
  from the DB pushes whatever the DB currently holds, so any render of a route whose record has moved on
  publishes work nobody released. That reaches further than the boot publish: an incremental publish renders
  every route matching the invalidation's tags, and since each page reads the `site` singleton, publishing
  site settings would otherwise flush every withheld edit on the site at once. So a route whose record
  `updatedAt` is newer than its `publish_status` row keeps the file its last publish wrote, wherever the
  render was triggered from. The route a publish was explicitly FOR is exempt — pressing Publish is what
  clears the withholding.
- **Withholding is keyed to the record, not the route string.** A rename moves the string, so the new route
  has no `publish_status` row of its own; keyed by route it would slip through the never-published carve-out
  below, publishing the unpublished rename *and* pruning the old URL that is still the live one. A record's
  previously-published routes are consulted instead, and protected from the prune while it is held.
  A record with no prior published route keeps the carve-out: on a first deploy there is no older version to
  protect, and holding it would produce an empty site.
- **A held route is frozen whole, links included.** It keeps the baked links and hreflang of its last
  publish, so a link to a page that has since been unpublished stays stale until the referrer is itself
  published. That is the accepted cost: a route serving one publish generation throughout is more coherent
  than a file mixing an old body with fresh links, and the alternative — rendering the published body while
  resolving current links — needs the per-record snapshot named under *Future*.
- **The record's `status` is unchanged** — it still means "may be public" and still gates the resolver, the
  sitemap and link resolution. What changed is only WHEN the file is written. The Publish button promotes a
  draft on the way, because pressing it is the publish intent.
- **Previewing unsaved changes uses a ticket, not a save.** `POST /api/preview` puts the editor's current
  form body in a short-lived, admin-only, session-bound in-memory store and returns a token; the tab opens
  `<url>?kestrel-preview-token=…` and the page lays those values over the stored record. Nothing is
  written, and the ticket is populated server-side on read so images and internal links resolve exactly as
  they do on a real page. A record with no public URL previews on the existing `/__kestrel/preview` page.
- **One switch back, not a mode matrix.** `output.publishOnSave: true` restores the pre-2.0 behaviour in
  one place — the write listener's planner (`planWrite`) — and everything downstream reads that same flag:
  a full publish stops holding routes back, `/api/publish-status` stops reporting unpublished changes (with
  the split off, "saved since the last publish" means a republish is in flight, not something to act on),
  and the editor hides the Publish button. The ticket preview is unaffected: previewing without saving is
  useful in both models.

**Consequences.** The editor gains a second lamp state — "Outdated": saved, published, but the live file is
an older version. That is now the normal state of a page being worked on, so it is amber, not red. A
consumer who relied on "save = live" must press Publish (or run the `publish:run` task); the CHANGELOG
calls this out as the one behavioural break. `nuxt generate` is unaffected and still renders whatever the
DB currently holds — it is a build of the whole site, not the incremental publisher, so a generate-based
deploy publishes unpublished edits along with everything else.

**Future.** Real versioning (a published snapshot per record) would make "publish" restorable and let a
full publish rebuild the exact published state rather than holding routes back. The ticket store is
per-process by design; a multi-instance deployment would need a shared one, or a sticky session.

## ADR-0007 — A `site` singleton for the site-wide half of the page head

**Status:** accepted.

**Context.** Kestrel already owns the public `<head>` — the catch-all emits canonical, hreflang, `og:*`,
`twitter:card` and `robots` through `buildPageHead`. What was missing is the tier above the page. The
per-page `seo` group is a closed set (`title`, `description`, `noindex`, `image`), and `siteName`/`siteUrl`
are config-only, so a site-wide description, a base title and a fallback social image had nowhere to live.
That asymmetry was the defect: `description` is site-wide in exactly the sense `siteName` is.

Config could not be the answer for editorial values. Non-auth `KESTREL_*` is read once at Nuxt module setup
and frozen into `runtimeConfig`, so changing a base title would mean a rebuild triggered by hand. A write to
a collection re-publishes the affected routes on its own, through `captureRead` → publish deps →
`routesForTags`.

**Decision.**
- A **translatable single collection `site`**, `builtin: true` so a consumer can switch it off, holding only
  the counterparts of the per-page group plus the title composition. It lives in `layers/public`, the layer
  whose render consumes it. `siteUrl`/`siteName` stay in config, because the build needs them for canonical
  URLs, the sitemap and `robots.txt` and therefore cannot read them from the DB.
- **Not** named `settings`. Collection files dedupe by basename with the consumer winning, and shadowing
  replaces a whole definition rather than merging fields — a consumer defining its own `settings.ts` would
  silently lose everything the built-in contributed.
- **The precedence chain sits before `buildPageHead`, not inside it.** That function already receives
  `title`/`description`/`image` resolved, so widening its signature would have churned a pure function with
  full test coverage for nothing. Two small pure functions (`composeTitle`, `siteHeadFallbacks`) do the
  merge, and each is unit-testable on its own.
- **Only `<title>` is composed.** `og:title` keeps the bare page title, because `og:site_name` already
  carries the site — emitting the composed string in both would duplicate the site name in every share
  preview.
- **A page title that already ends in the base title is left alone.** Migrated content routinely carries the
  site name in the page title, and appending it again reads as a bug to everyone who looks at the tab.
- **The separator is stored as a bare token and padded at render.** A `text` field trims on write, so a
  stored `" | "` comes back as `"|"` and glues the two titles together. Found by the e2e, not by reasoning:
  the first run rendered `Pricing·Acme Docs`.
- The row reaches the render **on the fetch the page already awaits** — `/api/route` returns it alongside
  the resolved page. That path is public-safe, already runs per route, and demonstrably survives
  `nuxt generate`; a second endpoint would have been a second thing to keep working under prerender. It is
  looked up through the registry rather than imported, so a consumer who disables the collection gets `null`
  instead of a query against a table the schema never created.

**Consequences.** With an empty row every fallback is absent and the emitted head is what it was before, so
existing projects upgrade silently — `site.test.ts` pins that every field stays nullable. A site edit
re-publishes the routes that embedded it, for free, because `getSingleton` captures the read. One visible
side effect: the row now rides in every page's hydration payload, so a site-wide description is present in
the HTML even on pages that override it — public content either way, but it means an assertion about the
document is not an assertion about the meta tag.

**Future.** Per-collection defaults or per-locale social images extend the same chain rather than adding a
second mechanism. The chain is the contract; the fields are not.

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
