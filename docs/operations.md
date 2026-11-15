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

## Permissions of the tool's credentials

The tool reaches the app's bucket with `storage.credentials`, and a backup location in a store of its own with
`backups.storage.credentials`. A deploy job runs `deploy` and, after a hard failure, its automatic rollback; per
prefix its credentials need:

| Prefix | List and read | Write | Delete |
|---|---|---|---|
| `app.replicaPrefix` | yes | a promotion writes `gen/<generation>/snapshot.db` and `origin.json` (deploy, rollback, restore); with a backup location in a store of its own, `status`, deploy, rollback and restore write short-lived clock probes under `.kestrel-clock/` and `probes/` | no; with a backup location in a store of its own, the clock probes under `.kestrel-clock/` and `probes/` (see below) |
| `app.mediaPrefix` | yes | storage migrations write new keys, also as server-side copies (deploy); changed originals are copied back (rollback, restore) | no; only `update cleanup` removes originals |
| `app.deliveryPrefix` | yes | the backup's keys are written back (rollback, restore) | yes: a rollback or restore removes the keys the backup does not hold |
| `app.derivedPrefixes` | yes | no | no |
| `backups.prefix` | yes | every command but `backup list` and `update status`; `status` writes only short-lived probes under `probes/` and `.kestrel-clock/` | yes: `backup prune` removes the backups that are due (`backups/<id>/`) and the objects no backup refers to (`objects/`), and on every run without `--dry-run`, before its `prune-delete` question and also when nothing is due, the entries under `recent/<day>/` older than a day; `update cleanup` and the `retire` step of a verified deploy remove the code saved for a closed run (`updates/<env>/runs/<run>/droplet-*`); a copy into `objects/` that failed is removed again; the clock and protection probes under `.kestrel-clock/` and `probes/` are deleted again |

The store's clock is measured with a probe object that is written, listed and deleted again, under
`.kestrel-clock/` on an S3-compatible store and `probes/` on any other. `update prepare` measures the clock of the
backup location's store once, always below the backup location and with `backups.storage.credentials` when the
backup location lies in a store of its own. `status` once, a deploy before its promotion, its swap and its start,
and a rollback and a restore before their promotion measure the clock of the app's store: below the backup location
when it shares the app's store, otherwise below `app.replicaPrefix` with `storage.credentials`. Credentials that
may not delete the probe still get the measurement: the command warns once and goes on, and the probe stays.
`backup prune` removes probes older than an hour from both places where its credentials may delete them; a probe
they may not list or delete there stays, and prune warns once and still removes the backups and objects that are
due, so only credentials with delete rights under `.kestrel-clock/` and `probes/` clear such probes. `status`
writes a probe into `probes/` to find out whether the app's credentials can delete in the backup location, and
deletes it with the tool's; when those may not delete it either, `status` reports all the same and warns once, as
for the clock probe.

## Updating a deployed environment

An update moves an environment to a new release: other package versions, storage shapes, content migrations or
only new code. It runs in two places:

1. **On a workstation**, `kestrel update prepare --env prod` checks the environment without changing it, plans
   the update on a copy of the newest replica generation, rehearses the migrations on that copy (pending content
   migrations through a local start of the new release), and writes a receipt into the backup location.
2. **In the deploy job**, `node .kestrel-ops/run.mjs deploy --env prod` stages the release, stops the app, takes
   a verified cutover backup, migrates a copy of its database, promotes it, starts the new release and verifies
   it. A hard failure after the stop rolls back on its own.
3. **On a workstation**, `kestrel update accept --env prod` closes the run, or the next deploy accepts it.
   `kestrel update rollback --env prod` brings back the cutover state instead.

A deploy that changes package versions or finds a storage migration pending needs a receipt of this
environment with the same target versions and the same plan. An ordinary deploy, with neither, runs without a
receipt and still takes a verified cutover backup first; no migration starts without one. The versions the app
runs are those the newest verified deploy of the environment put there; before the first one, those the target
reports, and when it reports none, `prepare` counts the update as a version change and the deploy takes them from
the receipt its gate matched. A target's report never counts when it read the packages installed in the project the
command runs from or inside a release directory of its own, since those are the new release's: the Cloud Foundry
target reads its `dir`, `.` by default, which during an update holds the new release. Point `dir` at an
installation of the running release, such as a checkout of the deployed state with its dependencies installed, to
have prepare record the running versions in the receipt.

