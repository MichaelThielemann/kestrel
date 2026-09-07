# replication/sqlite
Continuous replication of the SQLite database into `blobstore@1`, Litestream-style but in-process:
a generation starts with a full snapshot (`VACUUM INTO`), then every `replication.sync` ships the
committed WAL frames written since the last run as a segment. Point-in-time restore = snapshot +
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
