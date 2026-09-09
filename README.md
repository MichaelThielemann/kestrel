# Kestrel

A modular, config-driven CMS backend in TypeScript. Capabilities are described by contracts,
implemented by interchangeable submodules, and wired into business flows by pipelines. Every
building block is its own package; a consumer installs exactly what it uses.

| Package | Purpose |
|---|---|
| `@michaelthielemann/kestrel` | Core: contract registry, boot check, runner, triggers |
| `@michaelthielemann/kestrel-contracts` | Standard contracts with contract test suites |
| `@michaelthielemann/kestrel-h3` | Adapter: serve the HTTP triggers as an h3 handler (Nuxt/Nitro) |
| `@michaelthielemann/kestrel-openapi` | Generate OpenAPI 3.1 from a booted instance (`kestrel-openapi --out openapi.json`) |
| `@michaelthielemann/kestrel-events-inmemory` | `events@1`, needed for event triggers |
| `@michaelthielemann/kestrel-authn-single` | `authn@1`: one user from config |
| `@michaelthielemann/kestrel-authn-multi` | `authn@1`: users and sessions in persistence, user management steps |
| `@michaelthielemann/kestrel-persistence-sqlite` | `persistence@1` on `node:sqlite` |
| `@michaelthielemann/kestrel-authz-roles` | `authz@1`: roles and permissions from config |
| `@michaelthielemann/kestrel-content-default` | `content@1`: typed documents from a config-declared model |
| `@michaelthielemann/kestrel-site-default` | `site@1`: site paths ↔ documents, internal links to public paths |
| `@michaelthielemann/kestrel-blobstore-filesystem` | `blobstore@1` on a local directory |
| `@michaelthielemann/kestrel-blobstore-s3` | `blobstore@1` on S3 / S3-compatible stores |
| `@michaelthielemann/kestrel-media-default` | steps `media.upload/get/list/download/remove` |
| `@michaelthielemann/kestrel-replication-sqlite` | steps `replication.sync/snapshot/points/status/prepareRestore`: continuous replication with point-in-time restore |
| `@michaelthielemann/kestrel-backup-blobstore` | steps `backup.run/restore`: SQLite file to blobstore, restore on start |
| `@michaelthielemann/kestrel-references-default` | steps `references.check/guard`: integrity for `ref` fields |
| `@michaelthielemann/kestrel-ratelimit-memory` | step `ratelimit.check:<bucket>`: per-ip fixed-window limits |
| `@michaelthielemann/kestrel-sanitize-svg` | step `sanitize.svg`: allowlist-cleans uploaded SVGs before media.upload |
| `@michaelthielemann/kestrel-validate-jsonschema` | step `validate.check:<type>.<field>`: JSON Schema (ajv) for e.g. page bodies |
| `@michaelthielemann/kestrel-links-default` | steps `links.extract/check/report/rebuild`: external link checking |
| `@michaelthielemann/kestrel-renderer-plain` | `renderer@1` reference: plain HTML per document |
| `@michaelthielemann/kestrel-delivery-static` | steps `delivery.publish/unpublish/status/publishAll`: static output per locale via renderer@1 into blobstore@1 |
| `@michaelthielemann/kestrel-audit-persistence` | step `audit.record` |

## Develop

Requires Node 22.13 or newer (`node:sqlite`) and pnpm 11 (`corepack enable`).

```
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm start            # runs examples/minimal
pnpm build            # emits dist/ (js + d.ts) for every package via tsc -b
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