### prepare

`update prepare [--full-media]` runs from the project, with the new release installed:

- **Preflight**: one instance, no active deployment of the platform, a target that can check the release's readiness
  (one that would count any running instance as ready, such as the Cloud Foundry target without `readyUrl`, is
  refused with exit 2), a release configuration the target can apply (for the Cloud Foundry target, a source in
  `vars` for every placeholder of the manifest, refused with exit 2 otherwise; the sources are not resolved, since
  they may exist only in the deploy job), the type of the health check (anything but an http check warns; its path
  is not compared with the readiness path), and the clock skew against the store, measured with a probe object
  written into the backup location and deleted again. The plan step then needs a complete newest replica generation;
  how recent it is, is not checked.
- **Plan** on a copy of the newest replica generation: the storage migrations of the release's module packages
  (those the project depends on, and those its direct dependencies bring along, such as the module packages of a
  preset package; their versions count as the release's) that find their old form (detected and planned, nothing
  written), the content migrations the release brings that the copy's ledger does not hold, and the questions they
  ask. The release's content migrations are the ids the host facts list in `contentMigrations`. The plan hash covers
  the ids only, so an upload between prepare and deploy does not invalidate the receipt. A release whose storage
  migrations would keep stored SVGs as downloads for want of `kestrel-sanitize-svg` is refused with exit 2 and gets
  no receipt; the gate of a deploy plans the same way and refuses it with exit 2 before the app stops.
- **Rehearsal** on that copy: the storage migrations, whose blob writes stay in memory and whose copies only
  point at the source, so no key of the app's store changes; the content migrations through a local start of the
  release when any are pending; an integrity check; and the referenced originals, every one of which must still
  be there after the migrations unless its row referenced no original already before. A sample of them is read
  back and compared with the checksum of its row; `--full-media` reads every one. The time each step took is
  recorded.
- **Receipt**: the version change and the plan hash, written once into the backup location. A receipt does not
  expire; a failed rehearsal check writes none and ends with exit 1.

### The deploy job

The build stage writes the bundle next to the build output; the deploy stage needs only Node, the platform's
command-line client and that directory:

```sh
# build stage, with the project's dependencies installed
pnpm exec kestrel update bundle

# deploy stage, from the build artifact
node .kestrel-ops/run.mjs deploy --env prod --answers deploy-answers.json
node .kestrel-ops/run.mjs update status --env prod
```

A deploy job has no terminal, so every question the deploy asks needs an answer from `--answers`; without one
the run stops at that question. `deploy-answers.json` answers the stop:

```json
{ "update-stop": "accept" }
```

The deploy from a release before 6 also needs `unsealed-stop`, since that release leaves no seal. When the
running versions name that release, or, with the running versions unknown, the stored data the pending storage
migrations convert was written by a release before 6, the deploy asks at once after the stop. Otherwise the
deploy waits the whole `update.sealTimeoutSeconds` for a seal first, and `update prepare` already warns that the
running runtime is unknown: pointing the target's `dir` at an installation of the running release and running
`update prepare` again names the running versions, and a lower `sealTimeoutSeconds` for that one deploy shortens
the wait. Give that one
deploy a file of its own and remove it once the deploy has run: a standing answer would also accept a later stop
of a 6.x release that went without its teardown, and its cutover backup would then lack the frames that stop did
not ship.

```json
{ "update-stop": "accept", "unsealed-stop": "accept" }
```

`--yes` answers `update-stop` as well, but never `unsealed-stop`.

