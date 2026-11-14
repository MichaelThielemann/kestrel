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
`"reported": true` when the restored file can be older than what was derived from the database before
it. The sidecar is written atomically, before the restored file is moved into place, so a boot that
stops in between restores the file again on the next start. The other module, if configured on the same file, recognizes a matching boot as "this
boot already restored the file" and skips its own check — neither module has to know the other
exists. The next restore overwrites the sidecar.

`backup.checkRestored` tells the rest of a pipeline about the latest reported restore of the file: it
adds `_databaseRestoredAt` to the result, the start of the boot that restored it, or `null` when the
sidecar records none. Every restore this module does is reported: a prepared one (`backup.restore`) and
the restore of a missing file under `restoreOnStart`, since both bring back a periodic backup that can
be older than anything derived from the database since then. On an ephemeral disk that is every start.
A prepared restore of `replication.prepareRestore` is reported as well. The value stays the same in
every later boot until the next restore, so a step that keeps output derived from the database stores
the last value it acted on and treats any other one as a restore; a boot that stops before acting on it
leaves it to the next one. The member is a shared convention: `replication.checkRestored` writes the
same one, and `delivery.checkBuild` of delivery-static reads it to render every page again after a
restore. Put the step directly before that check in the pipeline that runs it at boot, for example
`["backup.checkRestored", "delivery.checkBuild", "delivery.requestIndexes"]`, and only when `file` is
the database: a step in between that writes `result` replaces it and drops the member. A file copied into place by hand is not reported; restore through `backup.restore`
instead, or render everything again yourself (for delivery-static, `delivery.markAll` for every
delivered type).

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

**One process per file.** The first thing `setup()` does is take the instance lock on `file`, the
sidecar `<file>.instance` next to it: before it applies a pending restore or restores a missing file.
While another process holds the file, `setup()` fails with `instance-locked`, naming that process's
host and PID for a readable lock (an unreadable lock file is named instead), and leaves `file`, its `-wal` and `-shm`, `.restore-pending`, `.restore-marker` and
`.restored-at` as they are; with `restoreOnStart` it creates no file and reads no backup. The lock is
never uploaded with a backup. `persistence/sqlite` and `replication/sqlite` on the same file in the
same process share it, and teardown gives this module's share up; a `setup()` that fails gives it up
before boot reports the failure. `health()` answers `{ ok: true }` while the lock holds and `ok: false`
with `restartRequired: true` once another instance took it over. `allowConcurrentProcesses: true`
skips the lock; it has to be set alike on every module that names the file, otherwise boot fails
with `invalid-module-config`. This module is set up before `persistence/sqlite`, so with the option
here and not there the mismatch shows only after this module has run without a lock, also beside a
process that holds one, and it may have applied a pending restore or restored a missing file.

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
| `allowConcurrentProcesses` | boolean | no | `false` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `backup.checkRestored` | When the latest restore of the file was a prepared restore or a restore of a missing file from a periodic backup, by this module or another one (adds `_databaseRestoredAt`, the start of the boot that wrote it or null, to the result) | – | `result._databaseRestoredAt` | – | { _databaseRestoredAt: number \| null, … } | – | – | no |
| `backup.run` | Back up the file | – | `result` | – | { key: string, size: number, versions: string[], … } | – | – | no |
| `backup.restore` | Stage the latest or a chosen version next to the file; applied on the next start | – | `result` | { key?: string } | { key: string, size: number, file: string, pending: true, appliedOnRestart: true, … } | 400 unknown version; 404 no backup | – | no |
| `backup.listVersions` | List backup versions | – | `result` | – | { versions: string[], … } | – | – | no |

<!-- kestrel-docs:end -->
