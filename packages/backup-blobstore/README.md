# backup/blobstore
Copies one local file (typically a SQLite snapshot) to `blobstore@1` and restores it to `file`.
`source` (default: `file`) is what gets uploaded – point it at the snapshot written by
`persistence.snapshot:<source>` so the backup is transactionally consistent. With
`restoreOnStart` (default) the file is restored during setup when it is missing – for hosts with
ephemeral disks such as Cloud Foundry. List this module **before** `persistence-sqlite` in
`kestrel.config.ts` so setup runs before the database is opened.
`versions` (default 24) keeps timestamped copies `<key>.<iso-time>` next to the latest one and
prunes older ones; `backup.restore` takes an optional `key` from the payload to restore a specific
version, `backup.listVersions` lists them.

`backup.restore` never writes over the running database. It downloads the blob to
`<file>.restore-pending` and then writes the marker `<file>.restore-marker` containing the key;
setup applies both on the next start (it deletes `<file>`, `<file>-wal` and `<file>-shm`, renames
the staged file into place and removes the marker) and logs `applied pending restore`. A marker
without a staged file – an interrupted download – is dropped instead of applied. The step result is
`{ key, size, file, pending: true, appliedOnRestart: true }`; **restart the process** for it to take
effect. Preparing a restore twice keeps the newer one.

Every step returns a `Result`. A blobstore `Err` (`Err(TRANSIENT)`, 503, `retryable`) passes
through unchanged; `backup.restore` with an unknown or missing backup key is `Err(NOT_FOUND)`
(`no backup at <key>`), an unrecognised `key` in the payload is `Err(VALIDATION)`.
`restoreWhenMissing`/`applyPendingRestore` (called from `setup`) still throw on a real blobstore or
filesystem failure – a boot error, not a request.

| Step | reads | writes | errors |
|---|---|---|---|
| `backup.run` | – | `result` | `TRANSIENT` |
| `backup.restore` | – | `result` | `VALIDATION`, `NOT_FOUND`, `TRANSIENT` |
| `backup.listVersions` | – | `result` | `TRANSIENT` |

Typical trigger: `{ cron: "*/15 * * * *", pipeline: "backupDatabase" }` with steps
`["persistence.snapshot:./data/snapshot.db", "backup.run"]`. Provides no contract.
Not included: continuous replication (see `replication-sqlite`), restore without restart.
