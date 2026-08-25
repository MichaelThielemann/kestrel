# The data model and schema engine

How a `defineCollection` call becomes real tables and back: `buildCollection`, the schema engine that
keeps the DB in sync with the model, one SQLite file with per-module ownership, and the derived indexes
(`record_refs`, revisions, translations, `media_settings`) built on top of it.

## `defineCollection` → `BuiltCollection`

`BuiltCollection` is the contract every write/read pipeline step and the admin serializer consume:
`{ name, def, table, insert, update, select, applyConditions? }` — a Drizzle table plus drizzle-zod
insert/update/select schemas, derived once from a plain `CollectionDef`.

```ts
// packages/kestrel-core/src/server/schema/buildCollection.ts
export function buildCollection(def: CollectionDef): BuiltCollection
export function ensureBuilt(c: CollectionDef | BuiltCollection): BuiltCollection
```

`ensureBuilt` accepts either form — the common `export default defineCollection(…)` or an
already-built collection a server route needs the raw `table` from — discriminating on whether `table`
is already present.

`buildCollection` composes three passes: `buildTable` (`utils/buildTable.ts`) turns each field into a
Drizzle column via `getFieldType(field.type).column(dbName, field)`, reading core's own field-type
registry (`packages/kestrel-core/src/server/registries/field-types.ts`); `buildFieldSchema` reads the same
descriptor's `validator` half to build the per-field Zod refinements; `systemRefinements` adds the checks
no column type carries alone — `locale`/`translationGroup`/`singletonKey` presence, the `path` traversal
guard for `pageLike` collections, the `status` enum (so a typo like `'publushed'` can't silently unpublish
a record), and the blocks/SEO schemas; `buildApplyConditions` compiles the per-record `applyConditions`
hook that re-enforces `required` on conditional fields and runs the collection's own `def.validate`. See
[field-types.md](./../guide/field-types.md) for the field→column mapping itself.

## jsKey ↔ dbName

A field's JS key and its DB column name can differ in one case: core's `isSingleRefColumn` predicate
decides whether a `relation`/`media` field is a single reference; `resolveColumnName`
(`packages/kestrel-core/src/server/utils/naming.ts`) uses that to store it as `<key>Id` (JS) / `<key>_id`
(DB) — a `multiple` relation keeps the plain snake_cased key instead. The serializer emits the result as a
`single` flag on `SerializedField`, so the admin's `jsKey` helper (`layers/admin/app/utils/field-keys.ts`)
and its consumers — `useEditForm` and `list-columns.ts` — plus core's `app/utils/filter-ops.ts` read the
flag rather than re-deriving the rule — one source of truth for which columns get the `Id` suffix.

`buildCollection`, `resolveColumnName`, and the field-type registry all live in `core`; a field-type
*package* like `kestrel-fields` only registers its descriptors into that registry at boot
(`registerFieldType`/`seedBuiltinFieldTypes`) — it does not own any of the naming or table-building code.

## The schema engine

Collection defs are the desired state; the schema engine keeps the live DB matching it, dialect-agnostic
end to end (`packages/kestrel-core/src/server/schema/{model,desired,introspect,diff,dialect,
render-sqlite,sync}.ts`):

1. **model** — a normalized, dialect-agnostic shape (`ColumnShape`, `IndexShape`, `SchemaSnapshot`) both
   sides of a diff are expressed in.
2. **desired** — built from every enabled registered collection's Drizzle table (`desiredFromCollections`,
   `schema/bootstrap.ts`), plus the discovered standalone tables (`extraTables`) and with disabled
   built-ins dropped by the collection toggles — the same toggle source the registry plugin reads, so
   runtime surface and schema agree.
3. **introspect** — the live DB read back into the same shape.
4. **diff** — desired vs. introspected → a list of `SchemaOp`s (`create_table`, `add_column`,
   `rename_column`, `create_index`/`drop_index`, `drop_table`, `rebuild_table`).
5. **render** (`render-sqlite.ts`) — ops → DDL for the one wired dialect; a `postgres` slot exists and
   fails loud rather than silently mis-rendering.
6. **sync** — applies the ops.

