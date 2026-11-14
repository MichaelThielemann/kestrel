# kestrel-ops
Verified backups and restore for a Kestrel instance that keeps its SQLite database in a
`replication-sqlite` replica and its media in an S3-compatible bucket. A backup holds the database, every
original the media rows reference and the public output of the delivery prefix; a restore brings all three
back in one run, after a backup of the state it replaces.

The package is a library and a runner. `runOps(argv)` from `@michaelthielemann/kestrel-ops/run` takes a
command line and returns its exit code; `writeBundle()` writes a self-contained `.kestrel-ops/` directory that
a deploy job runs with nothing but Node:

```
node .kestrel-ops/run.mjs status --env prod
node .kestrel-ops/run.mjs backup create --kind scheduled --env prod
```

Requires Node 22.18 or later. The only external programs it starts are the app command of a `local`
target, `ps` where `/proc` cannot tell a local app's start time, and the commands of `{ "command": [...] }`
credential sources, each without a shell; other targets
come as their own packages.

## Commands

| Command | What it does |
|---|---|
| `status` | Target state, newest replica generation and its seal, backups, open runs, held locks, clock skew against the store, and whether the app's own credentials can delete backups. Exit 1 when it finds a problem. |
| `backup create [--freeze] [--kind manual\|scheduled\|cutover]` | Writes a backup and verifies it. `--freeze` stops the app first and starts it again afterwards; without it the database comes from the replica of the running app. |
| `backup list` | Every backup of the environment, with its verification state and pins. |
| `backup verify <id>` | Verifies a backup again from what the backup location holds and records the result next to it. Exit 1 names the failing part or key; an id the location holds nothing under is reported, and nothing is written under that id (the run leaves its journal entries and lock trace like every writing command). |
| `backup prune [--dry-run]` | Removes backups beyond the retention of their kind and the objects nothing refers to any more. |
| `restore --backup <id> [--no-safety-backup]` | Restores a backup over the environment. |
| `restore --to local <dir> (--backup <id> \| --latest) [--with-media] [--keep-sessions]` | Writes a backup's database, or the newest replica generation, to `<dir>/kestrel.db` without login sessions; `--with-media` adds the originals under `<dir>/blobs/` after the `confirm` answer, asked before anything is written; when the backup holds originals whose keys differ only in case (as 5.x media keys can) and `<dir>` lies on a file system that does not tell such names apart (macOS by default), it refuses first, naming both keys. Files are written with mode 0600, new directories with 0700; a run that fails removes the files it wrote. |

Every command takes `--env <name>` (optional when the file names one environment), `--json` (one JSON
document on stdout, with a `schema` field such as `kestrel-ops/restore@1`), `--yes`, `--answers <file>`,
`--keep` (keep the local working directory) and `--break-lock`, and only the options its line above names.
Exit codes: 0 done, 1 a check failed or a step was refused, 2 a usage or configuration error, such as an
invalid `kestrel.environments.json`, or a project `package.json` that is not JSON when `backup create` or
`restore` records the project's package versions in a manifest. An option the
command does not take, a malformed backup id, or one of another environment ends the run with exit 2 before
it resolves credentials, loads the target or writes anything. With `--json`, a failure prints
`kestrel-ops/error@1` (`message`, `element`, and `backupId` when a backup was written and verified before the
failure, such as a frozen backup whose app does not become ready again), usage errors included; a journal
entry that cannot be written after the work is done is a warning on stderr and changes neither the document
nor the exit code.

## kestrel.environments.json
One file in the project root describes every environment. It holds no secret values, only where they come
from.

```json
{
  "environments": {
    "prod": {
      "production": true,
      "target": { "adapter": "local", "dir": "../app", "database": "data/kestrel.db", "command": ["node", "server.mjs"], "disk": "ephemeral", "readyUrl": "http://127.0.0.1:4100/ready" },
      "storage": {
        "bucket": "example-bucket",
        "endpoint": "https://s3.example.net",
        "region": "eu-central-1",
        "credentials": { "accessKeyId": { "env": "OPS_ACCESS_KEY" }, "secretAccessKey": { "command": ["pass", "show", "example/ops"] } }
      },
      "app": {
        "replicaPrefix": "database/",
        "mediaPrefix": "media/",
        "deliveryPrefix": "public/",
        "derivedPrefixes": ["media-variants/"],
        "credentials": { "accessKeyId": { "env": "APP_ACCESS_KEY" }, "secretAccessKey": { "env": "APP_SECRET_KEY" } }
      },
      "backups": { "prefix": "kestrel-backups/", "retention": { "cutover": 5, "scheduled": 14, "manual": 10, "pre-restore": 5 } }
    }
  }
}
```

