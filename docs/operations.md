# Operations

How to back up, restore and update a deployed Kestrel instance with `@michaelthielemann/kestrel-ops`. The tool
works on an app that keeps its SQLite database in a `replication-sqlite` replica and its media in an
S3-compatible bucket, with exactly one instance. It reaches the bucket with its own credentials and the app
through a target: `local` for a process on the same machine, or a target package such as
`@michaelthielemann/kestrel-target-cloudfoundry` for an app on a Cloud Foundry platform.

```
pnpm add -D @michaelthielemann/kestrel-ops @michaelthielemann/kestrel-target-cloudfoundry
```

Every environment is described in `kestrel.environments.json` in the project root: its target, the bucket and
the prefixes the app writes, the backup location and, for updates, an `update` block. The file holds no secret
values, only where they come from. The kestrel-ops README documents the file, each option of `status`, `backup`
and `restore`, and the questions they ask.

## Backups and restore

```
kestrel backup create --env prod             # database from the replica, originals, public output; verified
kestrel backup create --freeze --env prod    # the same with the app stopped for the copy
kestrel backup list --env prod
kestrel restore --backup <id> --env prod     # after a backup of the state it replaces
kestrel restore --to local ./copy --latest   # the newest replica generation into a local directory
```

A backup holds the database rebuilt from the replica, every original the media rows reference and the keys of
the delivery prefix; it is verified from what the backup location holds before the command ends. A restore
verifies the backup again, stops the app, shows what it would drop and bring back, promotes the backup's
database as a new replica generation, copies back changed originals, sets the delivery prefix to the backup's
and starts the app. Schedule `backup create --kind scheduled` and `backup prune` in the pipeline.

## Updating a deployed environment

An update moves an environment to a new release: other package versions, storage shapes, content migrations or
only new code. It runs in two places:

1. **On a workstation**, `kestrel update prepare --env prod` checks the environment without changing it, plans
   the update on a copy of the newest replica generation, rehearses the migrations and a start of the new
   release on that copy, and writes a receipt into the backup location.
2. **In the deploy job**, `node .kestrel-ops/run.mjs deploy --env prod` stages the release, stops the app, takes
   a verified cutover backup, migrates a copy of its database, promotes it, starts the new release and verifies
   it. A hard failure after the stop rolls back on its own.
3. **On a workstation**, `kestrel update accept --env prod` closes the run, or the next deploy accepts it.
   `kestrel update rollback --env prod` brings back the cutover state instead.

A deploy that changes package versions or finds a storage migration pending needs a receipt of this
environment with the same target versions and the same plan. An ordinary deploy, with neither, runs without a
receipt and still takes a verified cutover backup first; no migration starts without one.

### prepare

`update prepare [--full-media]` runs from the project, with the new release installed:

- **Preflight**, read only: one instance, no active deployment of the platform, a live replica, a writable
  backup location, the clock skew against the store.
- **Plan** on a copy of the newest replica generation: the storage migrations of the release's module packages
  that find their old form (detected and planned, nothing written), the content migrations the release brings
  that the copy's ledger does not hold, and the questions they ask. The plan hash covers the ids only, so an
  upload between prepare and deploy does not invalidate the receipt.
- **Rehearsal** on that copy: the migrations, a local start of the release and its checks, with the time each
  step took and the peak memory of the start. The originals the migrations touch and a sample are downloaded;
  `--full-media` downloads every original.
- **Receipt**: the version change and the plan hash, written once into the backup location. A receipt does not
  expire; a failed rehearsal check writes none and ends with exit 1.

### The deploy job

The build stage writes the bundle next to the build output; the deploy stage needs only Node, the platform's
command-line client and that directory:

```sh
# build stage, with the project's dependencies installed
pnpm exec kestrel update bundle

# deploy stage, from the build artifact
node .kestrel-ops/run.mjs deploy --env prod
node .kestrel-ops/run.mjs update status --env prod
```

