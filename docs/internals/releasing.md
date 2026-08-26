# Releasing and dependencies

This page covers how the packages ship to npm, the gates a release must pass, the generated-docs pipeline, and the policy that decides what may enter `package.json`.

## Publishing the packages

A `v*` tag push runs `.github/workflows/release.yml`, which publishes the engine, both extensions, the
scaffolder, and all ten `@michaelthielemann/kestrel-*` packages to npm — the ten packages first, in topological order of
their own `@michaelthielemann/kestrel-*` dependency lists (each one only after everything it depends on), so no installer
racing the tag can land between the engine appearing on the registry and one of its own real dependencies
existing there.

**Adding a package to the release** touches five hand-maintained places, none of them generated from the
others: the `Publish <name>` step in `release.yml` (inserted at its topological position among the
existing steps), the `api:check`/`api:update` scripts in the root `package.json` (each enumerates every
package's `api-extractor*.json` path by hand), the `pkg:lint` script (same enumeration for `publint`/`attw`),
the TSDoc lint block's `files` glob in `eslint.config.mjs`, and the one-time bootstrap publish plus
`npm trust` call described below.

Cutting a release: bump the root manifest and `packages/create-kestrel/package.json` together — the tag
guard below reads only the root manifest, but `create-kestrel`'s own `prepack` refuses to pack a version
that disagrees with it. Bump a `@michaelthielemann/kestrel-*` package's manifest, or an extension's (`extensions/galleries-secure*`
carry their own line, currently at `2.0.0` against the engine's `3.0.1`), only when that package itself
changed. Commit, then tag:

```bash
git tag v3.0.1
git push origin v3.0.1
```

The workflow runs four gates (`pnpm test`, `pnpm test:nuxt`, `pnpm typecheck`, `pnpm build`) — a strict
subset of CI on `main`, not "CI minus e2e": CI also runs `pnpm test:packages`, `pnpm lint`, `pnpm
api:check`, `pnpm generate`, and the separate `consumer-template` job, and tests both Node 22 and 24 where
the release runs Node 24 only. The narrower set is enough because a tag is cut from a commit that already
passed the broader CI run. It then checks that the tag matches `package.json`'s version and publishes.

Authentication is npm trusted publishing (OIDC): no npm token exists anywhere in the repo or org, and the
workflow also produces a provenance attestation linking the tarball to the commit and run. Each package
needs a one-time manual bootstrap publish before a trusted publisher can be configured for it — a package
that has never been published has nothing for npm to attach the trust relationship to:

```bash
cd packages/kestrel-contracts
pnpm publish --access public --no-provenance --no-git-checks
npm trust github @michaelthielemann/kestrel-contracts --file release.yml --repo MichaelThielemann/kestrel --allow-publish
```

`--no-provenance` because every manifest sets `publishConfig.provenance: true`, which only works inside CI.
`--file` is the workflow FILENAME of this repo, not a path — a wrong value is accepted silently and only
surfaces at the next release, as a 404 on PUT that reads like a permissions problem; `npm trust list
<package>` shows what is actually stored. The account needs 2FA; a granular "bypass 2FA" token is rejected.
`npm trust` needs npm >= 11.15, which is also why the workflow installs `npm@latest` first — the runner's
bundled npm may be older than the 11.5.1 trusted publishing requires.

Each publish step runs `.github/publish-if-new.sh`, which skips a package whose exact `name@version` is
already on the registry — a mid-release failure can be re-run without dying on the first already-published
package, and an ordinary engine release republishes only what actually changed: the ten `@michaelthielemann/kestrel-*`
packages version independently of the engine (all at `0.1.0` while the engine is well past that), so most
tags skip most of them. `create-kestrel`, the scaffolder, publishes last; its `prepack` copies the engine's
templates in from the repo root and `postpack` removes them again, and `prepack` refuses to pack a version
differing from the root manifest — the tag guard above compares the tag only to the root manifest, so
`test/create-kestrel.test.ts` is what actually keeps `create-kestrel`'s version pinned to the engine's.

The script calls `pnpm publish`, not `npm publish`: the engine root and most `@michaelthielemann/kestrel-*` packages carry a
real `workspace:*` dependency on another workspace package (`@michaelthielemann/kestrel-contracts` and `create-kestrel` are
the exceptions), and only pnpm's publish/pack step rewrites that to the real resolved semver before upload
— `npm publish` would ship the literal, unresolvable string `"workspace:*"`. What makes a package a real,
independently installable dependency rather than something bundled into the engine is that it is published
at all and the engine's `dependencies` reference it by that resolved semver — `pnpm pack` on the root turns
`"@michaelthielemann/kestrel-core": "workspace:*"` into `"@michaelthielemann/kestrel-core": "0.1.0"`, which 404s on install unless that version
is on the registry. `publishConfig: { access: "public", provenance: true }` only makes public publishing
and provenance possible; it does not itself create the dependency.

## The typecheck gate

`pnpm typecheck` is the one gate that catches type-class bugs neither `vitest` nor `nuxt build` can — both
compile with esbuild, which does no type analysis.

```bash
pnpm typecheck
```

`scripts/typecheck.mjs` prepares the playground (engine layers, both extensions, and a consumer app) and
runs three passes: `tsc` over the Nitro server project, `vue-tsc` (via `nuxt typecheck`) over the
app/`.vue`/config aggregator, and `pnpm --filter '@michaelthielemann/kestrel-*' -r typecheck` over the standalone workspace
packages, whose tsconfigs sit outside the playground project — it is the only pass that type-checks
`packages/*/src` at all. All three always run and the gate fails at the end, so a red server pass never
hides app or package errors. Both app and server tests are excluded. A consumer composing
`extends: ['@michaelthielemann/kestrel', …]` repeats the project's `noUncheckedIndexedAccess: false`
override in their own config — `typescript.tsConfig` is not inherited from an extended layer.

## Generated docs

Documentation of the public API is generated and checked, not hand-written prose trusted on faith.

TSDoc is mandatory on every export of the ten `@michaelthielemann/kestrel-*` packages — the TSDoc lint block in
`eslint.config.mjs` lists each `packages/kestrel-*/src/**/*.ts` glob. Each export documents its purpose,
its error union, its invariants, and carries an `@example`. Two lint plugins enforce it, because neither
covers both halves: `eslint-plugin-jsdoc`'s `require-jsdoc` with `publicOnly` checks that a doc comment
exists, `eslint-plugin-tsdoc`'s `tsdoc/syntax` checks that what is there is valid TSDoc. Missing or
malformed documentation fails the lint gate like any other error.

TypeDoc generates the API reference from those comments, into `docs/api` — a local, gitignored artifact,
not a page under `docs/` that ships with the repo. `typedoc.json` sets
`"treatValidationWarningsAsErrors": true`, so every run of `pnpm docs:api` fails on the narrow validation
class, not the broad `--treatWarningsAsErrors`, which would also trip on warnings unrelated to the
contract. No workflow runs it — `lint` (TSDoc presence and syntax) and `api:check` gate CI and the release,
but `docs:api` and `pkg:lint` below are local commands only:

```bash
pnpm docs:api
```

api-extractor produces the machine-readable `.api.md` report that makes an additive-only API rule
mechanical: a diff that removes or narrows anything is a failing check rather than a review finding. Each
package's report is committed at `packages/<pkg>/etc/<name>.api.md` (e.g.
`packages/kestrel-contracts/etc/contracts.api.md`). `kestrel-core` and `kestrel-fields` each have two —
`core.api.md`/`core-client.api.md` and `fields.api.md`/`fields-client.api.md` — one per entry point.
`pnpm api:check` builds each package and diffs against the committed report; `pnpm api:update` re-runs it
with `--local` to rewrite that file for the commit.

`publint` and `@arethetypeswrong/cli` sit alongside it as cheap checks on package exports and type
resolution — a different error class, not a substitute for the report, and not run in any workflow:

```bash
pnpm pkg:lint
```

OpenAPI is derived, never written by hand: the generator walks the pipeline registry and calls
`JSONSchema.make` on each pipeline's input and output schema, so a spec cannot describe a surface the
engine does not serve. Paths, verbs, gates (as security requirements), and error unions (as response
codes) all come from the same composed pipeline index that `_pipelines` and the request trace read. The
spec is tested against a live server, not a generated file: `test/nuxt/openapi-contract.test.ts` boots a
dev server, logs in as admin, fetches the live document from `GET /api/_openapi`, and asserts every
response against it with `vitest-openapi`'s `toSatisfyApiSpec()`. That file runs under plain `pnpm test`,
not the e2e suite — it matches the root `vitest.config.ts`'s `node` project, which `test/e2e/**` never
reaches.

## Dependency allowlist

New dependencies require a human decision before install. Only a package listed below may be installed.
Adding a row is the decision — it is made by a person, on the record, before the package enters
`package.json`, and it names what the package is for. "On the record" means the row itself: this file,
edited in the same commit that adds the dependency to `package.json`, so the decision and the install
land together in git history. Rows are added by a person; an automated or agent-driven change may not add
one.

`approved` marks a package decided on but not installed yet; it becomes `runtime`, `peer` or `dev` when it
lands. Removing a package removes its row. A transitive-only dependency is not listed — the allowlist
governs direct dependencies chosen anywhere in the workspace: the root manifest, any `packages/*`
manifest, or an extension manifest under `extensions/*`. `playground` is out of scope — it never publishes.

| Package | Scope | Purpose |
|---|---|---|
| `@babel/parser` | runtime | Parses a block SFC's script block in the build-time auto-discovery module. |
| `@internationalized/date` | runtime | Calendar arithmetic behind the date/datetime field widgets. |
| `@tiptap/starter-kit` | runtime | Rich-text editing core for the richtext field type. |
| `@tiptap/vue-3` | runtime | Vue bindings for the Tiptap editor. |
| `@tiptap/pm` | runtime | ProseMirror peer bundle Tiptap builds on. |
| `@tiptap/extension-highlight` | runtime | Richtext mark: highlight. |
| `@tiptap/extension-subscript` | runtime | Richtext mark: subscript. |
| `@tiptap/extension-superscript` | runtime | Richtext mark: superscript. |
| `@tiptap/extension-text-align` | runtime | Richtext node attribute: text alignment. |
| `@types/better-sqlite3` | runtime | Types for the database driver; shipped because consumer type-checks need them. |
| `@types/jsdom` | runtime | Types for the server-side DOM used by richtext sanitizing. |
| `@types/node` | dev | Node builtin types for nine `@michaelthielemann/kestrel-*` packages' standalone `tsc` builds. |
| `@types/sanitize-html` | runtime | Types for the sanitizer. |
| `aws4fetch` | runtime | SigV4 signing for the S3 output and media drivers, without the AWS SDK. |
| `better-sqlite3` | runtime | The database. Synchronous writes are what make the critical section race-free. |
| `dompurify` | runtime | Sanitizes richtext HTML on the client. |
| `drizzle-orm` | runtime | Table definitions and query building over better-sqlite3. |
| `drizzle-zod` | runtime | Derives Zod validators from the generated table schema. |
| `effect` | runtime | The core runtime. Pinned to 3.22.x; no Effect-4-only API. |
| `exifr` | runtime | Reads EXIF metadata from uploaded images. |
| `fast-check` | dev | Property-test arbitraries, used directly by `@michaelthielemann/kestrel-core` and `@michaelthielemann/kestrel-access`. |
| `file-type` | runtime | Sniffs the real content type of an upload rather than trusting its extension. |
| `jsdom` | runtime | Server-side DOM for sanitizing richtext outside the browser. |
| `nanoid` | runtime | Translation-group candidate ids in the locale-resolution step. |
| `nitropack` | runtime | Nitro server runtime; also a direct dependency of `@michaelthielemann/kestrel-publishing`. |
| `nuxt` | runtime | The framework this layer extends. |
| `reka-ui` | runtime | Accessible unstyled primitives behind the admin components. |
| `sanitize-html` | runtime | Sanitizes richtext HTML on the server. |
| `sass` | runtime | Stylesheet compilation for the admin layer. |
| `sharp` | runtime | Image derivative generation for media. |
| `thumbhash` | runtime | Compact image placeholders stored with media records. |
| `typescript` | runtime | Shipped so a consumer's type-check resolves the layer's types. |
| `zod` | runtime | Field validators and boundary validation in the current engine. |
| `@nuxt/kit` | peer | Framework singleton; a second copy breaks module identity. |
| `h3` | peer | Framework singleton; a mixed-major copy turns our typed errors into bare 500s. |
| `vue` | peer | Framework singleton; two Vue instances break component identity. |
| `vue-router` | peer | Framework singleton; must match the app's router. |
| `@arethetypeswrong/cli` | dev | Checks that type resolution works for every consumer module format. |
| `@fast-check/vitest` | dev | Property tests, with arbitraries derived from the schemas. |
| `@microsoft/api-extractor` | dev | The machine-readable `.api.md` report; its diff is the additive-only check. |
| `@nuxt/eslint` | dev | Nuxt-aware flat ESLint config, including auto-import globals per layer. |
| `@nuxt/kit` | dev | Resolves the peer locally so this repo builds. |
| `@nuxt/test-utils` | dev | Nuxt environment and e2e harness for Vitest. |
| `@stryker-mutator/core` | dev | Mutation testing, to detect tests that assert nothing. |
| `@stryker-mutator/vitest-runner` | dev | Vitest runner for Stryker. |
| `@vitejs/plugin-vue` | dev | SFC compilation for the component test environment. |
| `@vue/test-utils` | dev | Component mounting in the DOM suites. |
| `drizzle-kit` | dev | Migration generation and the `db:migrate` CLI. |
| `eslint` | dev | The lint gate. |
| `eslint-plugin-boundaries` | dev | Module-boundary enforcement for code with explicit imports. |
| `eslint-plugin-jsdoc` | dev | `require-jsdoc` with `publicOnly` — documentation presence on public exports. |
| `eslint-plugin-tsdoc` | dev | `tsdoc/syntax` — TSDoc syntax conformance; the half jsdoc cannot check. |
| `eslint-plugin-vuejs-accessibility` | dev | Accessibility rules on admin templates. |
| `h3` | dev | Resolves the peer locally so this repo builds. |
| `happy-dom` | dev | DOM implementation for the component suites. |
| `playwright-core` | dev | Browser driver for the e2e suite. |
| `publint` | dev | Checks the published package's exports and file layout. |
| `typedoc` | dev | Generates the API reference from TSDoc. |
| `vitest` | dev | The test runner for all suites. |
| `vitest-openapi` | dev | `toSatisfyApiSpec()` — asserts live responses against the derived OpenAPI document. |
| `vue` | dev | Resolves the peer locally so this repo builds. |
| `vue-router` | dev | Resolves the peer locally so this repo builds. |
| `vue-tsc` | dev | Type-checks SFCs in the `typecheck` gate. |
| `@effect/vitest` | approved | Vitest integration for Effect tests: `TestClock`, effect-aware assertions. |

Every row above except `@effect/vitest` is installed today, in the root manifest or in one or more
`packages/*` manifests — the column reflects the scope it actually carries wherever it lands.
`@effect/vitest` remains the one genuinely pending row: it has cleared the human decision but has not
landed in any manifest yet.

## See also

- [Decisions](./decisions.md) — ADR-0004 (the typecheck gate) and ADR-0015 (documentation as a verified contract).
- [Architecture](./architecture.md) — how the packages fit into the layer model this release process ships.
- [Layers and packages](./layers-and-packages.md) — what each of the ten `@michaelthielemann/kestrel-*` packages contains.
- [Testing and conventions](./testing.md) — which runner picks up which test file, and what each suite proves.
- [Pipeline engine](./pipeline-engine.md) — the `_pipelines` index and request trace the OpenAPI spec is derived from.
