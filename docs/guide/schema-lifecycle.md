# Schema changes and migrations

This page explains what happens to the database when you add, remove, or change a field on a `defineCollection` — in dev, in production, and via the `db:migrate` task.

## How the schema is derived

There are no hand-written migrations. The schema comes from your collection definitions: Kestrel builds the desired table shape from each `defineCollection`, introspects the live database, diffs the two, and generates the DDL to close the gap.

| Environment | Behaviour |
| --- | --- |
| **Dev** | Auto-syncs **additive** changes at server boot (new table, column, index). Destructive changes (drop, rebuild) are detected but withheld — the boot log tells you to run the explicit task. |
| **Prod** (`NODE_ENV=production`) | Boot never touches the schema. It runs a read-only **drift check** and logs a warning, listing the pending changes, if the live database is behind your collections. Apply changes with the `db:migrate` task. |
| **Prerender** (`nuxt generate`) | Neither auto-sync nor the drift check runs. A static build gets no schema warning at all — run `db:migrate` before generating. |

The dev/prod switch is `NODE_ENV=production`, not the Nuxt dev flag — a preview or staging run started without it takes the dev auto-sync path.

Upgrading the `@michaelthielemann/kestrel` package can itself change the derived schema — a release that adds an engine table or column needs `db:migrate` run against your production database afterwards. The boot drift warning tells you when that's needed.

## Running db:migrate

`db:migrate` is a Nitro task. The layer already enables `nitro.experimental.tasks`, so the task routes exist without any consumer config.

This Nuxt/Nitro app has no `nuxi task run` CLI. Trigger `db:migrate` via the dev-only task route, or programmatically in production with `runTask` from an authenticated route or a cron `scheduledTask` — the built node-server has no task endpoint of its own.

```bash
# dev (server running): the dev-only task route
curl http://localhost:3000/_nitro/tasks/db:migrate          # apply additive changes
```

```ts
// prod: from inside the Nitro process
await runTask('db:migrate')                                    // apply additive changes
await runTask('db:migrate', { payload: { check: true } })      // dry run: report pending DDL only, applies nothing
await runTask('db:migrate', { payload: { force: true } })      // also apply rebuilds (column drop/type change)
await runTask('db:migrate', { payload: { drop: ['old_table'] } }) // drop a specific table
```

`db:migrate-module` runs the same diff/apply engine, scoped to one module's tables at a time — `content`, `media`, `publishing`, or `unmanaged` (tables no module manifest claims). Pass `{ module: 'media' }` for one module, plus the same `check`/`force`/`drop` flags; omit `module` to run every one of them in that fixed order, then `unmanaged`. An unrecognised module name is a hard error.

A change that can't succeed — for example a new `NOT NULL` column with no default on a populated table, or a `unique` index over values that already have duplicates — fails up front with a clear message and changes nothing, on apply. `check` only reports the pending DDL; it doesn't run this feasibility check, so a clean dry run can still be followed by an apply that fails this way. The same feasibility check also runs during dev's additive auto-sync, not only under `db:migrate`'s apply — but there a failure is logged and the server keeps booting on the previous schema (so the admin UI stays reachable), while `db:migrate` itself exits with the error.

## Why destructive changes are gated

A field with no hint about its previous name is indistinguishable from a brand-new field once collections are diffed against the live schema — the old column is dropped and the new one added, and its data is gone. SQLite's `ALTER TABLE` limits also force a full table rebuild for a column drop or a type/constraint change. Both are data-loss risks, so `db:migrate` withholds them by default: a rebuild only applies with `{ force: true }`, and a table drop only applies when the table is named in `{ drop: [...] }` — `force` never drops a table. Block content is stored as a single JSON column specifically to keep this diff surface small — block field changes never trigger a column-level rebuild.

### Renaming a field without losing data

Give the field a `renamedFrom` hint and the diff emits an in-place `ALTER TABLE … RENAME COLUMN` instead of a drop plus an add — it applies additively, including in dev's auto-sync, no `{ force: true }` needed:

```ts
fields: {
  fullName: { type: 'text', renamedFrom: 'name' },
}
```

The hint only takes effect while the old column is still live. See [field-types.md](./field-types.md) for the full flag reference.

## Migrating into revisions

An existing install's rows predate append-only revision history and have no revisions of their own. Run `db:migrate-revisions` once, after `db:migrate` (or `db:migrate-module`) has provisioned the `<collection>_revisions` tables, to seed revision `1` for every row of every currently registered collection. A collection disabled by a config toggle is skipped — re-run this task after re-enabling it; the per-row idempotence below makes that safe. It's a Nitro task, not a CLI command: in dev, `GET`/`POST http://localhost:3000/_nitro/tasks/db:migrate-revisions`; in production, call it from inside the running process — the built server has no task CLI or endpoint of its own.

```bash
# dev (server running): the dev-only task route
curl http://localhost:3000/_nitro/tasks/db:migrate-revisions
```

```ts
// prod: from inside the Nitro process
await runTask('db:migrate-revisions', { payload: { force: true } })
```

It refuses to run at all without `{ force: true }` — a thrown error, not a partial run — because this is a real data-seeding operation, not a dry-run-able schema diff. Contrast `db:migrate`, which withholds and reports a destructive change it wasn't opted into.

`db:migrate-revisions` requires the revisions tables to already exist; it fails with a named error pointing at `db:migrate`/`db:migrate-module` if they don't, since it only seeds rows and never creates tables. It's safe to re-run — seeding is per-row idempotent, so a row that already has a revision, whether from an earlier partial run or the ordinary write path, is skipped.

## See also

- [Revisions and rollback](./revisions.md) — how the revision history this task seeds is used at runtime.
- [Collections](./collections.md) — defining the collections the schema is derived from.
- [Field types](./field-types.md) — the `renamedFrom` flag and every other option a field accepts.
- [Data model](../internals/data-model.md) — the schema-sync engine and table-derivation internals.
- [Architecture decisions](../internals/decisions.md) — the recorded design behind the dev/prod split.