`update bundle [--out <dir>]` writes `.kestrel-ops/` into the project (or `<dir>`): `run.mjs`, kestrel-ops and
the target package of every environment, the module packages of the release that export `./storage` with the
persistence and SVG sanitizer packages a migration needs, each with the packages it depends on, the
environments file and every target manifest it names at the same relative path, and `bundle.json` with the
versions of the release's kestrel packages, the lockfile hash and the facts the host project contributes, such
as its readiness path. `run.mjs` hands `deploy`, `verify` and `update <command>` to the update assistant and
every other command to `status`, `backup` and `restore`; `update.release.dir` is read relative to the directory
that holds `.kestrel-ops/`. Run one deploy job at a time per environment: the lock trace cannot exclude two runs
that start in the same moment.

### Deploy steps

| Step | App | What happens |
|---|---|---|
| `gate` | serving | Receipt, one instance, no active deployment, no other run of this environment in an open state. A verified run before it is accepted on the way. A refusal ends with exit 1 before anything changed. |
| `stage` | serving | The release is uploaded and staged while the app keeps running. A staging failure ends the run with exit 1; the app was never stopped. |
| `configuration` | serving | The app's configuration is recorded once: plain values verbatim, secret values only as salted fingerprints, the health check, memory, disk, start command and instance count. |
| `precopy` | serving | Originals and the delivery prefix are copied into the backup location, so only the difference is copied after the stop. |
| `stop` | **down** | After the `update-stop` answer. From here on the run is never cancelled, only resumed or aborted. |
| `seal` | down | Waits until the stopped replica's newest generation shows its seal, at most `update.sealTimeoutSeconds`; a runtime before 6 writes none. |
| `cutover-backup` | down | A verified backup of the stopped state, pinned for this run until `update cleanup`. |
| `migrate` | down | The migration of a copy of the cutover database, see below. |
| `promote`, `swap`, `start` | down | The migrated copy becomes the newest replica generation, the staged release becomes the app's code with its own configuration, and the app starts; one step with no question between them, so no old release starts on converted data. |
| `verify` | down until it passes | See below. |
| `retire` | serving | Only after `verify` passed: the replaced release's code is saved into the backup location when the platform hands it out, then every older release of the app is deleted, so neither the platform's own rollback nor an old pipeline run can start it on the converted data. |

### Verification

Verification has three outcomes. **Passed**: every hard check held; the run ends with exit 0. **Failed**: a hard
check failed, and the automatic rollback brings back the cutover state and verifies it; exit 3. **Unverifiable**:
the readiness check could not tell (403, 401, 404, a timeout or no connection); the run halts with exit 1,
leaves the new release running and names the next command.

The hard checks: an instance runs and the platform recorded no crash since the start; the readiness path
answers 200 (503, a body with `ready: false` or another 5xx answer fails); `applied.json` of the promoted
generation names it and the nonce of its `origin.json`; the release's own generation, sorting after the
promoted one, shows its first snapshot and its newest object advances within `update.syncWindowSeconds`; a key
of the delivery prefix newer than the start shows within `update.renderTimeoutSeconds` that rendering began.
Pages and media of the delivery prefix are checked as well, but only warn.

### Rollback

A rollback stops the app if it runs and waits for the seal, promotes the cutover backup's database again before
any old release can start, copies back originals whose key holds other bytes, sets the delivery prefix to the
backup's and lists it again until no key is newer than the start of the replacement, compares the derived
prefixes with the backup's listing, restores the recorded configuration verbatim without a question, makes the
previous release current again (uploading its saved code when it was deleted), starts it and verifies it. Without
a previous release or its saved code it ends with the app stopped on the cutover state.

`kestrel update rollback` before `accept` loses nothing and asks nothing more. After `accept` it shows what would
be lost since and needs the environment's name as the answer to `rollback-accepted`.

### Migrating the cutover copy

The `migrate` step works on a copy and records its own steps in the journal (phase `contentMigrations`):

- `copy` downloads the cutover backup's `db.sqlite` again, every time. A run killed in the middle of a migration
  that is not idempotent therefore starts again from the same state when it is resumed.