- `storage` is the app's bucket, reached with the tool's own credentials. `prefix` (default empty) is the
  `prefix` of the app's `blobstore-s3`: every key below, and every key a media row stores, is relative to it.
  `requestChecksumCalculation: "WHEN_REQUIRED"` leaves out checksum trailers a store may reject. `region` is
  required next to an `endpoint`; without an endpoint it may come from `AWS_REGION` or the AWS config file.
  Without `credentials` the AWS SDK's default chain applies: the `AWS_*` variables, `~/.aws/credentials` or
  the instance's role.
- `app` names the prefixes the app writes: the replica, the originals, the public output and derived output
  (image variants), which a backup only lists. `media` (default `{ "collection": "media_items", "keyField":
  "key", "checksumField": "checksum" }`) says where the rows keep an original's key and its sha256.
  `app.credentials`, when given, are only used by `status` to prove that the app cannot delete backups.
- `backups.prefix` is the backup location; `backups.storage` puts it in another bucket. It must lie outside
  every app prefix and outside anything served publicly: a backup holds the whole database, password hashes
  and second factors included. The app prefixes must not lie inside each other either. While either rule is
  broken, every command but `status` and `backup list` stops with exit 2 before it writes anything, and
  `status` lists the problem. Give the app's credentials an explicit deny on the location; `status` reports
  `protected from the app: yes` only when a delete with them is refused. Several environments may share one
  location: prune keeps every object a backup of any of them refers to.
- `production` (default `true`) makes every restore that changes something ask for the `access-changes` answer.
- A credential is `{ "env": "NAME" }` or `{ "command": ["argv", "..."] }`, run without a shell, its standard
  output taken as the value with one trailing newline removed. A command that is not on `PATH`, does not
  finish within 60 s (a password manager waiting to be unlocked), prints more than 1 MiB or exits with an
  error stops the run with exit 2, naming which of these happened but never what it printed. Values stay in
  memory; every line the tool writes, to the terminal (questions included), the journal or a manifest,
  passes a redactor that masks them.

## Targets
A target stops, starts and describes the app. `local` runs it on this machine: `command` is started in `dir`
in the background as its own process group with only the variables in `env` (and `PATH`), its pid kept in
`.kestrel-ops.pid` with the process's start time (from `/proc` on Linux, from `ps` elsewhere, such as macOS). A
stop sends SIGTERM to the whole group, so a wrapper such as a package manager ends with the app. A pid file
written before the machine last booted, or whose pid now belongs to a process that started at another time,
names no running app and nothing is signalled. A pid of another user's process, or one whose start time is
missing in the file or cannot be read, reads as `unknown`, and the tool refuses to stop it or to restore over it.
`disk: "ephemeral"` removes the database before each start, so the app restores the newest replica
generation, as a container with an empty disk does; a restore then promotes a generation. `disk:
"persistent"` keeps the file, and a restore places the database as `<database>.restore`, which
`replication-sqlite` applies at the next start. Any other `adapter` is a package name, resolved from `root`
(then from where kestrel-ops is installed) and imported; it must export `createTarget(config, { root, clock })`.
A package that cannot be found stops the run with exit 2 as not installed, one that fails to load with exit 2
and the cause; `writeBundle()` copies each adapter the environments name, with
its dependencies, into the bundle. `root`, against which relative paths such as `dir` resolve,
is the directory that holds `kestrel.environments.json`; in a bundle that is `.kestrel-ops/` itself.

