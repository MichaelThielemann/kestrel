# Testing and conventions

The rails every change runs against: TDD, the branch/merge convention, which runner picks up which test
file, two gotchas in the Nuxt test environment, what the architecture test suite proves, the mutation
thresholds, and the repo-only tooling.

## Workflow

- **TDD, mandatory** — failing test → confirm it fails → implement → confirm pass → commit. Writing the
  implementation first and backfilling a test afterwards does not satisfy this: the point is watching the
  test fail for the right reason before making it pass.
- One feature = one branch off `main`, fast-forward-merge back, delete the branch. Conventional Commits.
- See [configuration.md](../guide/configuration.md) for the single config source (`kestrel.config.ts`) and
  the env → config → default precedence tests exercise against.

## Test runners

Under `layers/`, `test/`, `app/`, `server/`, and `extensions/`, which runner picks up a file is decided by
its suffix:

| Suffix | Runner | Config | Command |
| --- | --- | --- | --- |
| `*.test.ts` | Node | `vitest.config.ts` | `pnpm test` |
| `*.dom.test.ts` (under `layers/`, `app/`, `server/`, `extensions/`) | happy-dom | `vitest.config.ts` | `pnpm test` |
| `*.nuxt.test.ts` | Nuxt test environment | `vitest.nuxt.config.ts` | `pnpm test:nuxt` |
| `test/e2e/*.test.ts` | End-to-end | `vitest.e2e.config.ts` | `pnpm test:e2e` |

`pnpm test` (`vitest run`) runs the default set. A `*.dom.test.ts` file placed outside those four root
directories (for example directly under `test/`) matches no project's `include` and silently never runs.

`packages/**` is a separate territory: `pnpm test`'s root config never scans it. Each `packages/*` has its
own `vitest.config.ts` (`include: ['test/**/*.test.ts']`, with `typecheck` enabled, so type-level
assertions count) and its own `test` script. Run every package's suite with `pnpm test:packages`
(`pnpm --filter "@kestrel/*" -r test`); a test added under `packages/*/test/` and only checked with
`pnpm test` silently never runs, the same trap as the `*.dom.test.ts` case above.

## Two gotchas

**happy-dom does not render teleported widgets.** Smoke-test that a teleported component is present; test
its load-bearing logic in a plain unit function instead of asserting on the teleported DOM. This is a
blanket rule for teleported content in general — see [admin-ui.md](./admin-ui.md) for the widgets that are
exceptions (`UiDialog` renders in place; richtext is driven through its exposed `editor` object instead).

**`mockNuxtImport` applies before Nuxt boots.** A mock that replaces a composable Nuxt itself uses also
starves Nuxt's own plugins — replacing `useRuntimeConfig` wholesale costs the router its `app.baseURL`, so
every later `useRouter()` in the file comes back `undefined`. The mock factory receives the original
implementation as its argument — call that, not the auto-imported binding, and override only the keys
under test:

```ts
mockNuxtImport('useRuntimeConfig', original => () => {
  const config = original()
  return { ...config, public: { ...config.public, someFlag: true } }
})
```

Separately: any Nuxt composable needs an active Nuxt instance in context, which exists only inside a test
body or a hook — module scope and `describe` bodies run before it, so calling one there throws Nuxt's
diagnostic `E1001` ("called outside of a plugin, Nuxt hook, Nuxt middleware, or Vue setup function").
Call it inside a test or a hook instead.

## The architecture test suite

`test/architecture/**` is a fixed set of tests that assert structural properties no unit test covers —
some read `graphify-out/graph.json` directly rather than re-deriving the import graph. That file is
generated locally (`graphify update .`), not committed, so it must exist and be current before these tests
run — a stale graph makes them assert against stale edges, and a missing one fails them outright. They run
as part of the default suite, or individually:

```bash
pnpm vitest run test/architecture/layer-edges.test.ts
pnpm vitest run test/architecture/pipeline-invariants.test.ts
```

- **Ownership** — two halves of the same guarantee, over the same tables (see
  [layers-and-packages.md](./layers-and-packages.md) for the module file sets). `ownership-graph.test.ts`
  asserts, from the import graph, that no file outside a module's own file set imports that module's table
  object. `ownership.{content,media,publishing}.test.ts` asserts the runtime half: a `<Module>Db` adapter
  rejects any statement — Drizzle call or raw SQL — that touches a table outside its ownership manifest
  (dev/test only). Per-collection content tables are registered dynamically, so only the runtime tests can
  see those; the graph test covers everything with a static table-object export.
- **Layer edges** — `layer-edges.test.ts` checks every cross-layer import against an explicit allowlist
  (`test/architecture/edge-allowlist.json`), so a new dependency between layers is a deliberate, reviewed
  addition rather than a drift nobody noticed. A second block in the same file checks package boundaries:
  no `packages/*/src/**` file imports a layer, and no layer file reaches past a package's public entry
  into its `src/` by path.