`update bundle [--out <dir>]` writes `.kestrel-ops/` into the project (or `<dir>`): `run.mjs`, kestrel-ops and
the target package of every environment, the module packages of the release that export `./storage` with the
persistence and SVG sanitizer packages a migration needs, also when they come through a dependency of the
project such as a preset package that pnpm does not hoist, each with the packages it depends on, the
environments file and every target manifest it names at the same relative path, and `bundle.json` with the
versions of the release's kestrel packages, the lockfile hash and the facts the host project contributes, such
as its readiness path. `run.mjs` hands `deploy`, `verify` and `update <command>` to the update assistant and
every other command to `status`, `backup` and `restore`. `update.release.dir` is read relative to the project the
bundle was written from, which the bundle finds at the same place relative to `.kestrel-ops/` as when it was
written: with the default output the directory that holds `.kestrel-ops/`; with `--out <dir>` the artifact keeps
the project's layout around `<dir>`. Run one deploy job at a time per environment: the lock trace cannot exclude
two runs that start in the same moment.

### Deploy steps

| Step | App | What happens |
|---|---|---|
| `gate` | serving | A target that can check readiness, a release configuration the target can apply with every source resolved, and `update.localBoot` when content migrations are pending (exit 2 otherwise), receipt, one instance, no active deployment, no earlier deploy run of this environment in an open state, also behind later runs the gate refused, and none whose older releases are not retired yet; the refusal names the command that finishes that run. The newest earlier run that got past its gate is accepted on the way when it is verified. A refusal ends with exit 1 before anything changed. |
| `stage` | serving | The release is uploaded and staged while the app keeps running. A staging failure ends the run with exit 1; the app was never stopped. |
| `configuration` | serving | The app's configuration is recorded once: plain values verbatim, secret values only as salted fingerprints (also a plain value that contains one of the tool's own credentials of 16 or more characters, or a shorter one as a token of its own, neither preceded nor followed by a letter, a digit, `_`, `-`, `.` or `/`, as in `minio:minioadmin`, `Bearer <key>`, `--password <key>` or a JSON string, or as the user or password of a URL; a plain value of which a shorter credential is only part of a name, a host or a path, such as `kestrel-media` or `https://kestrel.example.net` for the access key `kestrel`, is recorded verbatim, so a rollback restores it), the health check, memory, disk, start command and instance count. |
| `precopy` | serving | Originals and the delivery prefix are copied into the backup location, so only the difference is copied after the stop. |
| `stop` | **down** | After the `update-stop` answer. From here on the run is never cancelled, only resumed or aborted. When the stop itself fails after it stopped the app, the app is started again; if that fails too, the run stays open with exit 1 and `update abort` starts the previous release. A hard failure before the cutover backup is written makes the previous release current again and starts it on the unchanged replica; exit 3. A signal (SIGINT, SIGTERM) after the stop ends the process with exit 1 and a message that says what state the app is in and which command continues or ends the run; never start the app by hand while the run is open. |
| `seal` | down | Waits until the stopped replica's newest generation shows its seal, at most `update.sealTimeoutSeconds`; a runtime before 6 writes none, which needs the `unsealed-stop` answer. When the running versions name such a runtime, or, when they are unknown, the stored data the pending storage migrations convert was written by a release before 6, nothing is awaited, the stop reads `unsupported` and the question follows at once; otherwise the whole timeout is awaited. That release is told by the module's storage version row, which every 6.x release writes at its start: data with a row comes from the row's major on, data without one from the oldest version the release converts (`convertsFrom`); either way it predates the oldest pending migration's `introducedIn`, since a release that runs keeps no data in a form its own migrations convert. A row of 6.x, or a range that reaches into 6.x, keeps the wait. Without the answer the previous release starts again; exit 3. |
| `cutover-backup` | down | A verified backup of the stopped state. Its manifest records the running versions; when they are unknown, the major of the release that wrote the stored data the pending storage migrations convert, as the `seal` step tells it, so `backup prune` keeps the newest backup of that major; when the data may come from more than one major, it records neither and warns. A deploy that changes the major of Kestrel, runs on unknown versions or has a storage migration pending pins it for this run until `update cleanup`; otherwise the retention of `cutover` backups keeps it. |
| `migrate` | down | The migration of a copy of the cutover database, see below. |
| `promote`, `swap`, `start` | down | The migrated copy becomes the newest replica generation, the staged release becomes the app's code with its own configuration, and the app starts; one step with no question between them, so no old release starts on converted data. |
| `verify` | serving once the start became ready | See below. The downtime ends with a start that became ready, or with a verification that passed after a start that was not ready yet. |
| `retire` | serving | Only after `verify` passed: the replaced release's code is saved into the backup location when the platform hands it out, then every older release of the app is deleted, so neither the platform's own rollback nor an old pipeline run can start it on the converted data. When the platform hands out no code or saving it fails, that release is deleted all the same and a warning says that a later `update rollback` brings back the cutover state with the app stopped; a release another open deploy run needs stays. When deleting fails or is interrupted, the run stays verified but ends with exit 1, because the older releases can still be started; `update status` names `update resume`, and `update resume` or `update accept` retire them again. |

