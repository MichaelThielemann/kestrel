# Kestrel

A CMS backend in TypeScript, assembled from interchangeable building blocks instead of shipped as
one application. A **contract** describes a capability (`persistence@1`, `authn@1`, `content@1`); a
**submodule** implements one and contributes **steps**; a **pipeline** is an ordered list of step
names and holds the business logic; a **trigger** — an HTTP route, an event or a cron expression —
starts a pipeline. Two files wire an instance: `kestrel.config.ts` says *which* blocks are active
with what settings, `pipelines/` says *how* they work together.

The core is a registry, a boot check and a runner. It ships no contracts and no modules, so a
project installs exactly the packages it uses and swapping an implementation changes config, not
pipelines. Wiring mistakes — an unknown step, a missing contract, a step reading context nothing
wrote — stop the boot instead of failing on a request.

New here? [`docs/getting-started.md`](docs/getting-started.md) goes from an empty folder to a
running instance with a login, a content type and a step of your own.

<!-- kestrel-docs:start -->
| Package | Purpose |
|---|---|
| `@michaelthielemann/kestrel` | Kestrel core: contract registry, boot check, pipeline runner and triggers. Ships no contracts and no modules. |
| `@michaelthielemann/kestrel-contracts` | Kestrel standard contracts (persistence, authn, authz, blobstore, events) with contract test suites. |
| `@michaelthielemann/kestrel-h3` | Adapter: serves a Kestrel instance's HTTP triggers as an h3 event handler (Nuxt/Nitro). |
| `@michaelthielemann/kestrel-openapi` | Generates an OpenAPI 3.1 description from a booted Kestrel instance (triggers, pipelines, step descriptions). |
| `@michaelthielemann/kestrel-audit-persistence` | Step audit.record: writes audit_entries via persistence@1. |
| `@michaelthielemann/kestrel-authn-multi` | authn@1 with users and sessions stored via persistence@1; user management steps. |
| `@michaelthielemann/kestrel-authn-single` | authn@1 with one user from config (scrypt hash) and in-memory sessions. |
| `@michaelthielemann/kestrel-authz-roles` | authz@1 with roles and permissions from config. |
| `@michaelthielemann/kestrel-backup-blobstore` | Steps backup.run/restore: backs up a local file (e.g. the SQLite database) to blobstore@1, restoring it on start when missing. |
| `@michaelthielemann/kestrel-blobstore-filesystem` | blobstore@1 on the local filesystem. |
| `@michaelthielemann/kestrel-blobstore-s3` | blobstore@1 on Amazon S3 or any S3-compatible store. |
| `@michaelthielemann/kestrel-content-default` | content@1: typed documents from a config-declared model, on top of persistence@1. |
| `@michaelthielemann/kestrel-delivery-static` | Steps delivery.publish/unpublish/readStatus/publishAll: renders published documents per locale via renderer@1, stores them in blobstore@1 and tracks a publish status. |
| `@michaelthielemann/kestrel-events-inmemory` | events@1 in process; enables event triggers. |
| `@michaelthielemann/kestrel-events-queue` | events@1 with a persistent queue: emit returns after the write, an in-process worker runs the listener pipelines with retry, backoff and dead-letter. |
| `@michaelthielemann/kestrel-images-default` | Steps images.register/generate/sync/resume/prune: image variant size registry, generation on upload, resumable sync. |
| `@michaelthielemann/kestrel-insights` | insights@1: the instance manifest (modules, config schemas, steps, pipelines, triggers) and live per-process run statistics from the core's observer hook. |
| `@michaelthielemann/kestrel-links-default` | Steps links.extract/check/report/rebuild: finds external URLs in content, checks them periodically and reports broken links. |
| `@michaelthielemann/kestrel-media-default` | Media uploads: files in blobstore@1, metadata in persistence@1. |
| `@michaelthielemann/kestrel-migrations-default` | migrations@1: applies content migrations once, per document and stored locale, with a ledger. |
| `@michaelthielemann/kestrel-persistence-sqlite` | persistence@1 on Node's built-in node:sqlite. |
| `@michaelthielemann/kestrel-ratelimit-memory` | Step ratelimit.check:<bucket>: fixed-window rate limiting per client ip, in memory. |
| `@michaelthielemann/kestrel-redirects-default` | Steps redirects.validate/lookup/export/render: admin-managed redirect rules, honoured in site resolution and exported as redirects.json for an edge proxy. |
| `@michaelthielemann/kestrel-references-default` | Referential integrity for content ref fields: existence on write, delete protection. |
| `@michaelthielemann/kestrel-renderer-plain` | renderer@1 reference: a plain HTML page from a document (title, fields, JSON). For examples and tests. |
| `@michaelthielemann/kestrel-replication-sqlite` | Continuous SQLite replication to blobstore@1 (snapshots + WAL segments), point-in-time restore, retention. |
| `@michaelthielemann/kestrel-revisions-default` | revisions@1: a full snapshot per save, branching through a parent pointer, restore as a new save, retention with a prune step. |
| `@michaelthielemann/kestrel-sanitize-svg` | Step sanitize.svg: strips scripts, event handlers and external references from uploaded SVG files. |
| `@michaelthielemann/kestrel-site-default` | site@1: path <-> document resolution and internal link rewriting on top of content@1. |
| `@michaelthielemann/kestrel-validate-jsonschema` | Step validate.check:<type>.<field>: validates a payload field against a JSON Schema file (ajv). |
<!-- kestrel-docs:end -->

