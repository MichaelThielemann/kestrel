# Revisions and rollback

Every write to a collection keeps a full history of what the record looked like before, and any of those snapshots can be restored.

## How a write becomes a revision

Each record touched by a `createOne`/`createMany`/`updateOne`/`updateMany` call gets one row appended to a parallel `<collection>_revisions` table, in the same transaction as the write itself — a `createMany` of ten records appends ten revision rows. The collection's own table stays the untouched current-state read model — a revision row carries the full persisted record as a JSON snapshot, not a diff:

```ts
interface RevisionRow {
  recordId: number
  revision: number
  snapshot: Record<string, unknown> | null
  schemaVersion: number
  correlationId: string
  createdAt: string
  tombstone: boolean
}
```

`correlationId` groups every revision, outbox event and log line produced by the same request; revisions seeded by `db:migrate-revisions` carry that task name instead.

For `updateMany` the snapshot is a client-side merge, `{ ...before, ...patchValues }`, rather than a re-read of the stored row — accurate as long as every changed column is one `patchValues` already carries. Every other write shape snapshots the row as actually stored.

A delete appends a **tombstone** revision instead of removing anything — `snapshot` is `null`, `tombstone` is `true` — so a record that was genuinely deleted stays distinguishable from one that simply has no later write. `revision` numbers are per-record and strictly increasing; nothing is ever renumbered.

`schemaVersion` is a hash of the collection definition's shape at write time. Restoring an older snapshot against a definition that has since changed runs it through an upcast step first; see [Rollback](#rollback) for what happens when that upcast can't fully resolve.

## Browsing history

`readRevisions(db, collection, recordId)` is exported from `@michaelthielemann/kestrel-core` and returns every revision for a record, oldest first, with `snapshot` already JSON-decoded and its timestamps revived to `Date`:

```ts
import { readRevisions, useDb } from '@michaelthielemann/kestrel-core'

const history = readRevisions(useDb(), 'posts', 42)
```

There is no dedicated history HTTP endpoint. The underlying `<collection>_revisions` table is also an ordinary table in the same database and can be queried directly, but its columns are `snake_case` (`record_id`, `schema_version`, `correlation_id`, `created_at`), `tombstone` is an integer `0`/`1`, and `snapshot` is a `NOT NULL TEXT` column — a tombstone stores the JSON literal `null` as text, never a SQL `NULL`. A query written against this raw table has to account for that; `readRevisions` already does.

## Rollback

```bash
curl -X POST http://localhost:3000/api/posts/rollback/42 \
  -H 'content-type: application/json' \
  -H 'cookie: <admin session cookie>' \
  -d '{ "revision": 3 }'
```

Rollback is admin-gated (`POST /api/<collection>/rollback/<id>`, same route shape as any other write pipeline) and has no dedicated admin-UI affordance today — it's reachable through this API only. It runs as its own short pipeline: load the target revision, persist it, emit events. The target snapshot is upcast if needed, then decoded against the collection's *current* schema as a column-shape check only — it confirms every column exists and roughly type-checks, not the field-level rules (`unique`, cross-field or custom `validate`) an ordinary write enforces; those apply again once the restored row goes through its next ordinary write. If the upcast can't fully resolve the schema drift and the raw snapshot also fails that column-shape decode, the rollback is refused as `Quarantined` rather than written; if the raw snapshot happens to decode anyway, it's written unescalated with a logged warning, since a column-shape match is not proof the row's meaning is still current.

The restore's status move runs through the same status-transition rules an ordinary write does, evaluated against the collection's current conditions — a snapshot that passed them when it was recorded can still be refused today.

An unknown or tombstoned target revision is rejected before anything is written. The outbox event depends on whether the record exists right now: restoring over a live record emits `<collection>.updated`; restoring a revision that predates a tombstoned delete emits `<collection>.created` instead, since the record genuinely reappears for anything watching the outbox.

A rollback is a new write, not a rewind — it appends a fresh revision describing the restore, leaves every later revision in place, stamps `updatedAt` to now, and keeps the record's original `createdAt`. Rolling back to revision 3 does not delete revisions 4–7; it appends revision 8.

## Upcasting an older snapshot

```ts
import { registerRevisionUpcast } from '@michaelthielemann/kestrel-core'

registerRevisionUpcast('posts', fromVersion, {
  toVersion,
  fn: (payload) => ({ ...payload, /* transform to the newer shape */ }),
})
```

`fromVersion` and `toVersion` are `schemaVersion` values — hashes of the collection definition's shape, not sequential numbers. Register one step per drift; steps for the same collection chain together by matching one step's `toVersion` to the next step's `fromVersion`. A chain resolves only when it lands exactly on the collection's current `schemaVersion` — a dead end or a partial hop leaves the snapshot unresolved, which is what can end a rollback in `Quarantined`.

## Retention

```ts
// kestrel.config.ts
export default {
  revisions: { keep: 20, maxAgeDays: 90 },
} satisfies KestrelConfig
```

- `keep` — how many of the most recent revisions to retain per record. Default `'all'`, nothing pruned by count.
- `maxAgeDays` — how many days to retain revisions, by age.

The two combine as a **union of prunability**: a revision is pruned once it is beyond `keep` *or* older than `maxAgeDays` (whichever are actually set) — setting `keep: 'all'` does not by itself stop `maxAgeDays` from pruning. Pruning runs off the request path, on the outbox worker's idle tick, so it never adds latency to a write. Only one protection is absolute regardless of settings: the newest revision for a record is never pruned — including when that newest revision is a tombstone. A tombstoned record can therefore end up with only its tombstone left; since rollback refuses a tombstoned target, that record's last live state is then unrecoverable through rollback.

## Unmigrated installs fail loud

A collection's `<collection>_revisions` table is provisioned the same way its own table is — through the desired-schema mechanism, by `db:migrate` or dev auto-sync. If that table is missing when a write reaches it (a deploy that upgraded without running `db:migrate`), the write throws and the whole transaction rolls back, record write included, instead of silently skipping the revision. An append-only history that quietly drops a row would make a later rollback or rebuild lie about what happened with no signal that it's lying, so the write fails instead and the boot-time schema-drift check names `db:migrate` as the remedy.

An install that predates revisions entirely has no history for its existing rows. The `db:migrate-revisions` task seeds one starting revision per row across every registered collection; how to run it, and why it insists on `{ force: true }`, is in [schema-lifecycle.md § Migrating into revisions](./schema-lifecycle.md#migrating-into-revisions).

## See also

- [collections.md](./collections.md) — `defineCollection`, the schema a revision snapshot is validated and upcast against.
- [schema-lifecycle.md](./schema-lifecycle.md) — provisioning the revisions tables with `db:migrate`, and seeding history into an existing install.
- [configuration.md](./configuration.md) — `kestrel.config.ts` and the rest of its settings.
- [../internals/decisions.md](../internals/decisions.md) — the full design history behind revisions.
- [../internals/data-model.md](../internals/data-model.md) — where the revisions table sits among the rest of the schema.