### Verification

Verification has three outcomes. **Passed**: every hard check held; the run ends with exit 0. **Failed**: a hard
check failed, and the automatic rollback brings back the cutover state and verifies it; exit 3, or exit 1 when it
had no previous release to start and the app stays stopped. **Unverifiable**:
the readiness check could not tell (403, 401, 404, a timeout or no connection), or a check could not read the
store or the platform; the run halts with exit 1, leaves the new release running, rolls nothing back and names
the next command.

The hard checks: an instance runs and the platform recorded no crash since the start, both read once more after
every wait below ended, so a crash while verification waits fails it; the readiness path
answers 200 (503, a body with `ready: false` or another 5xx answer fails); within `update.syncWindowSeconds`
`applied.json` of the promoted generation names it and the nonce of its `origin.json` (the release writes it at its
first sync after the start, so the window has to cover the interval at which the project runs `replication.sync`);
the release's own generation, sorting after the promoted one, shows its first snapshot, and within
`update.syncWindowSeconds` a WAL segment of that generation or a later snapshot shows that its sync advances
(`origin.json`, `applied.json` and `sealed.json` do not count; a release on which nothing is written writes a
segment without frames at its first sync after that snapshot, so the window has to cover two sync intervals); a
key of the delivery prefix newer than the start shows within `update.renderTimeoutSeconds` that rendering began.
A delivery prefix without any key only warns. No page or medium is fetched over the network.

### Rollback

A rollback stops the app if it runs and waits for the seal, promotes the cutover backup's database again before
any old release can start, copies back originals whose key holds other bytes, sets the delivery prefix to the
backup's and lists it again until no key is newer than the start of the replacement, compares the derived
prefixes with the backup's listing, restores the recorded configuration verbatim without a question (a fingerprinted
value stays as it is and is reported when it changed), makes the
previous release current again (uploading its saved code when it was deleted), starts it and verifies it. Without
a previous release or its saved code it ends with the app stopped on the cutover state. The derived keys it finds
added, changed or missing against the backup's listing are printed as a warning and kept in the run's report;
the release renders them again. Once the previous release runs verified, the run's pin on the cutover backup is
released.

The seal a rollback waits for is that of the release it stops: the run's target versions once the new release was
started, otherwise the versions the run moved from. The target's report counts only when the run knows neither, and
an unknown runtime is awaited for the whole `update.sealTimeoutSeconds`; so a 6.x release is awaited for its seal
even while the target still reports an older installation, and a release before 6 is not awaited.

The automatic rollback uses the cutover backup and the promotion the deploy knows, also when the journal's
listing does not show them yet. A rollback of a run without a cutover backup starts the previous release on the
unchanged replica; it refuses while the app's code is the staged release or while the newest generation was
placed by an update and no release acknowledged it, and `update resume` rolls back once the journal lists the
cutover backup.

The verification after a rollback proves within `update.syncWindowSeconds` that the started release restored the
promoted cutover state: either its `applied.json` names the generation and its nonce, or the first snapshot it wrote
after that generation holds the marker row the rollback put into the promoted database. Both appear at the first
sync of the release. Releases before 6 write no `applied.json`, so the
marker row proves it for them; it stays in the table `kestrel_ops_provenance`, one row per rollback.

