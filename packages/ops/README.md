# kestrel-ops
Verified backups, restore and updates for a Kestrel instance that keeps its SQLite database in a
`replication-sqlite` replica and its media in an S3-compatible bucket. A backup holds the database, every
original the media rows reference and the public output of the delivery prefix; a restore brings all three
back in one run, after a backup of the state it replaces; an update moves the instance to a new release with a
verified cutover backup, a migrated copy of its database and an automatic rollback.

The package is a library and a runner. `runOps(argv)` and `runUpdate(argv)` from
`@michaelthielemann/kestrel-ops/run` take a command line and return its exit code; `writeBundle()` writes a
self-contained `.kestrel-ops/` directory that a deploy job runs with nothing but Node and the platform's client:

```
node .kestrel-ops/run.mjs status --env prod
node .kestrel-ops/run.mjs backup create --kind scheduled --env prod
node .kestrel-ops/run.mjs deploy --env prod
node .kestrel-ops/run.mjs update status --env prod
```

Requires Node 22.18 or later. The only external programs it starts are the app command of a `local`
target, `ps` where `/proc` cannot tell a local app's start time, the commands of `{ "command": [...] }`
credential sources and the local start of a release that `update.localBoot` configures, each without a shell;
other targets come as their own packages.

## Commands

| Command | What it does |
|---|---|
| `status` | Target state, newest replica generation and its seal, backups, open runs, held locks, clock skew against the store, and whether the app's own credentials can delete backups. Exit 1 when it finds a problem. |
| `backup create [--freeze] [--kind manual\|scheduled\|cutover]` | Writes a backup and verifies it. `--freeze` stops the app first and starts it again afterwards; without it the database comes from the replica of the running app. |
| `backup list` | Every backup of the environment, with its verification state and pins. |
| `backup verify <id>` | Verifies a backup again from what the backup location holds and records the result next to it. Exit 1 names the failing part or key; an id the location holds nothing under is reported, and nothing is written under that id (the run leaves its journal entries and lock trace like every writing command). |
| `backup prune [--dry-run]` | Removes backups beyond the retention of their kind and the objects nothing refers to any more. |
| `restore --backup <id> [--no-safety-backup]` | Restores a backup over the environment. |
| `restore --to local <dir> (--backup <id> \| --latest) [--with-media] [--keep-sessions]` | Writes a backup's database, or the newest replica generation, to `<dir>/kestrel.db` without login sessions; `--latest` skips an unfinished placement of a failed restore on top of the replica, names it, and copies the generation before it; `--with-media` adds the originals under `<dir>/blobs/` after the `confirm` answer, asked before anything is written, directories included, and refuses first, naming `blobs.jsonl`, when that list holds another number of entries than the manifest counts; when the backup holds originals whose keys differ only in case (as 5.x media keys can) and `<dir>` lies on a file system that does not tell such names apart (macOS by default), it refuses first, naming both keys. Files are written with mode 0600, new directories with 0700; a run that fails removes the files and the directories it created. |

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
  memory. Every line the tool writes to the terminal, questions included, passes a redactor that masks them,
  also where one is part of other text. The documents it stores (journal, manifests, verifications, receipts,
  the recorded configuration) and the `--json` output hold names, ids, keys and hashes, never a credential's
  value; only a plain value of the recorded configuration in which a credential shorter than 16 characters is part
  of a name, a host or a path, such as `kestrel-media` for the access key `kestrel`, is kept verbatim, while one in
  which it stands as a token of its own, such as `minio:minioadmin`, is kept as a fingerprint. Their schema, keys, names and every other field are written as they are; only the free-text fields
  `message`, `error`, `failure`, `detail` and `problems` are masked, since a failed call may quote what it was
  sent. A credential that is part of a fixed text, such as an access key `kestrel`, therefore never changes a
  schema, key or name. In terminal lines, questions and messages, what the tool writes itself (questions and
  their ids, command names, flags, environment names, run, backup and droplet ids) stays as written even when a
  credential equals one of its words, so `next: kestrel update accept --env prod --run …` stays copyable with
  the access key `kestrel`; a credential is masked wherever it occurs in text from elsewhere, such as an answer
  to a question, an error of the store, an answer of the platform or a table, user or host name read from the
  data, and a credential of 16 characters or more is masked everywhere. `run.next` of
  `update status --json` names the next command for a pipeline.