`isDestructive(op)` marks `drop_table`/`rebuild_table` — anything that can lose data. In **dev**,
`layers/core/server/plugins/02.schema-sync.ts` calls `runDevSchemaSync`, which auto-applies every additive
op on boot; it passes no opt-ins at all, so a destructive op is never applied on the dev boot path — it is
always withheld and logged. **Prod** never auto-DDLs at boot either, but it isn't silent: the same plugin
runs a read-only drift check on every boot, splitting pending ops by `isDestructive` — an additive gap
(missing table/column/index) produces a loud "the app may error until you run the db:migrate task"
warning naming each op, a destructive one is reported informationally since `db:migrate` withholds it
anyway (in practice this is usually a drop for a disabled built-in or an unmanaged table, since desired
already excludes disabled built-ins). Applying schema changes in prod is the `db:migrate` task's job
(`layers/core/server/tasks/db/migrate.ts`, triggered per
[schema-lifecycle.md](../guide/schema-lifecycle.md)); its payload takes `{ check: true }` for a dry run,
`{ force: true }` to allow `rebuild_table` ops, and `{ drop: [...names] }` to allow specific `drop_table`s
(`allowDestructive` and `dropTables` are the `SyncOptions` fields these map to; `allowDestructive` alone
never drops a table — a `drop_table` applies only if its name is in `dropTables`) — so a deploy's schema
change is a deliberate, reviewable step, and a forgotten one shows up as the boot warning above rather
than silent divergence.

## One database file, per-module ownership

