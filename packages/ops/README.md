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
target and the commands of `{ "command": [...] }` credential sources, each without a shell; other targets
come as their own packages.

## Commands

| Command | What it does |
|---|---|
| `status` | Target state, newest replica generation and its seal, backups, open runs, held locks, clock skew against the store, and whether the app's own credentials can delete backups. Exit 1 when it finds a problem. |
| `backup create [--freeze] [--kind manual\|scheduled\|cutover]` | Writes a backup and verifies it. `--freeze` stops the app first and starts it again afterwards; without it the database comes from the replica of the running app. |
| `backup list` | Every backup of the environment, with its verification state and pins. |
| `backup verify <id>` | Verifies a backup again from what the backup location holds. Exit 1 names the failing part or key. |
| `backup prune [--dry-run]` | Removes backups beyond the retention of their kind and the objects nothing refers to any more. |
| `restore --backup <id> [--no-safety-backup]` | Restores a backup over the environment. |
| `restore --to local <dir> (--backup <id> \| --latest) [--with-media] [--keep-sessions]` | Writes a backup's database, or the newest replica generation, to `<dir>/kestrel.db` without login sessions; `--with-media` adds the originals under `<dir>/blobs/`. Files are written with mode 0600, new directories with 0700. |

Every command takes `--env <name>` (optional when the file names one environment), `--json` (one JSON
document on stdout, with a `schema` field such as `kestrel-ops/restore@1`), `--yes`, `--answers <file>`,
`--keep` (keep the local working directory) and `--break-lock`. Exit codes: 0 done, 1 a check failed or a
step was refused, 2 a usage or configuration error.

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
  `requestChecksumCalculation: "WHEN_REQUIRED"` leaves out checksum trailers a store may reject.
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
- `production` (default `true`) makes every restore ask for the `access-changes` answer.
- A credential is `{ "env": "NAME" }` or `{ "command": ["argv", "..."] }`, run without a shell, its standard
  output taken as the value. Values stay in memory; every line the tool writes, to the terminal, the journal
  or a manifest, passes a redactor that masks them.