- `update` (optional) configures updates: `release.dir` (default `.`), the directory a target stages as the new
  release, relative to the environments file; `localBoot`, the start of a release on this machine that applies
  content migrations to a database copy (`command`, `dir`, `env` with the placeholders `{database}`, `{blobs}`,
  `{port}` and `{build}`, `readyPath`, `timeoutSeconds`); and the waits `sealTimeoutSeconds` (60),
  `syncWindowSeconds` (120), `renderTimeoutSeconds` (600), `readyTimeoutSeconds` (300) and `cleanupAfterDays`
  (14). See [Update](#update).

## Targets
A target stops, starts and describes the app. `local` runs it on this machine: `command` is started in `dir`
in the background as its own process group with only the variables in `env` (and `PATH`), its pid kept in
`.kestrel-ops.pid` with the process's start time (from `/proc` on Linux, from `ps` elsewhere, such as macOS). A
stop sends SIGTERM to the whole group and resolves once no process of the group is left, so a wrapper that ends
at once, such as `sh -c` running several commands, does not hide an app still in its teardown; while any process
of the group runs, the app counts as started. A command that cannot be started, such as a missing program, ends
the run with an error instead of a crash, exit 2 when the program is missing or not executable. A pid file
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
<location>backups/<id>/pins/<run>.json    a run that keeps the backup from prune until it ends
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
`x-amz-copy-source-if-match` is caught by reading the source's ETag again, a store that refuses the header even
while the source has the listed ETag gets that and every later copy of the run without it, checked by comparing
the source's ETag before and after, and a copy whose size or ETag does not
match is removed. The key is then listed again and the new version is copied. A copy whose ETag differs while the
source still has the listed one is kept (a multipart or KMS-encrypted source has no MD5 ETag). `objectEtag` in
`blobs.jsonl` and `site.jsonl` records the ETag the copy got. When `backups.storage` names another bucket or
other credentials, the bytes are read with `If-Match` and written with the source's Content-Type, and an
original that does not hash to the checksum of its row stops the backup. A referenced original missing in the
store is recorded in `missingAtBackup`. A `pre-restore` backup takes a damaged original as the store holds it
instead of stopping: it hashes the originals that verification samples, records every original whose bytes do not
match the checksum of its row in `mismatchAtBackup` with the sha256 it found, warns about each, and verification
accepts that sha256 for them. So a restore that repairs an overwritten original still writes its undo backup.
With `--freeze` the originals and the delivery prefix are copied once while the app runs and only the
difference after the stop.

A frozen backup records how the replica proves the stop was complete. A runtime that seals its replica
writes `gen/<generation>/sealed.json` at teardown: the backup reads `sealed`, whatever version the target
reports, once a listing shows every WAL segment the seal counts, and builds the database from that listing; a
listing that keeps lacking one stops the backup with exit 1. Without it the backup reads `unsealed` (the process stopped without teardown, so frames written after
its last sync may be missing), `unsupported` for a runtime before 6, or `unknown` when nothing tells the runtime
version. The cutover backup of a deploy whose running versions are unknown reads `unsupported` as well when the
stored data the pending storage migrations convert was written by a release before 6, which then stands for the
runtime. All three show the time of the last shipped segment and need the answer
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
with the manifest, runs a full `integrity_check`, counts the rows of every table, checks that `blobs.jsonl` and
`site.jsonl` hold as many entries as the manifest counts and that the delivery keys hash to its `pathsSha256`
(a list cut at a line boundary still parses, so only the manifest tells it is short), checks that every original
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
   with `restore --backup <that id>`. Only `--no-safety-backup` skips it; when the `pre-restore` backup fails,
   the restore ends before it changed anything and its error names that flag. Over an unreadable replica it holds
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
before its first write to the app's store (a copy or removal in step 4 or 5, or the promotion or placement in
step 7), it says the store is unchanged and starts the app again; after that write, until step 7 started the app,
the app stays stopped and the output says so, naming the `pre-restore` backup when there is one. Once the app was started, the output says
that instead: an app that does not become ready, or one that starts a generation sorting before the promoted one
(see the clock checks below), ends the restore with exit 1, while a check that fails once the
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
it and ends as a no-op. A no-op that starts the app from a promoted generation the app has not acknowledged (one
with `origin.json` and no `applied.json`, such as a placement or a promotion a runtime before 6 started from)
waits and checks the order like a promotion (see below), so it too ends with exit 1 when the app starts a
generation that sorts before it.

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
removed again; credentials that may not remove it get the measurement all the same and a warning, once per
command), since some stores send no usable `Date` header. It is measured at the store
the replica lives in: in the backup location when that shares the app's store, otherwise below the replica
prefix, outside the keys a runtime reads. `status` shows the same measurement. The generation is listed until it is the newest in
consecutive listings, then read back, hashed and integrity-checked; the app starts once both the store's time
and this machine's clock have reached the second after its name, since a runtime before 6 names the generation
it starts by its own clock alone and would otherwise sort it before the promoted one. For the `local` target this
machine's clock is the app's. A target on another machine whose clock runs further behind starts a generation
that sorts before the promoted one; the restore then ends with exit 1, names both generations and asks to stop
the app, correct its clock and restore again, since the app's next start would restore the promoted generation
and drop what it wrote since. A runtime before 6 writes that generation only at its first `replication.sync`,
which a cron trigger runs up to a minute after the start, so the restore lists the replica again until a generation
of the app appears, for at most 90 s after the start (`generationWaitMs` of `runOps`). When none appears in that
time, or when listing the replica fails during the wait, the restore ends with exit 0 and `ownGeneration: null`,
and its output says that the order is unconfirmed: once the app's generation appears, it must be the newest one,
not the promoted generation. A signal during the wait ends the restore with exit 1 and `interrupted by <signal>`,
and its output says both that the app was started again and that the order is unconfirmed. A runtime from 6 on
names every generation after the ones it listed, so the restore does not wait for it.

