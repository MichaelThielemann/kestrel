# replication/sqlite
Continuous replication of the SQLite database into `blobstore@1`, Litestream-style but in-process:
a generation starts with a full snapshot (`VACUUM INTO`), then every `replication.sync` ships the
committed WAL frames written since the last run as a segment. Frames written before this process
took its first snapshot are already covered by that snapshot, and without a generation there is
nowhere to ship them to, so they are skipped. Point-in-time restore = snapshot +
segments up to the requested time, applied page by page. Because the writing connection lives in
the same Node process, checkpoints (`wal_checkpoint(TRUNCATE)`) run between two synchronous steps
and can never lose frames. Config: `file`, `prefix`, `checkpointBytes`/`checkpointSeconds`,
`snapshotSeconds` (24 h), `retentionSeconds` (48 h; the newest generation is always kept),
`restoreOnStart` (rebuild the file from the replica when missing). List this module **before**
`persistence-sqlite`. Run `replication.sync` from a cron trigger (`* * * * *` → RPO ≤ 60 s).
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
`<file>.restore-marker`), so both modules can point at the same database without clashing.
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

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `replication.sync` | Ship new WAL frames, checkpoint, snapshot and prune when due | – | `result` | – | { generation?: string, shippedBytes?: number, frames?: number, checkpointed?: boolean, pruned?: number, … } | – |
| `replication.snapshot` | Start a new generation with a full snapshot | – | `result` | – | { generation?: string, bytes?: number, … } | – |
| `replication.listPoints` | Restore points (snapshots and WAL segments) | – | `result` | – | object[] | – |
| `replication.readStatus` | Replication status | – | `result` | – | { generation?: string \| null, lineage?: number, shippedFrames?: number, lastSyncAt?: number \| null, lastSnapshotAt?: number \| null, lastCheckpointAt?: number \| null, walBytes?: number, pendingRestore?: string \| null, … } | – |
| `replication.prepareRestore` | Rebuild the database at a point in time next to the live file; applied on next start | – | `result` | { generation?: string, at?: number \| string } | { generation: string, at: number, file: string, restartRequired: true, … } | 400 invalid "at" value; 404 no snapshot before the requested point |

Pipelines in `examples/minimal` using these steps:

- **replicate** (cron * * * * *): **`replication.sync`**
- **replicationPoints** (GET /admin/replication/points): `authn.requireUser` → `authz.require:system.manage` → **`replication.listPoints`**
- **replicationRestore** (POST /admin/replication/restore): `authn.requireUser` → `authz.require:system.manage` → **`replication.prepareRestore`**
- **replicationSnapshot** (POST /admin/replication/snapshot): `authn.requireUser` → `authz.require:system.manage` → **`replication.snapshot`**
- **replicationStatus** (GET /admin/replication/status): `authn.requireUser` → `authz.require:system.manage` → **`replication.readStatus`**

<!-- kestrel-docs:end -->