- `storage-migrations` runs the storage migrations of the release's module packages on the copy. A migration the
  plan does not name is refused. Blob writes reach the app's store only as server-side copies to keys that do not
  exist yet, or as new keys; a write over an existing key, a removal and a move are refused, so the keys the old
  release reads stay as they are. Stored SVGs are cleaned with the release's `kestrel-sanitize-svg`; a run that
  would keep them as downloads for want of it is refused with exit 2.
- `content-migrations` applies the pending content migrations by starting the release on this machine on the
  copy, through `update.localBoot`, and stopping it once it is ready. Nothing starts when nothing is pending; a
  pending migration without `update.localBoot` is a configuration error (exit 2). The local start gets an
  environment of exactly the host's `localBootEnv` and the `localBoot.env` values, never a variable of the
  deploy job's own environment, so it sees no credential of the tool. A start that applies a migration the plan
  does not name, or becomes ready without applying one it names, is refused.
- `migrate-check` refuses a storage migration still pending on the copy and a table a phase changed without
  converting anything, and records the tables that differ from the cutover copy: the content-migration ledger,
  the storage versions and the migrated collections.

```json
"update": {
  "release": { "dir": ".output" },
  "localBoot": {
    "command": ["node", "server/index.mjs"],
    "dir": ".",
    "env": { "DATABASE_FILE": "{database}", "BLOB_DIR": "{blobs}", "PORT": "{port}", "BUILD_ID": "{build}", "MIGRATIONS": "apply" },
    "readyPath": "/ready",
    "timeoutSeconds": 300
  }
}
```

`{database}` is the copy, `{blobs}` an empty local directory that stands in for the blob store, `{port}` a free
port on 127.0.0.1 and `{build}` a build identity of the local start's own. Pass `{build}` to the variable the
project reads its build id from, so the production start sees a new build and renders every output again. The
command runs in `dir`, relative to `update.release.dir`; `node` is the Node that runs the tool.

### Interrupted runs

The journal of a run lives in the backup location, one object per step, so any machine with access to it can
continue it. `kestrel update resume` checks the last finished step and continues after it: an unfinished
migration starts again from the cutover backup, a promotion whose generation is no longer the newest is refused,
after `promote` it swaps and starts, after `start` it verifies; an unfinished rollback runs again from its first
step, and a halted run is verified again. `kestrel update abort` ends an open run instead: before the promotion it
starts the previous release on the unchanged replica, after it it rolls back first.

`kestrel update status` reads the runs of the environment from the backup location: the newest deploy run, or
the one `--run` names, with its state, the hosts its processes ran on, the version change, the cutover backup,
the time of every step with the ones the app was down for, the total downtime and the command to run next, and
every other run in an open state. It takes no lock and writes nothing.

### Accept and cleanup

`kestrel update accept` closes a verified run; from then on a rollback discards what was written since. The
cutover backup stays pinned. `kestrel update cleanup [--dry-run]`, at least `update.cleanupAfterDays` (default 14)
after the accept, removes the originals under the media prefix that no row of the current replica references and
that the cutover backup holds, after the `cleanup-delete` answer, and releases the pin, so prune treats the
cutover backup like any other.

### Exit codes and questions

| Code | Meaning |
|---|---|
| 0 | Done; for `deploy` and `resume` with the new release verified. |
| 1 | A gate or check refused before production changed, verification could not tell and the run halted, a question had no answer, or a rollback could not finish. The output and `update status` name the state and the next command. |
| 2 | A usage or configuration error, such as a target that cannot run an update. |
| 3 | A hard failure after the stop, after which the automatic rollback brought back the cutover state and verified it. |

With `--json` every command prints one document with a `schema` field such as `kestrel-ops/update-deploy@1`,
holding `exitCode`, `state`, `message` and the run's report. The update questions are `update-stop` (before the
stop; `--yes` answers it), `rollback-accepted` (the environment's name, never answered by `--yes`) and
`cleanup-delete` (never answered by `--yes`); `--answers <file>` answers them in a pipeline.

The `update` block of an environment also sets the waits: `sealTimeoutSeconds` (60), `syncWindowSeconds` (120),
`renderTimeoutSeconds` (600) and `readyTimeoutSeconds` (300).