## Update
| Command | What it does |
|---|---|
| `update prepare [--full-media]` | Preflight, plan and rehearsal on a copy of the newest replica generation; writes the receipt a deploy with a version change or a pending storage migration needs. |
| `deploy` | In the deploy job: gate, staging while the app runs, recorded configuration, precopy, stop, seal, verified cutover backup, migration of a copy of its database, promotion, swap and start as one step, verification; after a passed verification the older releases are deleted, after a failed one the cutover state comes back. |
| `verify` | Verifies the running release of a halted run again. |
| `update accept`, `rollback`, `resume`, `abort` | Close, roll back, continue or end the newest deploy run, or the one `--run <id>` names. |
| `update status` | Every update run of the environment from the backup location, with its hosts, state, next command and the time and downtime of each step. Takes no lock. |
| `update cleanup [--dry-run]` | After `cleanupAfterDays`: removes the originals only the cutover backup still references and releases its pin. A deploy pins its cutover backup only for a change of the major, unknown running versions or a pending storage migration; a rollback or an abort that brought the previous release back releases the pin as well. |
| `update bundle [--out <dir>]` | Writes `.kestrel-ops/` with the release's versions, the target manifests, the module packages whose storage migrations a deploy runs and the host facts `RunOptions.host` passes. |

`runUpdate` takes the same `RunOptions` as `runOps`, plus `releaseRoot` (the directory `update.release.dir` is
relative to), `host` (the facts a host plugin contributes) and, for tests, `updateSteps` and `updateCommands`. It
refuses a target that does not implement `UpdateTarget` with exit 2, takes the lock for every command but `status`,
writes into the journal of the deploy run it continues, and exits 0, 1, 2 or 3 (rolled back automatically); with
`--json` it prints `kestrel-ops/update-<command>@1`. The migration of the cutover copy downloads its database again
on every run, writes blobs to the app's store only as server-side copies or new keys, and applies content
migrations through `update.localBoot` with an environment of exactly its configured values. The repository's
`docs/operations.md` describes an update step by step.

