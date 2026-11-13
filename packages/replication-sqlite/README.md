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
`TRANSIENT` naming the generation.

A generation is named by the time its snapshot was taken, then 12 hex digits of its millisecond
timestamp (kept strictly increasing within a process, so generations of the same second sort in the
order they were taken and a restore without a target picks the newest), then 32 random hex digits
(`20260927T101500Z-0192…9f…`), and every key of it lives under `<prefix>gen/<generation>/`, so a snapshot
key cannot be derived from the time it was taken. A generation named by the time alone is listed and
restored as well. The snapshot holds the whole database, sessions and
password hashes included: `prefix` must lie outside anything a bucket or static host serves publicly.

Shipping reads the WAL from the frame the previous run stopped at, asynchronously in 1 MiB chunks,
and uploads segments of about 4 MiB (a single transaction larger than that stays in one segment), so
a run costs time and memory in proportion to the new frames, not to the WAL. A frame is shipped only
when it belongs to a committed transaction and its salts and checksum continue the WAL's checksum
chain; a partly written frame at the end of the file waits for the next run.

The module holds a read transaction on the database, which keeps SQLite from resetting the WAL
before its frames are shipped. A checkpoint first takes the database write lock on a second
connection (`BEGIN IMMEDIATE`, without a busy timeout), so no connection in any thread or process
can commit meanwhile; under that lock it reads the remaining committed frames, releases the read
transaction, runs `wal_checkpoint(PASSIVE)` and takes the read transaction again, then releases the
lock and uploads those frames. A checkpoint therefore never loses frames, whoever writes to the
file. When the write lock is taken (an open write transaction elsewhere), the checkpoint is skipped
and tried again at the next check. Once every frame is copied back, the next writer starts the WAL
over from its beginning; the file keeps its size and SQLite reuses it, it is not truncated.

A checkpoint runs from `replication.sync` when the WAL holds `checkpointBytes` of frames or
`checkpointSeconds` have passed since the last one, and, between syncs, as soon as a once-per-second
check finds `checkpointBytes` of frames in the WAL, so the WAL stays near `checkpointBytes` however
rarely `replication.sync` runs. An older read snapshot on another connection can keep a checkpoint
from copying every frame back; the WAL then keeps growing and the next check tries again.

If an upload fails after a checkpoint, the frames stay in memory and go out first on the next run;
a new snapshot supersedes them, as does the snapshot a restarted process takes on its first sync.
A `replication.sync` called before a running one has started reading returns that run's result;
called later, it runs once more after it, so a sync at shutdown ships every frame committed before
it was called. `replication.snapshot`, `replication.prepareRestore` and the size-triggered
checkpoint wait for each other.

Config: `file`, `prefix`, `checkpointBytes`/`checkpointSeconds`,
`snapshotSeconds` (24 h), `retentionSeconds` (48 h; the newest generation is always kept),
`restoreOnStart` (rebuild the file from the replica when missing). This module declares
`before: [persistence@1]`, so it is set up before `persistence-sqlite` by declaration, regardless
of where either module sits in `kestrel.config.modules`. If the file already exists and holds
a restore point when `setup()` runs, was not itself just restored, and was created during this very
boot (judged by birth time against the start of this boot; where the file system reports none, a
database none of whose tables holds a row counts as created during this boot), `setup()` fails:
that proves another module opened the database first.
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
| `replication.checkRestored` | – | `result._databaseRestoredAt` | – |
| `replication.sync` | – | `result` | `TRANSIENT` |
| `replication.snapshot` | – | `result` | `TRANSIENT` |
| `replication.listPoints` | – | `result` | `TRANSIENT` |
| `replication.readStatus` | – | `result` | `TRANSIENT` |
| `replication.prepareRestore` | – | `result` (writes `<file>.restore`; applied by setup on the next start – the live database cannot be replaced while open) | `VALIDATION`, `NOT_FOUND`, `TRANSIENT` |