`kestrel update rollback` of a run whose new release started stops the app first and waits for the seal, so nothing
is written between the report and the stop. It then compares the stopped state with the promoted generation, after
`accept` with the cutover backup. When the new release wrote more than login sessions, or after `accept` always, it
shows what would be lost and needs the environment's name as the answer to `rollback-accepted`; without it the app
is started again and the run stays as it was. Every such rollback takes a verified `pre-restore` backup of the
stopped app before it changes the store; once the command ended, its retention keeps it like any other
`pre-restore` backup. `kestrel update abort` of a run whose new release started goes through the same steps. A
halted run whose verification fails again, and a deploy that `update resume` continues after a start an earlier
process began whose verification or start then fails, is rolled back automatically only when its release wrote
nothing since its start, after the stop and a `pre-restore` backup; otherwise it stays halted with exit 1 and
`update status` names `update rollback`. When that stop or backup fails, the app is started again and `update
resume` rolls back the way a run whose failed verification is recorded does: the stop, the `rollback-accepted`
question when the release wrote, and a `pre-restore` backup.

### Migrating the cutover copy

The `migrate` step works on a copy and records its own steps in the journal (phase `contentMigrations`):

- `copy` downloads the cutover backup's `db.sqlite` again, every time. A run killed in the middle of a migration
  that is not idempotent therefore starts again from the same state when it is resumed.
- `storage-migrations` runs the storage migrations of the release's module packages on the copy. A migration the
  plan does not name is refused. Blob writes reach the app's store only as server-side copies to keys that do not
  exist yet, or as new keys; a write over an existing key, a removal and a move are refused, so the keys the old
  release reads stay as they are. Stored SVGs are cleaned with the release's `kestrel-sanitize-svg`; without it
  prepare and the gate have refused the release already.
- `content-migrations` applies the pending content migrations by starting the release on this machine on the
  copy, through `update.localBoot`, and stopping it once it is ready. Nothing starts when nothing is pending; a
  pending migration without `update.localBoot` fails the rehearsal of prepare (exit 1, no receipt), and the gate of
  a deploy refuses it with exit 2 before the app stops. The local start gets an
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
continue it. `kestrel update resume` refuses with exit 2 to continue a deploy from a process that has another
release than the run: other versions of the kestrel packages, or other content migrations in the host facts
(`kestrel update` passes the host plugin's facts to `prepare`, `deploy`, `verify` and `resume`, `run.mjs` those of
the bundle; `accept`, `rollback`, `abort` and `cleanup` load no host plugin). It then checks the last finished step
and continues after it: a plan of the cutover database that differs from the receipt or from the plan the gate
recorded is refused, an unfinished cutover backup is taken again and the unfinished one loses its update pin, so
prune removes it, an unfinished migration starts again from the cutover backup, a promotion whose generation is no
longer the newest is refused, after `promote` it swaps and starts, after `start` it verifies; an unfinished
rollback runs again from its first step, a run whose failed verification is recorded but whose rollback did not
begin, and a deploy whose step after the stop failed before its automatic rollback began, go through the same stop,
question and `pre-restore` backup as `update rollback` and are rolled back, a halted run is verified again, and a
verified run whose retire did not finish retires the older releases. A run that has not finished its stop is not
resumed; `update abort` ends it. `kestrel update abort` ends an open run: before the promotion it starts the
previous release on the unchanged replica and releases the pin on the cutover backup, after it it rolls back first.

A run whose `swap` is still ahead checks the configuration it would apply with every source of the release
configuration resolved, so it continues only where those sources resolve, in the deploy job's environment or with
its bundle there; elsewhere `update resume` refuses with exit 2 and the app stays stopped.

A process that was killed leaves its lock behind. The command that continues its run therefore needs
`--break-lock` and the answer `"break-lock": "accept"`, given only once that process no longer runs:

```sh
kestrel update resume --env prod --run <id> --break-lock --answers break-lock.json
```