## Backups
```
<location>backups/<id>/manifest.json
<location>backups/<id>/db.sqlite          VACUUM INTO, integrity-checked
<location>backups/<id>/blobs.jsonl        per original: key, size, etag, sha256 of its row, object, objectEtag
<location>backups/<id>/site.jsonl         per key of the delivery prefix: key, size, etag, object, objectEtag
<location>backups/<id>/derived.jsonl      per key of a derived prefix: key, size, etag (not copied)
<location>backups/<id>/verify/<time>.json each verification result
<location>backups/<id>/pins/<run>.json    a run that keeps the backup from prune
<location>objects/<key>@<etag>            the bytes, shared by every backup that has this version
<location>runs/<run>/…                    the journal, one object per step
<location>locks/<run>/…                   the lock trace
<location>recent/<yyyymmdd>/<n>.json      the id of each backup written that day, numbered from 0
<location>placements/<env>/<generation>/<run>.json  a generation a restore began to promote
```

The id reads `<env>-<yyyymmddThhmmssZ>-<kind>-<4 hex>`. Every key is written once and never overwritten: a
verification, a pin, a journal entry or a lock heartbeat is a new key, so a store whose overwrites are only
eventually consistent never serves a stale version of any of them. `manifest.json` is written last; a backup
without one is incomplete.

The database comes from the replica, rebuilt from the newest generation, so it is the state the app shipped,
not a file copied from a disk. The instance-lock file a running app keeps next to its database
(`instanceLockFile()` of `@michaelthielemann/kestrel/instanceLock`) is therefore never part of a backup, and no
restore writes or removes it: the `local` target places a restored database as `<file>.restore` and the app
applies it at its next start. The originals are the keys the media rows reference, copied server-side into
`objects/` through the admin client of `kestrel-blobstore-s3` (`createS3Admin().copy` with `ifMatch` set to the
listed ETag): the store refuses the copy when the original changed in between, a store that ignores
`x-amz-copy-source-if-match` is caught by reading the source's ETag again, and a copy whose size or ETag does not
match is removed. The key is then listed again and the new version is copied. A copy whose ETag differs while the
source still has the listed one is kept (a multipart or KMS-encrypted source has no MD5 ETag). `objectEtag` in
`blobs.jsonl` and `site.jsonl` records the ETag the copy got. When `backups.storage` names another bucket or
other credentials, the bytes are read with `If-Match` and written with the source's Content-Type, and an
original that does not hash to the checksum of its row stops the backup. A referenced original missing in the
store is recorded in `missingAtBackup`.
With `--freeze` the originals and the delivery prefix are copied once while the app runs and only the
difference after the stop.

A frozen backup records how the replica proves the stop was complete. A runtime that seals its replica
writes `gen/<generation>/sealed.json` at teardown: the backup reads `sealed`, whatever version the target
reports, once a listing shows every WAL segment the seal counts, and builds the database from that listing; a
listing that keeps lacking one stops the backup with exit 1. Without it the backup reads `unsealed` (the process stopped without teardown, so frames written after
its last sync may be missing), `unsupported` for a runtime before 6, or `unknown` when the target cannot tell
the runtime version. All three show the time of the last shipped segment and need the answer
`unsealed-stop`. A newest generation reads `placed` when a restore of this environment recorded its placement,
it has the plain time name of a promotion, holds `origin.json` but neither a WAL segment nor `applied.json`, and
the journal of the restore that placed it shows no start of the app after the promotion: no app started from
it, so its snapshot is the whole database and no answer is needed. A generation the app began itself, which
carries a copy of `origin.json` until the restore is acknowledged, and a promoted generation the restore started
the app from are `unsealed` after a kill like any other. A backup of a running app reads `live`. A runtime numbers the segments of a generation
consecutively, so whatever the seal, a listing that shows a later segment without an earlier one is listed
again, and a gap that stays stops the backup with exit 1, naming the missing number. The `local` target reads the runtime version from
the packages the app resolves, also when it gets `replication-sqlite` through another package.