## Targets
A target stops, starts and describes the app. `local` runs it on this machine: `command` is started in `dir`
in the background with only the variables in `env` (and `PATH`), its pid kept in `.kestrel-ops.pid`.
`disk: "ephemeral"` removes the database before each start, so the app restores the newest replica
generation, as a container with an empty disk does; a restore then promotes a generation. `disk:
"persistent"` keeps the file, and a restore places the database as `<database>.restore`, which
`replication-sqlite` applies at the next start. Any other `adapter` is imported by package name and must
export `createTarget(config, { root, clock })`; `writeBundle()` copies each adapter the environments name, with
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
```

The id reads `<env>-<yyyymmddThhmmssZ>-<kind>-<4 hex>`. Every key is written once and never overwritten: a
verification, a pin, a journal entry or a lock heartbeat is a new key, so a store whose overwrites are only
eventually consistent never serves a stale version of any of them. `manifest.json` is written last; a backup
without one is incomplete.

The database comes from the replica, rebuilt from the newest generation, so it is the state the app shipped,
not a file copied from a disk. The originals are the keys the media rows reference, copied server-side into
`objects/` with `x-amz-copy-source-if-match` set to the listed ETag; when the original changed in between,
the copy is refused, the key is listed again and the new version is copied. A store that ignores the header is
caught by a HEAD on the copy: a copy whose ETag differs while the source still has the listed one is kept (a
multipart or KMS-encrypted source has no MD5 ETag), any other mismatch removes the copy and copies the new
version. `objectEtag` in `blobs.jsonl` and `site.jsonl` records the ETag the copy got. When `backups.storage`
names another store, the bytes are read with `If-Match` and written with the source's Content-Type, and an
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
`unsealed-stop`. A backup of a running app reads `live`. The `local` target reads the runtime version from
the packages the app resolves, also when it gets `replication-sqlite` through another package.

Verification works only from what the backup location holds: it downloads `db.sqlite`, compares its sha256
with the manifest, runs a full `integrity_check`, counts the rows of every table, checks that every original
a row references has an entry and an object of the recorded size and that every delivery key has one, and
hashes a sample of originals (25 or 2 %, whichever is more, at most 200) against the checksum of their row.
Listings may lag behind writes: an object the listing does not show yet is looked up with a HEAD before it
counts as missing, a backup copies a key only after a HEAD found no object under it, and the delivery prefix
is listed until two listings agree.

## Restore
1. The backup is verified again, then the app is stopped and must report stopped with no instance.
2. The stopped replica is rebuilt and compared with the backup. The report counts, per table, the rows the
   restore drops, reverts and brings back, the audit entries the backup does not hold, and the access changes: users
   created, deleted or deactivated, changed roles and reset second factors. A restore that would bring back
   revoked access, or any restore of a `production` environment, needs the answer `access-changes`.
   When the stopped replica has no generation or its newest one cannot be rebuilt, there is nothing to compare:
   the restore says so and goes on only after the answer `unreadable-current`.
3. A `pre-restore` backup of the stopped state is written and verified, so the restore itself can be undone
   with `restore --backup <that id>`. Only `--no-safety-backup` skips it. Over an unreadable replica it holds
   every original under the media prefix and the delivery keys but no database (`db` is null in its
   manifest); `restore` refuses such a backup, and its `blobs.jsonl` and `site.jsonl` name the objects.
4. Every original of the backup whose key is missing or holds other bytes is copied back. No original is
   deleted; ones uploaded after the backup stay and are listed.
5. The delivery prefix is set to the backup's: keys that differ are written, then keys the backup does not
   know are removed. This and `backup prune` are the only places the tool deletes data.
6. The login sessions of the restored database are emptied: everyone signs in again.
7. The database is promoted as the newest replica generation, or placed as `<database>.restore`, and the app
   is started.

When nothing differs from the backup, the restore starts the app again and changes nothing. When it stops
before step 4, it starts the app again; after that the app stays stopped and the output says so.

### Promotion
A promoted generation is a `VACUUM INTO` copy without `-wal`, named `gen/<yyyymmddThhmmssZ>/snapshot.db` by
the store's time rounded up to the next second and at least one second after the newest generation. That
plain time name is listed and restored by every replication runtime, which takes the newest generation by
name. Next to it, written after the snapshot as the last file of the placement, `origin.json` (`{ kind,
source, requestedAt, nonce }`, `requestedAt` as ISO 8601) lets a runtime that understands it
report the restore, so output derived from the database is rendered again, and acknowledge it with an
`applied.json` carrying the same nonce; the tool reports `applied` or `unconfirmed`. A runtime that ignores
`origin.json` still restores the generation; the restored delivery prefix then stands for the rendered
output.

Promotion refuses unless the target is stopped with no running instance, when this machine's clock is more
than 30 s off the store's, and when the newest generation is stamped more than 30 s after the store's time,
since the app could only start once the store's time passed the new name; the restore checks all three before it writes the `pre-restore` backup, so a
refusal leaves the store as it was and starts the app again. The store's time comes from the `LastModified` of
a probe object found by listing, since some stores send no usable `Date` header. It is measured at the store
the replica lives in: in the backup location when that shares the app's store, otherwise below the replica
prefix, outside the keys a runtime reads. `status` shows the same measurement. The generation is listed until it is the newest in
consecutive listings, then read back, hashed and integrity-checked; the app starts once the store's time has
passed its name.

## Questions
| Id | Asked | `--yes` |
|---|---|---|
| `confirm` | before a restore stops the app, before `--with-media` downloads | answers yes |
| `unsealed-stop` | a stopped replica without a seal | never |
| `access-changes` | a restore of a production environment or one that brings back revoked access | never |
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
objects no kept backup refers to. Nothing younger than a day is removed. It refuses while another run is open (a journal
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

## Testing
`@michaelthielemann/kestrel-ops/testing` exports `MemoryBucket` and `memoryStore`, an in-memory object store
that records every write and can lag listings, ignore `copy-source-if-match` or change a key just before it is
copied.

Not included: other persistence engines than SQLite with `replication-sqlite`, more than one instance,
backups of secret values.