`backup/blobstore` follows the same pattern with its own file names (`<file>.restore-pending` plus
`<file>.restore-marker`), so both modules can point at the same database without clashing. When
either module restores the file, it writes `<file>.restored-at` next to it:
`{ "restoredAtBootStartedAt": <epoch ms this boot started> }`, plus `"reported": true` when the
restored file can be older than what was derived from the database before it. The sidecar is written
atomically, before the restored file is moved into place, so a boot that stops in between applies the
restore again on the next start. The other module, if
configured on the same file, recognizes a matching boot as "this boot already restored the file" and
skips its own check — neither module has to know the other exists. The next restore overwrites the
sidecar.

`replication.checkRestored` tells the rest of a pipeline about the latest reported restore of the
database file: it adds `_databaseRestoredAt` to the result, the start of the boot that restored it, or
`null` when the sidecar records none. A prepared restore is reported (`replication.prepareRestore`, or
`backup.restore`), and so is backup-blobstore's restore of a missing file. The value stays the same in
every later boot until the next restore, so a step that keeps output derived from the database stores
the last value it acted on and treats any other one as a restore; a boot that stops before acting on it
leaves it to the next one. The member is a shared convention: `backup.checkRestored` writes the same
one, and `delivery.checkBuild` of delivery-static reads it to render every page again after a restore.
Put the step directly before that check in the pipeline that runs it at boot, for example
`["replication.checkRestored", "delivery.checkBuild", "delivery.requestIndexes"]`, and only when `file` is
the database: a step in between that writes `result` replaces it and drops the member.

This module's rebuild of a missing file under `restoreOnStart` is not reported: it brings back the
replica as of the last shipped WAL frames, which a stop through teardown ships, and on an ephemeral disk
it happens at every start. A process that stopped without teardown loses the frames written since the
last `replication.sync`, and output derived from them (for delivery-static, the files of pages saved in
that window) is not rendered again. A database file copied into place by hand is not reported either.
After either one, restore through `replication.prepareRestore` instead, or render everything again
yourself (for delivery-static, `delivery.markAll` for every delivered type).
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
| `replication.checkRestored` | When the latest restore of the file was a prepared restore or a restore of a missing file from a periodic backup, by this module or another one (adds `_databaseRestoredAt`, the start of the boot that wrote it or null, to the result) | – | `result._databaseRestoredAt` | – | { _databaseRestoredAt: number \| null, … } | – | – | no |
| `replication.sync` | Ship new WAL frames, checkpoint, snapshot and prune when due | – | `result` | – | { generation: string, shippedBytes: number, frames: number, checkpointed: boolean, pruned: number, … } | – | – | no |
| `replication.snapshot` | Start a new generation with a full snapshot | – | `result` | – | { generation: string, bytes: number, … } | – | – | no |
| `replication.listPoints` | Restore points (snapshots and WAL segments) | – | `result` | – | object[] | – | – | no |
| `replication.readStatus` | Replication status | – | `result` | – | { generation: string \| null, lineage: number, shippedFrames: number, lastSyncAt: number \| null, lastSnapshotAt: number \| null, lastCheckpointAt: number \| null, walBytes: number, pendingRestore: string \| null, … } | – | – | no |
| `replication.prepareRestore` | Rebuild the database at a point in time next to the live file; applied on next start | – | `result` | { generation?: string, at?: number \| string } | { generation: string, at: number, file: string, restartRequired: true, … } | 400 invalid "at" value; 404 no snapshot before the requested point | – | no |

Pipelines in `examples/minimal` using these steps:

- **replicate** (cron * * * * *): **`replication.sync`**
- **replicationPoints** (GET /admin/replication/points): `authn.requireUser` → `authz.requireRole` → `authz.require:system.manage` → **`replication.listPoints`**
- **replicationRestore** (POST /admin/replication/restore): `authn.requireUser` → `authz.requireRole` → `authz.require:system.manage` → **`replication.prepareRestore`**
- **replicationSnapshot** (POST /admin/replication/snapshot): `authn.requireUser` → `authz.requireRole` → `authz.require:system.manage` → **`replication.snapshot`**
- **replicationStatus** (GET /admin/replication/status): `authn.requireUser` → `authz.requireRole` → `authz.require:system.manage` → **`replication.readStatus`**

<!-- kestrel-docs:end -->
