# replication/sqlite
Continuous replication of the SQLite database into `blobstore@1`, Litestream-style but in-process:
a generation starts with a full snapshot, then every `replication.sync` ships the committed WAL
frames written since the last run as a segment. The snapshot is the main database file with the
committed WAL frames applied on top, assembled under the module's read transaction, never a
`VACUUM INTO`: segments address pages by number, so the snapshot has to keep the live file's page
layout. Frames the snapshot already contains are not shipped again; without a generation there is
nowhere to ship frames to, so they wait. Point-in-time
restore = snapshot + segments up to the requested time, applied page by page; the rebuilt file is
opened and passes `PRAGMA quick_check` before it is handed over, otherwise the restore fails with
`TRANSIENT` naming the generation. Because the writing connection lives in the same Node process,
checkpoints (`wal_checkpoint(TRUNCATE)`) run between two synchronous steps and can never lose
frames. Config: `file`, `prefix`, `checkpointBytes`/`checkpointSeconds`,
`snapshotSeconds` (24 h), `retentionSeconds` (48 h; the newest generation is always kept),
`restoreOnStart` (rebuild the file from the replica when missing). List this module **before**
`persistence-sqlite`, and it also declares `before: [persistence@1]` so a misordered list produces
a `module-order` boot warning instead of a silent empty start. If the file already exists and holds
a restore point when `setup()` runs, was not itself just restored, and was created during this very
boot (judged by birth time against the start of this boot, falling back to a table count where the
file system reports none), `setup()` fails: that proves another module opened the database first.
Move the named file (and its `-wal` and `-shm` siblings) aside and start again — an ephemeral disk
clears them for you on the next restart, a persistent volume does not, so move them by hand there:
a stale file left over from an earlier, unrelated failure predates this boot, so this check stays
quiet about it and the file still has to be moved aside as instructed above. Run `replication.sync`
from a cron trigger (`* * * * *` → RPO ≤ 60 s).
Every step returns a `Result`. A blobstore `Err` (`Err(TRANSIENT)`, 503, `retryable`) passes
through unchanged; `replication.prepareRestore` for a point with no snapshot before it, or an
unknown `generation`, is `Err(NOT_FOUND)`; an unparsable `at` in the payload is `Err(VALIDATION)`.

| Step | reads | writes | errors |
|---|---|---|---|
| `replication.sync` | – | `result` | `TRANSIENT` |
| `replication.snapshot` | – | `result` | `TRANSIENT` |
| `replication.listPoints` | – | `result` | `TRANSIENT` |
| `replication.readStatus` | – | `result` | `TRANSIENT` |
| `replication.prepareRestore` | – | `result` (writes `<file>.restore`; applied by setup on the next start – the live database cannot be replaced while open) | `VALIDATION`, `NOT_FOUND`, `TRANSIENT` |

`backup/blobstore` follows the same pattern with its own file names (`<file>.restore-pending` plus
`<file>.restore-marker`), so both modules can point at the same database without clashing. When
either module restores the file, it writes `<file>.restored-at` (the epoch ms this boot started)
next to it; the other module, if configured on the same file, recognizes a matching value as "this
boot already restored the file" and skips its own check — neither module has to know the other
exists. A sidecar from an earlier boot is ignored and simply overwritten on the next restore.
Not included: multi-process setups, encryption, restore without restart.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-replication-sqlite` – module `replication/sqlite`: provides no contract; requires `blobstore@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `file` | string | yes | – |
| `prefix` | string | no | `"replica/"` |
| `checkpointBytes` | integer | no | `4194304` |
| `checkpointSeconds` | integer | no | `300` |
| `snapshotSeconds` | integer | no | `86400` |
| `retentionSeconds` | integer | no | `172800` |
| `restoreOnStart` | boolean | no | `true` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `replication.sync` | Ship new WAL frames, checkpoint, snapshot and prune when due | – | `result` | – | { generation: string, shippedBytes: number, frames: number, checkpointed: boolean, pruned: number, … } | – | – | no |
| `replication.snapshot` | Start a new generation with a full snapshot | – | `result` | – | { generation: string, bytes: number, … } | – | – | no |
| `replication.listPoints` | Restore points (snapshots and WAL segments) | – | `result` | – | object[] | – | – | no |
| `replication.readStatus` | Replication status | – | `result` | – | { generation: string \| null, lineage: number, shippedFrames: number, lastSyncAt: number \| null, lastSnapshotAt: number \| null, lastCheckpointAt: number \| null, walBytes: number, pendingRestore: string \| null, … } | – | – | no |
| `replication.prepareRestore` | Rebuild the database at a point in time next to the live file; applied on next start | – | `result` | { generation?: string, at?: number \| string } | { generation: string, at: number, file: string, restartRequired: true, … } | 400 invalid "at" value; 404 no snapshot before the requested point | – | no |

Pipelines in `examples/minimal` using these steps:

- **replicate** (cron * * * * *): **`replication.sync`**
- **replicationPoints** (GET /admin/replication/points): `authn.requireUser` → `authz.require:system.manage` → **`replication.listPoints`**
- **replicationRestore** (POST /admin/replication/restore): `authn.requireUser` → `authz.require:system.manage` → **`replication.prepareRestore`**
- **replicationSnapshot** (POST /admin/replication/snapshot): `authn.requireUser` → `authz.require:system.manage` → **`replication.snapshot`**
- **replicationStatus** (GET /admin/replication/status): `authn.requireUser` → `authz.require:system.manage` → **`replication.readStatus`**

<!-- kestrel-docs:end -->
