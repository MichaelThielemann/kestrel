# backup/blobstore
Copies one local file (typically a SQLite snapshot) to `blobstore@1` and restores it to `file`.
`source` (default: `file`) is what gets uploaded – point it at the snapshot written by
`persistence.snapshot:<source>` so the backup is transactionally consistent. With
`restoreOnStart` (default) the file is restored during setup when it is missing – for hosts with
ephemeral disks such as Cloud Foundry. This module declares `before: [persistence@1]`, so it is set
up before `persistence-sqlite` by declaration, regardless of where either module sits in
`kestrel.config.ts`. If the file already exists and holds a restore point when `setup()` runs, was
not itself just restored, and was created during this very boot (judged by birth time against the
start of this boot; where the file system reports none, the order is not checked here), `setup()`
fails: that proves another module opened the file first. Move the named
file aside and start again – an ephemeral disk clears it for you on the next restart, a persistent
volume does not, so move it by hand there: a stale file left over from an earlier, unrelated
failure predates this boot, so this check stays quiet about it and the file still has to be moved
aside as instructed above. The pending restore's staged file and marker are left untouched either
way. When either this module or `replication-sqlite` restores the file, it writes
`<file>.restored-at` next to it: `{ "restoredAtBootStartedAt": <epoch ms this boot started> }`, plus
`"prepared": true` when the file is a prepared restore applied at setup rather than a restore of a
missing file. The other module, if configured on the same file, recognizes a matching boot as "this
boot already restored the file" and skips its own check — neither module has to know the other
exists. The next restore overwrites the sidecar.

`backup.checkRestored` tells the rest of a pipeline about the latest prepared restore of the file: it
adds `_databaseRestoredAt` to the result, the start of the boot that applied it (whichever of the two
modules prepared it, with `backup.restore` or `replication.prepareRestore`), or `null` when the sidecar
records none. The value stays the same in every later boot until the next restore, so a step that keeps
output derived from the database stores the last value it acted on and treats any other one as a
restore; a boot that stops before acting on it leaves it to the next one. The member is a shared
convention: `replication.checkRestored` writes the same one, and `delivery.checkBuild` of delivery-static
reads it to render every page again after a restore. Put the step first in the pipeline that runs that
check at boot, for example `["backup.checkRestored", "delivery.checkBuild", "delivery.requestIndexes"]`,
and only when `file` is the database. A restore of a missing file under `restoreOnStart` is not
reported, since on an ephemeral disk it happens at every start; a file copied into place by hand is not
reported either, so restore through `backup.restore` instead.

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
| `backup.checkRestored` | – | `result._databaseRestoredAt` | – |
| `backup.run` | – | `result` | `TRANSIENT` |
| `backup.restore` | – | `result` | `VALIDATION`, `NOT_FOUND`, `TRANSIENT` |
| `backup.listVersions` | – | `result` | `TRANSIENT` |

Typical trigger: `{ cron: "*/15 * * * *", pipeline: "backupDatabase" }` with steps
`["persistence.snapshot:./data/snapshot.db", "backup.run"]`. Provides no contract.
Not included: continuous replication (see `replication-sqlite`), restore without restart.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-backup-blobstore` – module `backup/blobstore`: provides no contract; requires `blobstore@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `file` | string | yes | – |
| `source` | string | no | – |
| `key` | string | yes | – |
| `restoreOnStart` | boolean | no | `true` |
| `versions` | integer | no | `24` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `backup.checkRestored` | When the latest prepared restore of the file was applied, by this module or another one (adds `_databaseRestoredAt`, the start of that boot or null, to the result) | – | `result._databaseRestoredAt` | – | { _databaseRestoredAt: number \| null, … } | – | – | no |
| `backup.run` | Back up the file | – | `result` | – | { key: string, size: number, versions: string[], … } | – | – | no |
| `backup.restore` | Stage the latest or a chosen version next to the file; applied on the next start | – | `result` | { key?: string } | { key: string, size: number, file: string, pending: true, appliedOnRestart: true, … } | 400 unknown version; 404 no backup | – | no |
| `backup.listVersions` | List backup versions | – | `result` | – | { versions: string[], … } | – | – | no |

<!-- kestrel-docs:end -->