Verification works only from what the backup location holds: it downloads `db.sqlite`, compares its sha256
with the manifest, runs a full `integrity_check`, counts the rows of every table, checks that every original
a row references has an entry and an object of the recorded size and that every delivery key has one, and
hashes a sample of originals (25 or 2 %, whichever is more, at most 200) against the checksum of their row.
Listings may lag behind writes: an object the listing does not show yet is looked up with a HEAD before it
counts as missing, a backup copies a key only after a HEAD found no object under it (an object there whose size differs from
the source's is damaged: the backup stops with exit 1 and names it, and never writes over it), and the delivery prefix
is listed until two listings agree.

## Restore
1. The backup is verified again, then the app is stopped and must report stopped with no instance. A backup
   taken under another delivery prefix than the environment names is refused before the stop.
2. The stopped replica is rebuilt and compared with the backup. The report counts, per table, the rows the
   restore drops, reverts and brings back, the audit entries the backup does not hold, and the access changes: users
   created, deleted or deactivated, changed roles and reset second factors. A restore that would bring back
   revoked access, or any restore of a `production` environment, needs the answer `access-changes`.
   When the stopped replica has no generation or its newest one cannot be rebuilt (a listing that does not settle,
   or a segment that stays missing, also against its seal), there is nothing to compare:
   the restore says so and goes on only after the answer `unreadable-current`. A store operation that fails
   while the replica is read, such as a timeout, or a signal that arrives then, ends the restore before it
   changed anything and starts the app again.
3. A `pre-restore` backup of the stopped state is written and verified, so the restore itself can be undone
   with `restore --backup <that id>`. Only `--no-safety-backup` skips it. Over an unreadable replica it holds
   every original under the media prefix and the delivery keys but no database (`db` is null in its
   manifest); `restore` refuses such a backup, and its `blobs.jsonl` and `site.jsonl` name the objects.
4. Every original of the backup whose key is missing or holds other bytes is copied back. No original is
   deleted; ones uploaded after the backup stay and are listed. A copy back over a key is a single CopyObject
   request (or a write, across buckets) that never removes the key when it fails or reads back late.
5. The delivery prefix is set to the backup's: keys that differ are written, then keys the backup does not
   know are removed. This and `backup prune` are the only places the tool deletes data.
   A key whose size matches but whose ETag is neither the recorded one nor the copy's (a store that encrypts
   with KMS gives every write a new ETag) is compared by its sha256, so a second restore stays a no-op there
   too; a written delivery key counts as read back once a HEAD shows its size with an ETag other than the one before.
6. The login sessions of the restored database are emptied: everyone signs in again.
7. The database is promoted as the newest replica generation, or placed as `<database>.restore`, and the app
   is started. `<database>.restore` is copied under a temporary name next to it, flushed and then renamed, so a
   start never finds a partial file.

When nothing differs from the backup apart from login sessions, the restore asks nothing more, starts the app
again and changes nothing; the sessions stay. When it stops
before step 4, it starts the app again; after that, until step 7 started the app, the app stays stopped and the
output says so, naming the `pre-restore` backup when there is one. Once the app was started, the output says
that instead: an app that does not become ready ends the restore with exit 1, while a check that fails once the
app runs again, such as reading its acknowledgement or writing a journal entry, is a warning: the restore ends
with exit 0, `unconfirmed` when the acknowledgement could not be read.

Before it writes the snapshot of its promotion, a restore records the generation under
`<location>placements/<env>/`. A restore that stops between the snapshot and `origin.json` leaves an unfinished
placement: a recorded generation with a snapshot and nothing else, which a runtime that understands
`origin.json` refuses to start from. Only a recorded generation counts; one a runtime wrote, such as the
generation holding only a snapshot that a 5.x runtime writes at every start and every `snapshotSeconds`, never
does. `status` names an unfinished placement as a problem, and `backup create` refuses while it is the newest
generation. The next restore warns about it, reads the generation before it as the current state, never ends as
a no-op while it is the newest, and promotes a complete generation after it. A restore that stops after
`origin.json` but before the app started leaves a complete placement (`placed`); the next run starts the app from
it and ends as a no-op.

### Promotion
A promoted generation is a `VACUUM INTO` copy without `-wal`, named `gen/<yyyymmddThhmmssZ>/snapshot.db` by
the store's time rounded up to the next second and at least one second after the newest generation. That
plain time name is listed and restored by every replication runtime, which takes the newest generation by
name. Next to it, written after the snapshot as the last file of the placement, `origin.json` (`{ kind,
source, requestedAt, nonce }`, `requestedAt` as ISO 8601) lets a runtime that understands it
report the restore through `replication.checkRestored`, so `delivery.checkBuild` renders every output again,
and acknowledge it with an `applied.json` in the promoted generation carrying the same nonce once the run that
read the report ended without failure. The tool reads that file after the start and reports `applied`, or
`unconfirmed` when it does not appear; the runtime then reports the restore once more on its next start, which
renders the output one more time. The three files follow the formats `replication-sqlite` defines (its README,
"Replica layout"). A runtime that ignores
`origin.json` still restores the generation; the restored delivery prefix then stands for the rendered
output.