`kestrel update status` reads the runs of the environment from the backup location: the newest deploy run that
changed something, or the one `--run` names (a newer deploy the gate refused is named beside it), with its state,
the hosts its processes ran on, the version change, the cutover backup, the time of every step with the ones the
app was down for, the total downtime (until a start that became ready, a verification that passed or a verified
rollback), the derived keys of a rollback, the command to run next, and every other run in an open state. It takes
no lock and writes nothing.

### Accept and cleanup

`kestrel update accept` closes a verified run; from then on a rollback discards what was written since. A pinned
cutover backup stays pinned. `kestrel update cleanup [--dry-run]`, at least `update.cleanupAfterDays` (default 14)
after the accept, removes the originals under the media prefix that no row of the current replica references and
that the cutover backup holds, after the `cleanup-delete` answer, releases the pin, so prune treats the cutover
backup like any other, and deletes the replaced release's code the run saved. A later deploy that passes
verification deletes the saved code of every earlier deploy run that is no longer open and holds no pin on its
cutover backup as well, so the code of the release before a major change stays until that run's cleanup. A deploy
that accepts such a run on the way names its `update cleanup --run <id>`, and so does `update cleanup` when it
refuses a later run that is not accepted.

`kestrel update rollback` of a run that a later verified deploy superseded rolls back only while the run holds the
pin on its cutover backup, the way back across a major change, and never while a later deploy is open. The later
runs then read `rolled-back`, and what they wrote is part of the loss the rollback reports. When the app stays
stopped because no previous release was left to start, the output of the command and `update status` name a deploy
of that release with the bundle of its own build when it brings kestrel-ops (the bundle in the workspace of the
failed deploy job is the new release's and would deploy it again), and otherwise a deploy the way it was deployed
before the update.

### Exit codes and questions

| Code | Meaning |
|---|---|
| 0 | Done; for `deploy` and `resume` with the new release verified. |
| 1 | A gate or check refused before production changed, verification could not tell and the run halted, a question had no answer, a rollback could not finish, or a rollback brought back the cutover state with no previous release left to start, so the app stays stopped and `update status` names a deploy of the previous release. The output and `update status` name the state and the next command. |
| 2 | A usage or configuration error, such as a target that cannot run an update. |
| 3 | A hard failure after the stop, after which the automatic rollback brought back the cutover state and verified it. |

With `--json` every command prints one document with a `schema` field such as `kestrel-ops/update-deploy@1`,
holding `exitCode`, `state`, `message` and the run's report. That document and every document the tool stores
(journal, manifests, receipts, the recorded configuration) hold no credential's value, except where a credential
shorter than 16 characters is only part of a name, a host or a path in a plain value of the recorded configuration,
which is kept verbatim (the `configuration` step says which values are fingerprinted). Their schema, keys, names
and every other field stay as they are; only the free-text fields `message`, `error`, `failure`, `detail` and
`problems` are masked. In a message and in a line for the terminal, the text the tool writes itself (command
names, flags, environment names, run, backup and droplet ids, step names and states) stays as written, also when a
credential equals one of its words: with the access key `update` and the environment `prod`, a verified deploy
still reads `verified; accept it with update accept --env prod, …` and `update status` still ends with
`next: kestrel update accept --env prod --run …`. A credential is masked wherever it occurs in text that comes
from elsewhere: an error of the store, an answer of the platform, the output of a command. A credential of 16
characters or more is masked everywhere. A pipeline takes the next command from `run.next` of
`update status --json`, which is never masked. The update questions are `update-stop` (before the
stop; `--yes` answers it), `unsealed-stop` (after the stop of a release that leaves no seal, such as one before 6;
never answered by `--yes`; without an answer the previous release starts again and the deploy ends with exit 3),
`break-lock` (with `--break-lock`; never answered by `--yes`), `rollback-accepted` (the environment's name, never
answered by `--yes`) and `cleanup-delete` (never answered by `--yes`); `--answers <file>` answers them in a
pipeline.

The `update` block of an environment also sets the waits: `sealTimeoutSeconds` (60), `syncWindowSeconds` (120),
`renderTimeoutSeconds` (600) and `readyTimeoutSeconds` (300).