## Questions
| Id | Asked | `--yes` |
|---|---|---|
| `confirm` | before a restore stops the app, before `--with-media` downloads | answers yes |
| `unsealed-stop` | a stopped replica without a seal | never |
| `access-changes` | a restore of a production environment that changes something, or one that brings back revoked access | never |
| `unreadable-current` | a restore over a replica without a generation or with one that cannot be rebuilt | never |
| `prune-delete` | before prune deletes | answers yes |
| `break-lock` | `--break-lock` finds a lock another run holds | never |
| `update-stop` | before a deploy stops the app | answers yes |
| `rollback-accepted` | `update rollback` or `update abort` after accept, or before it once the stopped new release holds what it wrote since its start; the answer is the environment's name | never |
| `cleanup-delete` | before `update cleanup` removes originals | never |

`--answers <file>` is a JSON object from id to answer (`"yes"` or `"accept"`); a relative path is read from
the directory the tool is called in, and a file that is missing or not JSON stops the run with exit 2. Without a terminal and
without an answer, the run stops at the question with exit 1.

## Retention and prune
`backup prune` keeps the newest verified backups of each kind (default `cutover` 5, `scheduled` 14, `manual`
10, `pre-restore` 5); only verified backups count. A failed or unverified backup stays while it is newer than the
oldest verified one kept, or, when its kind has no verified backup, while it is among the newest of the count.
Prune also keeps every backup pinned by a run that has not ended (a run without an end entry, active in the last
two hours), every backup an update pinned until its pin is released, and the newest verified backup of each Kestrel
major (named by the manifest's versions, or by its `major` when it records no versions), then removes the objects
no kept backup refers to.
The `pre-restore` backup of a failed restore stays pinned in `backup list`, but once that run ended it counts
towards the retention of its kind like any other. Nothing younger than a day is removed. A backup reuses an object it finds
under `objects/` without writing it again, so the object's age does not protect it; a backup the listing does
not show yet still counts, since prune reads the backups of today and yesterday from `recent/`, which it finds
by key, not by listing, and forgets older days there. It refuses while another run is open (a journal
without an end entry, active in the last two hours) or holds the lock, and when the `blobs.jsonl` or `site.jsonl`
of a backup it keeps cannot be parsed or holds another number of entries than its manifest counts, since the
objects that backup refers to are then unknown. A backup's
verification state is the result of its newest verification; a `manifest.json`, `blobs.jsonl` or `site.jsonl`
that cannot be parsed fails it. Interactive runs ask before deleting;
`--dry-run` only lists. A run that deletes also removes, after the backups and objects that are due, the clock and
protection probes older than an hour that a refused delete left under `.kestrel-clock/` or `probes/` of the backup
location, and below the replica prefix when the backup location lies in a store of its own; a probe its credentials
may not list or delete there stays, and the prune warns once and ends as it would without it.

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

The repository's tests run backup and restore against the upgrade fixture of 5.8.1. `pnpm test:published-runtime`
installs the replication package of that release from the npm registry and boots the fixture with it: it restores
the replica as the published code does at a start without a database file, a backup reports the seal as
`unsupported`, and after a restore the published code starts from the promoted generation and names its own
generation after it. It needs network access and runs in CI as a job of its own.

Not included: other persistence engines than SQLite with `replication-sqlite`, more than one instance,
backups of secret values.