Every collection's table, `record_refs`, the outbox, and every `<collection>_revisions` table live in
the **same** SQLite file — but a module only ever touches its own tables. `useContentDbFor` builds a
`ModuleDbService` (`packages/kestrel-core/src/server/db/module-db.ts`) scoped to an `OwnershipManifest`
(`buildContentManifest` in `content-manifest.ts`): every registered collection's table name, plus
`record_refs`, the content outbox table, and each collection's revisions table, plus `extra` — the one
collection the current caller is operating on (`collectionOf(ctx)`), which may not itself be registered
(a CRUD call site takes an explicit `BuiltCollection` independent of the global registry) and would
otherwise read as a foreign table. `buildContentManifest` recomputes from `allCollections()` on every
call (collections register at boot, so it can't be a fixed list); `useContentDbFor` then caches the built
adapter per `(raw client, registry generation, extra name)`, so nothing is rebuilt per request. `makeModuleDb`
reads `NODE_ENV` once, at construction, and captures it: off `'production'`, every statement the adapter
issues is checked against the manifest by scanning its compiled SQL for table references, throwing
`OwnershipViolation` on a foreign table — a programmer guard that catches a module reaching across
another module's tables before it ships. Nothing is compiled out in prod; the check is just skipped at
runtime, so only the (cheap) statement-facade wrapping still runs.

`opTable(op)` names the table any `SchemaOp` targets regardless of its variant shape, and `describeOp(op)`
renders a human line for the same ops (naming carried columns and rename sources, not just a count) so a
dry run or a skipped-destructive-op warning is legible without reading the raw op. Neither `db:migrate`
nor the dev auto-sync filters on `opTable` — both apply/report every pending op. The filter is the
per-module counterpart, `db:migrate-module` (`layers/core/server/tasks/db/migrate-module.ts`): it plans
the same ops, then runs them in a fixed order — `content` (the collection/base schema) first, then every
discovered module manifest, then an `unmanaged` catch-all for any table no manifest yet claims — filtering
each module's ops to `tables.includes(opTable(op))` so one module's migration never touches another's
tables. This is the one place `OwnershipManifest` reaches the schema engine directly.

## `record_refs` — the reference index

Every content write drives a durable `(sourceColl, sourceId) → (targetColl, targetId)` index over every
reference a record holds (relation/media fields, the `link` field, richtext internal links, and both
nested inside blocks/repeaters), indexed both forward and reverse
(`packages/kestrel-core/src/server/database/record-refs.ts`,
`server/utils/record-ref-index.ts`) — maintained asynchronously by the `reindexRefs` outbox handler
(`server/handlers/reindex-refs.ts`), registered against the `*.created`/`*.updated`/`*.deleted` wildcards,
rather than inside the write transaction: at-least-once, idempotent (it re-reads the record's current row
rather than trusting the envelope), retried and then dead-lettered on failure like any other outbox
handler (see [pipeline-engine.md](./pipeline-engine.md) § Outbox handlers). It powers two things read on
top of it, never stored: dead-reference warnings (a target that's deleted, or unpublished on a collection
with a `status` column) and the "N records link here" check before delete (unpublish runs no such check).
See [../guide/references.md](../guide/references.md) for the full derivation and where each warning
surfaces. The index is fully derived — `rebuildRecordRefs(db)` purges every edge and replays every live
row of every registered collection through the same `maintainRecordRefs()` the write path calls, in one
transaction, so a corrupted or stale index is repaired exactly (the table itself is provisioned by the
schema engine, not by this call).

## Revisions and tombstones

Every content write appends a full JSON snapshot to that collection's own `<collection>_revisions`
table, in the same transaction as the record write (`db/revisions.ts`, `pipeline/steps/persist.ts`); the
collection's own table stays the current-row read model, untouched. A **delete** appends a tombstone
revision instead — an additive `tombstone` column, `snapshot` stored as the JSON literal `"null"` — so a
later restore can tell "genuinely deleted" from "row simply missing." Each revision carries a
`schema_version` (a hash of the collection def's shape); a dedicated upcast registry
(`registerRevisionUpcast`) bridges an older snapshot forward to the current def on read. Retention
(`revisions: { keep, maxAgeDays }`) prunes old revisions off the outbox worker's idle tick, never the
request path, and always protects the newest revision of a record — including when that newest revision
is a tombstone. Nothing protects the last live snapshot underneath a tombstone; it prunes like any other
older revision, so a tombstoned record can end up with only its tombstone left (rollback refuses a
tombstoned target, so that record's last live state is then unrecoverable through rollback — see
[../guide/revisions.md](../guide/revisions.md)).

`rollback` is its own three-step pipeline (registered steps `loadRollbackTarget` → `persist` → `emitEvents`,
not a route through `updateOne`) — but it composes the same write invariants as the other write pipelines.
Unique-conflict handling and richtext sanitisation run inside the `persist` step (built by
`persistRollbackStep`). The status-transition gate runs earlier, in `loadRollbackTarget`: the upcast
step runs first, then the (possibly-upcast) snapshot is decoded against the collection's current `select`
schema as a go/no-go check — deliberately column-shape-only (every column exists and roughly type-checks),
not full field-level refinements — and only then is the restore's status move checked with
`assertStatusTransition` against TODAY's conditions, so a snapshot that fails them now is refused before
anything is written. A `unique`/cross-field/custom `validate` rule applies again for real only once the
restored row round-trips through an ordinary write afterward. See
[pipeline-engine.md](./pipeline-engine.md) for how a rollback request reaches this pipeline and
[../guide/revisions.md](../guide/revisions.md) for reading revision history and triggering a rollback over
the API.

```bash
POST /api/<collection>/rollback/<id>
# body: { "revision": 3 }
```

## Translation storage

A collection opts in with `translatable: true`. In `mode: 'multi'` each locale is a separate row, grouped
by a `translationGroup` id, unique on `(translationGroup, locale)`; in `mode: 'single'` each locale is a
separate singleton row keyed `(singletonKey, locale)`. List reads on a multi-mode translatable collection
attach a `$translations` sidecar (locale → sibling row id, or `null`) computed once per page in a single
batched query over the group ids present — not one query per row — honouring `publishedOnly` so a
published-scope read never reveals a draft sibling. See [multilingual.md](../guide/multilingual.md) for
the editor and list-filtering behaviour built on this.

## The `media_settings` variant registry

Image variant derivation reads a runtime registry, not the config presets directly: `media_settings` is a
`nav: false` hidden singleton collection (`mode: 'single'`) whose single row records the currently-in-use
variant set, each entry carrying provenance (`source: 'scan'` vs. `'manual'`/`pinned`). Config-authored
named presets (`image.variants`) are never scan-discovered, so they stay active regardless of registry
state — unioned into a non-empty registry and winning any name collision. Only the separate resolved
config fallback applies when the registry is empty or unread. See [media.md](../guide/media.md) for how
uploads, publish-time scanning, and backfill keep the registry in sync.

## See also

- [../guide/field-types.md](../guide/field-types.md) — the field→column/validator mapping the schema
  engine builds tables from.
- [../guide/references.md](../guide/references.md) — dead-reference derivation and where each warning
  surfaces, built on `record_refs`.
- [../guide/multilingual.md](../guide/multilingual.md) — the editor and list surface for translated
  records.
- [../guide/schema-lifecycle.md](../guide/schema-lifecycle.md) — how the migrate tasks are actually
  triggered.
- [pipeline-engine.md](./pipeline-engine.md) — the outbox `reindexRefs`/rollback machinery this page
  leans on.
- [decisions.md](./decisions.md) — ADR-0002 (schema engine) and ADR-0012 (per-module DB ownership).