- **Pipeline invariants** — `pipeline-invariants.test.ts` boots the real registered pipelines and asserts
  properties every write pipeline must hold: every create/update pipeline reaches `persist` only after
  `validate` (deletes carry no body to validate, so they're exempt), `emitEvents` always follows `persist`
  on every write pipeline, every expected pipeline carries an access gate, no non-sync step sits between
  the first and last sync step of a composed pipeline, and every after-step marked `critical` is named in
  an `## ADR-NNNN` section of [decisions.md](./decisions.md) — the suite hard-asserts the known critical
  step `writeRedirects` so this cannot pass on an empty set.
- **Perf budgets** — `perf-budget.test.ts` runs each standard op (`createOne`, `readMany`, `duplicate`, …)
  against a seeded fixture DB and asserts its p95 stays under the ceiling in `perf-budget.json`. The test
  only compares p95 to that number; the requirement that loosening a budget needs an ADR entry is a review
  convention recorded in the file's own `_note`, with an `_adr_<op>` key naming the ADR — nothing in the
  suite checks for it.
- **Derived-rebuild** — see "Derived state, proved by CI" below.
- **Docs hygiene** — `docs-hygiene.test.ts` scans every Markdown file under `docs/guide/`, `docs/internals/`,
  `README.md` and `SECURITY.md` for internal work-program vocabulary that must never reach a reader,
  checks that `docs/guide/**` names only exported API (no ADR numbers, no source paths), and resolves
  every relative link and `#anchor` against the target file's real headings.

## Derived state, proved by CI

Some server state is not a source of truth — it is fully reconstructible from data that is: the
`record_refs` reference index, publish output (rendered HTML, sitemap/robots/redirects), the `publish_deps`
route→tag index, and media derivatives. Each one's kill-switch and rebuild entry point is tabulated in
[layers-and-packages.md § Derived](./layers-and-packages.md).
`test/architecture/derived-rebuild.test.ts` seeds real state for
each one, destroys it, runs the real rebuild entry point (`rebuildRecordRefs`, `publishFull()`,
`runBackfill()` — never a parallel test-only reimplementation), and asserts the result matches what was
destroyed: row-equal for `record_refs`, and structurally equal (manifest
shape, files present and non-empty) for media derivatives, since re-encoding is not byte-stable across runs
by contract. `publish_deps` goes through the production `DepsPersistence` port: the test wipes the
persisted table, rehydrates a fresh `DepsStore` from it to prove the kill found nothing, reruns
`publishFull()`, and asserts the persisted table and the in-memory index are both row-equal to the pre-kill
snapshot. Publish/meta is byte-identical, but only because the render transport (`nitropack`'s
`localFetch`, unavailable outside a running Nuxt server) is stubbed, with per-route content still a
deterministic function of the route — it isn't an end-to-end render proof. It's wired into the default
`pnpm test` run.

## Mutation testing

A passing test suite that never kills a mutant is verifying nothing, but mutation testing here is done
with local tooling that is not part of this repository — there is no `pnpm` command a clone can run for it.

## Working on the repo's own schema

The repo ships committed `drizzle-kit` migrations and also runs the dev auto-sync, so on an existing
in-repo dev database a generated `CREATE TABLE`/index can collide with an object the auto-sync already
created. Write new tables/indexes in a hand-checked migration idempotently
(`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`), or reset the SQLite file `kestrel.config.ts`'s
`db` points at (`.data/dev.sqlite` in this repo) before applying, so boot-time `00.migrate` doesn't fail on
an already-present object.

## Repo-only tooling

Commands for maintaining this repository itself, not for consumers of the published package (the
release/API-surface ones live in [releasing.md](./releasing.md)):

- **`pnpm dashboard`** — renders the same `renderDashboard()` the dev-only `GET /__kestrel/dashboard` route
  uses (`import.meta.dev`-guarded, 404 in production), as a static `docs/dashboard.html` (gitignored,
  regenerate any time), by booting the same registries the architecture tests do. No dev server needed.
  The static build additionally folds in a repo-only graph section — the edge allowlist and API-surface
  ceilings — that the live route never renders.
- **`pnpm test:coverage`** (`node scripts/coverage-all.mjs`) — runs the root suite plus each per-package
  suite and merges the results into `reports/coverage/coverage-final.json`. Exits non-zero if any suite
  fails, but still writes the merged artifact.

## See also

- [architecture.md](./architecture.md) — the layer model and pipeline engine these tests hold in place.
- [decisions.md](./decisions.md) — the ADRs referenced from pipeline invariants and perf-budget overrides.
- [../guide/configuration.md](../guide/configuration.md) — the single config source these tests boot
  against.