Promotion refuses unless the target is stopped with no running instance, when this machine's clock is more
than 30 s off the store's, and when the newest generation is stamped more than 30 s after the store's time,
since the app could only start once the store's time passed the new name; the restore checks all three before it writes the `pre-restore` backup, so a
refusal leaves the store as it was and starts the app again. The store's time comes from the `LastModified` of
a probe object found by listing (`createS3Admin().serverTime`, the probe lies under `.kestrel-clock/` and is
removed again), since some stores send no usable `Date` header. It is measured at the store
the replica lives in: in the backup location when that shares the app's store, otherwise below the replica
prefix, outside the keys a runtime reads. `status` shows the same measurement. The generation is listed until it is the newest in
consecutive listings, then read back, hashed and integrity-checked; the app starts once the store's time has
passed its name.

## Questions
| Id | Asked | `--yes` |
|---|---|---|
| `confirm` | before a restore stops the app, before `--with-media` downloads | answers yes |
| `unsealed-stop` | a stopped replica without a seal | never |
| `access-changes` | a restore of a production environment that changes something, or one that brings back revoked access | never |
| `unreadable-current` | a restore over a replica without a generation or with one that cannot be rebuilt | never |
| `prune-delete` | before prune deletes | answers yes |
| `break-lock` | `--break-lock` finds a lock another run holds | never |

`--answers <file>` is a JSON object from id to answer (`"yes"` or `"accept"`); a relative path is read from
the directory the tool is called in, and a file that is missing or not JSON stops the run with exit 2. Without a terminal and
without an answer, the run stops at the question with exit 1.

## Retention and prune
`backup prune` keeps the newest verified backups of each kind (default `cutover` 5, `scheduled` 14, `manual`
10, `pre-restore` 5); only verified backups count. A failed or unverified backup stays while it is newer than the
oldest verified one kept, or, when its kind has no verified backup, while it is among the newest of the count.
Prune also keeps every pinned backup and the newest verified backup of each Kestrel major, then removes the
objects no kept backup refers to. Nothing younger than a day is removed. A backup reuses an object it finds
under `objects/` without writing it again, so the object's age does not protect it; a backup the listing does
not show yet still counts, since prune reads the backups of today and yesterday from `recent/`, which it finds
by key, not by listing, and forgets older days there. It refuses while another run is open (a journal
without an end entry, active in the last two hours) or holds the lock. Interactive runs ask before deleting;
`--dry-run` only lists.

## Lock and journal
A writing command takes the lock: a start entry under `locks/<run>/`, a heartbeat every ten minutes and a
release entry. A lock without a heartbeat for two hours is stale; `--break-lock` releases a lock whose run
ended without releasing it, after the answer `break-lock`. Without a conditional write the trace
cannot exclude a second operator who starts at the same moment, so serialize runs where they are started
(one operator, or an exclusive deploy environment). The journal records each step with its inputs and
outputs (ids, hashes, counts) under `runs/<run>/`, mirrored into the local working directory:
`$XDG_STATE_HOME/kestrel/runs/<run>` on Linux, `~/Library/Application Support/kestrel/runs/<run>` on macOS,
mode 0700, removed after the run unless `--keep`.

SIGINT or SIGTERM (Ctrl-C, or a CI job that is cancelled or times out) ends a writing command at its next
store operation, or at once while it waits at a question, with exit 1 and `interrupted by <signal>`. What a
failure at that point does then happens: a frozen backup, or a restore that has not changed the store yet,
starts the app again, and the run releases its lock and ends its journal. A second signal ends the process
at once.

## Testing
`@michaelthielemann/kestrel-ops/testing` exports `MemoryBucket` and `memoryStore`, an in-memory object store
that records every write and can lag listings, ignore `copy-source-if-match` or change a key just before it is
copied.

Not included: other persistence engines than SQLite with `replication-sqlite`, more than one instance,
backups of secret values.