## Use it

```
pnpm add @michaelthielemann/kestrel @michaelthielemann/kestrel-contracts @michaelthielemann/kestrel-persistence-sqlite
```

Write `kestrel.config.ts` and your pipelines under `pipelines/`, then run `kestrel` — the whole
walkthrough, including a module of your own, is in
[`docs/getting-started.md`](docs/getting-started.md). To embed Kestrel in a host such as
Nuxt/Nitro instead, set `http: null`, import modules and pipelines statically and call
`kestrel.run()`; see [`examples/embedded`](examples/embedded) and
[`examples/h3`](examples/h3).

## Develop this repository

Requires Node 22.18 or newer (`node:sqlite`, and unflagged type stripping for loading `.ts`
config/pipeline files) and pnpm 11 (`corepack enable`).

```
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm start            # boots examples/minimal
pnpm build            # emits dist/ (js + d.ts) for every package via tsc -b
pnpm docs:generate    # rewrites the generated README sections and examples/minimal/manifest.json; CI runs docs:check
```

Inside the workspace, packages resolve to their TypeScript sources; `publishConfig` switches the
exports to `dist/` on publish. `./scripts/smoke-consumer.sh <hash>` packs everything and boots a
consumer project outside the workspace from the tarballs — see [`RELEASING.md`](RELEASING.md).

Sections between `<!-- kestrel-docs:start -->` and `<!-- kestrel-docs:end -->` — the table above and
one block per package README — are written from the instance manifest by `pnpm docs:generate`.
Never edit them by hand; CI compares them.

## Conventions

1. Submodules never know each other; contracts are the only shared vocabulary between them.
2. Contracts are domain-neutral: would a shop or a forum need the same interface?
3. Submodules provide steps, not triggers — no submodule owns a route or emits an event itself.
4. Business logic lives in pipelines; one pipeline file shows the complete flow.
5. Errors fail loud at boot, not at runtime.

The reasoning behind each, and the one documented exception to rule 3, is in
[`docs/architecture.md`](docs/architecture.md). Submodules keep no module-level state; everything
lives in the `deps`/config closed over by `setup(config, deps)`. Contracts in
`packages/contracts/src/*.ts` are frozen once published. English in code, docs and `CHANGELOG.md`;
comments only where a hidden constraint is not obvious from the code.

## Documentation

| doc | when to read |
|---|---|
| [`docs/getting-started.md`](docs/getting-started.md) | First contact: install, configure, run, and write your own module. Start here. |
| [`docs/architecture.md`](docs/architecture.md) | The model behind it: contract, module, submodule, step, pipeline, trigger; package layout, boot sequence, the five rules, config vs. context. |
| [`docs/configuration.md`](docs/configuration.md) | Reference for `kestrel.config.ts`: every top-level and `http` key with its default, trigger forms, the `kestrel` and `kestrel-openapi` commands. |
| [`docs/pipelines.md`](docs/pipelines.md) | Writing steps and pipelines: the `Context` type, step arguments and `stepFactory()`, errors as values, `reads`/`writes`, payload validation, runner behaviour, naming, event payloads. |
| [`docs/contracts.md`](docs/contracts.md) | Defining a contract, the rules it must follow, worked examples, and the content model as configuration. |
| [`docs/submodule-template.md`](docs/submodule-template.md) | Shipping a submodule as a package: file layout, `module.ts`/`impl.ts` shape, checklist before "done". |
| [`docs/api.md`](docs/api.md) | The HTTP API of the example instance — read before touching a route or a response shape. |
| [`examples/minimal`](examples/minimal) | Every shipped module wired up in one instance; the reference `docs/api.md` describes. |
| [`RELEASING.md`](RELEASING.md) | Version bump, smoke test and publish steps. |
| [`CHANGELOG.md`](CHANGELOG.md) | Every behaviour change visible to a consumer, newest first under `## Unreleased`. |

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
