# Kestrel

A modular, config-driven CMS backend in TypeScript. Capabilities are described by contracts,
implemented by interchangeable submodules, and wired into business flows by pipelines. Every
building block is its own package; a consumer installs exactly what it uses.

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
| `@michaelthielemann/kestrel-sanitize-svg` | Step sanitize.svg: strips scripts, event handlers and external references from uploaded SVG files. |
| `@michaelthielemann/kestrel-site-default` | site@1: path <-> document resolution and internal link rewriting on top of content@1. |
| `@michaelthielemann/kestrel-validate-jsonschema` | Step validate.check:<type>.<field>: validates a payload field against a JSON Schema file (ajv). |
<!-- kestrel-docs:end -->

## Develop

Requires Node 22.13 or newer (`node:sqlite`) and pnpm 11 (`corepack enable`).

```
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm start            # runs examples/minimal
pnpm build            # emits dist/ (js + d.ts) for every package via tsc -b
pnpm docs:generate    # rewrites the generated README sections and examples/minimal/manifest.json from the manifest; CI runs docs:check
```

Inside the workspace, packages resolve to their TypeScript sources; `publishConfig` switches the
exports to `dist/` on publish. `./scripts/smoke-consumer.sh <hash>` packs everything and boots a
consumer project outside the workspace from the tarballs – see `RELEASING.md`.

## Consumer

```
pnpm add @michaelthielemann/kestrel @michaelthielemann/kestrel-contracts @michaelthielemann/kestrel-persistence-sqlite
```

Write `kestrel.config.ts` (modules by package name, triggers by pipeline name) and your
pipelines under `pipelines/`, then run `kestrel`. See `examples/minimal`. To embed Kestrel in a
host such as Nuxt/Nitro, set `http: null`, import modules and pipelines statically and call
`kestrel.run()` – see `examples/embedded`.

## Conventions

1. Submodules never know each other; contracts are the only shared vocabulary between them.
2. Contracts are domain-neutral. Test question: would a shop or a forum need the same interface?
   If not, domain knowledge leaked into the wrong layer.
3. Submodules provide steps, not triggers. No submodule owns a route or emits an event itself.
   The one exception: a submodule emits from a contract method whose fact arises without a
   pipeline or survives a partial failure of that method (today only `migrations.applied`); every
   further exception needs a row with its reason in the event table of `docs/pipelines.md`.
4. Business logic lives in pipelines; one pipeline file shows the complete flow.
5. Errors fail loud at boot, not at runtime: a missing contract, a missing method, an unknown step
   or a cycle stops the boot and names the module and the reason.

Steps are strings (`"authz.require:pages.write"`) resolved against the step registry at boot; a step
with an argument is a factory marked with `stepFactory()`. The `Context` a pipeline passes along is
shallow-frozen: a step returns the input unchanged or a copy, never a mutation. A step returns
`Promise<Result<Context, KestrelError>>` — expected failures are values built with `ctx.fail(...)`,
`throw` is reserved for wiring bugs. Every module that registers steps describes them
(`summary`, `reads`, `writes`) so boot can check the dataflow of every pipeline. Submodules keep no
module-level state; everything lives in the `deps`/config closed over by `setup(config, deps)`.
Contracts in `packages/contracts/src/*.ts` are frozen once published. English in code, docs and
`CHANGELOG.md`; comments only where a hidden constraint is not obvious from the code.

## Documentation

| doc | when to read |
|---|---|
| `docs/architecture.md` | Core concepts (contract, module, submodule, step, pipeline, trigger), package layout, boot sequence, the five rules, config vs. context. |
| `docs/pipelines.md` | Pipeline file shape, the `Context` type, step arguments and `stepFactory()`, triggers in `kestrel.config.ts`, runner behaviour, naming vocabulary, event payloads. |
| `docs/contracts.md` | What a contract is, the rules for defining one, a worked example (`persistence@1`). |
| `docs/api.md` | The HTTP API of the example instance (`examples/minimal`) — read before touching a route or a response shape. |
| `docs/submodule-template.md` | File layout and `module.ts`/`impl.ts` shape for a new submodule package. |
| `RELEASING.md` | Version bump, smoke test and publish steps. |
| `CHANGELOG.md` | Every behaviour change visible to a consumer, newest first under `## Unreleased`. |

## License

Apache-2.0 — see `LICENSE`.

## Password for `authn-single`

```
node -e "import('@michaelthielemann/kestrel-authn-single/impl').then(m => console.log(m.hashPassword(process.argv[1])))" -- <password>
```
