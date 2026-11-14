# Upgrading: 5.x -> 6.0.0

`kestrel upgrade` finds the 6.0.0 breaks a 5.8 project meets, previews a fix for the ones it can
edit mechanically, asks about the ones only a person can decide, reads a database copy for the
checks only stored data can answer, and converts the stored media of a copy to the 6.0.0 storage
shape. It never installs, commits, pushes or reaches the network on its own. The command belongs to `@michaelthielemann/kestrel-cli`; the engine behind it is the library
`@michaelthielemann/kestrel-upgrade`.

A 5.8 project does not have the 6.0 CLI yet, so the first runs fetch it without installing it. Use
`npx -y @michaelthielemann/kestrel-cli@6 …` or `pnpm dlx @michaelthielemann/kestrel-cli@6 …`; both
run the package's `kestrel-cli` binary, never the project's own 5.x `kestrel`, which would start the
server instead. Once `fix --write` has added `@michaelthielemann/kestrel-cli` and the install is
done, `kestrel upgrade …` runs the local copy.

## 1. See what breaks

With the 5.x packages still installed:

```
npx -y @michaelthielemann/kestrel-cli@6 upgrade check
```

(`pnpm dlx @michaelthielemann/kestrel-cli@6 upgrade check` is the same.)

At this point the tool sees the **source tier** only — it reads `kestrel.config.ts`, every pipeline
file, every local module file and `package.json` as text, without importing the 6.0 packages.
Every finding the tool did not name explicitly but the checker underneath still catches shows up as
`boot/<code>`, so a break nobody wrote a rule for is still listed.

## 2. Bump and install

```
npx -y @michaelthielemann/kestrel-cli@6 upgrade fix --write
pnpm install
```

`fix --write` bumps every `@michaelthielemann/kestrel*` range to `^6.0.0` and adds
`@michaelthielemann/kestrel-cli` (see [`deps/kestrel-range`](#deps-kestrel-range)); it rewrites
scripts that call the removed `kestrel-openapi` and `kestrel-upgrade` binaries
([`scripts/kestrel-binaries`](#scripts-kestrel-binaries)). It also raises the project's own `zod` to
`^4.6.6` ([`deps/zod-range`](#deps-zod-range)), because kestrel 6.0.0 reads module config schemas
built with zod 4, and rewrites three zod 3 forms in the project's own schemas: `z.record` with only
a value schema ([`zod/record-key`](#zod-record-key)), an object default that relies on being
parsed ([`zod/object-default`](#zod-object-default)) and a `.describe()` that an object method such
as `.strict()`, or `.or()`, follows ([`zod/describe-order`](#zod-describe-order)). [zod 4 schemas](#zod-4-schemas)
lists what else to check by hand.

`fix` without `--write` only previews: it shows a unified diff of every file it would change and
never touches the project. `--write` on a terminal shows the same diff per file and asks `y` (write
it), `n` (skip it) or `d` (show the diff again); without a terminal it needs `--yes` or is refused
(exit 2) rather than write silently. It refuses a file with uncommitted changes unless
`--allow-dirty` is also given, so `git diff` shows exactly the tool's edits and `git checkout`
reverts them. When an applied edit brings up a new finding (a question that only makes sense once the
first edit is in, say), `--write` checks again and applies it in the same run, for at most five passes;
a finding already handled in an earlier pass is not applied again, and an answer given in one pass
holds for the later ones. With `--json`, `--write` prints the report of every pass on stdout,
including a finding that only the last pass's edits brought up. The tool never runs `pnpm install`
itself.

## 3. Full check

After installing the 6.0.0 packages, running `check` again also loads the config, every module and
every pipeline, and boots the instance in a scratch copy of the project — never the project itself
— to run the same checks `boot()` runs. A module the tool does not know is safe to run `setup()`
against (anything beyond kestrel's own storage modules) does not run unless named with
`--run-setup <use>`; its pipelines are then reported as not checked instead of run against a real
config.

The scratch copy holds the files git tracks or would add (untracked files that are not ignored).
Outside a git repository it holds every file except `.env` files, database files, files over 10 MB,
and anything under a hidden directory (a name starting with `.`), `node_modules` or `dist`. Either
way, the project's own `node_modules` is linked into it, not copied.

## 4. Answering questions

A finding whose fix needs a person's decision carries a question. `fix` on a terminal asks each one
in turn, with its default shown; pressing enter takes the default. Without a terminal it never
prompts: pass `--answers <file>` (a JSON object of `{ "<question id>": "<answer>" }`) to supply
them, or `--yes` to take every default — a question with no safe default (whether an output
property is always present, for one) stays open under `--yes` either way. `--answers` giving a
closed-choice question (`yes`/`no`, say) a value outside its choices is refused (exit 2), naming the
id and the offending value. An id no pass of this run asked is not refused: it is ignored with a
warning on stderr when it belongs to no built-in rule's question family (a plugin's question a later
run asks, or a typo), and only noted when it does (an earlier run's answer that run's own edit has
since resolved, say), so one answers file kept across several runs keeps working.
`--save-answers <file>` writes down what was answered interactively, to replay with `--answers` next
time.

`fix`'s preview always shows the boot result the edited project would have: how many errors remain,
how many still need an answer, how many stay manual.

## 5. Switching event delivery to the queue

A project on `events-direct` is offered the switch to `events-queue`, never forced. `check` reports
`offer/event-queue`: which conditions block it (no event trigger to move, no durable
`persistence@1`, a serverless marker suggesting no long-lived worker, an open `steps/closed-event-input`
or `modules/emits` finding, or the switched config itself failing to boot on a sandboxed preview), or
that it can switch. `fix` then asks `switch-to-queue` (default
**no**), explaining that uploads and similar requests answer at once while other subscribers move to
the worker with retry, a failing subscriber no longer fails the request that emitted the event, and
an event may now reach a pipeline more than once. A "yes" asks `idempotent:<pipeline>` for every
consumer event pipeline — any "no" withdraws the switch — then `relay-pipelines` (default: the
pipelines with a `delivery.publish`/`delivery.unpublish` step), which becomes `relayPipelines` on
`events-queue`. The codemod swaps the module-list entry, updates `package.json`, and inserts
`events.relay` after the last `events.emit` of the moved event, in whichever pipeline emits it.

## 6. Data

```
kestrel upgrade data --db <a copy of the database> --root <project>
```

The tool copies the given file (and any `-wal`/`-shm` siblings) into its own temp directory and
never opens the path it was given again. It verifies the copy with `PRAGMA quick_check` before
reading anything else — the only SQL it issues itself; a copy that fails this, or does not open, is
refused (exit 2) rather than read, since a plain file copy of a live database can be torn. It then
reads the verified copy through the project's own installed `persistence-sqlite`, so the collection
layout stays that module's knowledge, and reports stored `events_queue` rows not yet fanned out to a
pipeline or a dead-letter row with no pipeline assigned, and translations published without a slug of
their own ([`data/translation-slug`](#data-translation-slug)). Take a consistent snapshot close to
cutover (a replication snapshot, or `sqlite3 <db> ".backup <copy>"`).

The `data` command also runs the detection step of the storage migrations that `media-default`
and `images-default` export under `./storage`, as the project has them installed, and reports data
in the 5.x shape as [`data/media-layout`](#data-media-layout). [Converting the stored
media](#7-converting-the-stored-media) runs those migrations.

`delivery-static` deletes files in the blob store once after the upgrade, in a `delivery.resumeStale`
run of the recovery cron and without a command of its own: see
[delivery-orphan-removal](#delivery-orphan-removal). That removal and the restore
detection wait for `delivery.checkBuild`, which no trigger runs at boot: the host runs its pipeline once
after `start()` (see [delivery-restore-check](#delivery-restore-check)). With `replication-sqlite` or
`backup-blobstore` backing up the database, wire their `checkRestored` step directly before
`delivery.checkBuild`, so that a restored database is rendered again and never runs that removal.

## 7. Converting the stored media

6.0.0 stores an original under `<prefix><id>/<name>`, where 5.x stored it under
`<prefix><folder>/<filename>`, and gives every variant row a `slot`. `media-default` and
`images-default` refuse to start on 5.x data and name the storage migration that converts it
(`storageMigrations: "check"`, the default). The media conversion copies blobs, so it never runs at
start-up. Run it once, offline, on a copy of the data:

```
kestrel upgrade migrate --db <copy of the database> --blobs-dir <copy of the blob store> --root <project>
```

1. Stop the 5.8 instance, so that the database and the blob store no longer change.
2. Copy both: the database (`sqlite3 <db> ".backup <copy>"`, or the file of the stopped instance
   together with its `-wal` and `-shm` files, which hold the last writes until SQLite folds them
   into the file; after a crash or a killed process, take the `.backup`) and the root of the
   filesystem blob store with everything below it. Keep the originals as they are; they are the backup that 5.8 starts on again if the update is abandoned.
3. With the 6.0.0 packages installed, run `migrate --plan` on the copy to see what it would
   convert, then `migrate` without `--plan` to convert it. When the plan names items whose original
   is missing, decide for them with `--answers` (see below). Each 5.x SVG is cleaned with the
   project's `sanitize.svg` and stays an image; one that cannot be cleaned is named and served as a
   download from then on (see [SVG files](#svg-files)).
4. Run `kestrel upgrade data --db <copy> --root <project>`; `data/media-layout` no longer appears.
5. Start 6.0.0 on the converted copy. Run `media.syncPublic` and `images.syncPublic` (with
   `publicCopy`) and publish the site again, so that the public copies and the exported pages use
   the new keys.

`migrate` works in place on the files it is given. It runs the storage migrations of every module
whose collections the database holds, taken from the `./storage` export of the module package the
project has installed (found from the project or from one of its direct dependencies), through the
project's own `persistence-sqlite` and `blobstore-filesystem`, in order: `media-default:id-key-layout`,
then `images-default:variant-slots`. The media prefix comes from `media-default`'s entry in
`kestrel.config.ts`. When that file does not load by itself (it reads environment variables that
are not set, or an import only a host package resolves), the module configs come through the
project's host plugin; when that does not load them either, `migrate` stops with exit code `2`,
naming the error, before it converts anything. Without a `kestrel.config.ts` and without a host
plugin the prefix is `media/`, and a store that holds a 5.x SVG stops the run (see [SVG files](#svg-files)). The report names the prefix and where it came from. Each original is copied to its new key, checked against the item's size and sha256 (a
difference is reported, and the item records those of the copy), and only then is the item
switched to it. The duplicate variant rows of a slot are reduced to the newest finished one. Each
module then gets a storage version row, which the start-up check of 6.0.0 reads.

- `--plan` detects and counts without converting a row or writing a blob. To read the data it adds
  the 6.0.0 columns to the copy, which a 5.8 instance would not mind.
- `--answers <file>` answers the questions of a migration, for example
  `{ "media-default:id-key-layout:missing-original": "trash" }` to move an item whose original is
  missing to the trash, or `"keep"` to switch it to its new key anyway.
- An item whose original is not under `--blobs-dir` stops the run before it converts anything,
  with exit code `2`, the number of such items and a few of them, unless `--answers` answers
  `media-default:id-key-layout:missing-original`. When none of the originals is there and
  `--blobs-dir` holds no blob under the media key prefix, it most likely names another directory
  than the copy of the blob store's root, such as a directory one level too deep; the run then stops
  with exit code `2` whatever the answers say, and names what `--blobs-dir` holds. `--plan` reports
  the same as a note. An item switched
  with `keep` is not looked at again by a later run: when its original turns up after all, copy it
  to the item's new key (`media.reconcile` lists that key under `rowsWithoutBlob`).
- `--originals-gone` is for a blob store whose originals are all lost: it confirms that
  `--blobs-dir` is the root of the copy although none of the originals is under it. Together with an
  answer to `media-default:id-key-layout:missing-original`, the run then applies that answer to every
  item and says so in a note. Check the entries the refusal names first: the root holds the other
  prefixes of the store, such as the variants of `images-default` or the delivery prefix, while a
  directory a level too deep holds the folders and files of the media themselves.
- `--media-prefix <prefix>` names the media key prefix (`media-default`'s `prefix`, such as
  `media/`) in place of the one of the config, also when the config does not load. Without the
  config, `migrate` cannot see the project's `sanitize.svg`, so a store that holds a 5.x SVG still
  stops the run with exit code `2` before anything is converted (see [SVG files](#svg-files)).
- `--json` prints the report (`schema: 1`, one entry per module with its migrations, what they found
  and what they did).
- Exit codes: `0` every module is in the 6.0.0 shape, `1` a migration is still pending (always
  after `--plan` on 5.x data) or the stored data is older or newer than 6.0.0 reads, `2` the run
  could not start, an original is missing without an answer, no original is under `--blobs-dir` at
  all and `--originals-gone` is not given, or a migration failed.
- A database that does not pass `PRAGMA quick_check` stops the run with exit code `2` before
  anything is converted; take a consistent copy. A database SQLite cannot open at all, because its
  directory has no free space or no write access for the `-wal` and `-shm` files, is reported as
  such: make room or grant write access next to it, and keep the copy.

A second run finds nothing to do and changes nothing. A run that stops part-way, through an error
or a killed process, leaves the copy in a state the next run continues from; nothing of what it
already did is undone, and the result is the same as that of an uninterrupted run. The command
neither takes nor honours the instance lock (see [`runtime/single-process`](#runtime-single-process)):
a `<file>.instance` that the stopped instance left next to the copy does not stop it, and it says
so. Make sure no process uses the copy while it runs.

### SVG files

6.0.0 serves an SVG as `image/svg+xml` only when its bytes passed `sanitize.svg`, and a 5.x release
kept no record of that. `migrate` therefore runs each 5.x SVG through the `sanitize.svg` step of the
project, the same step and module config a new upload goes through, set up offline from the module
entry in `kestrel.config.ts` (or the host plugin) that registers it. The cleaned file becomes
`<id>/<stem>.svg`, typed `image/svg+xml` and marked as sanitised like an upload; the item keeps its
id, so every page, setting and document that uses it still does, its size and sha256 are those of
the cleaned file, and its `updatedAt` is the time of the run, so `media.export:<dir>` writes the
cleaned file over a 5.x export of it. The 5.x original stays under its old key. `migrate --plan` and
the report count these items as `svgSanitized`, and a note names the module entry whose step cleaned
them. Publish the site again after the update (step 5), so that the public copies and the exported
pages use the new names.

An SVG that cannot be cleaned becomes `<id>/<stem>-svg.bin`, and 6.0.0 serves it, and writes its
public copy, as `application/octet-stream`: its URL answers `200`, but an `<img>` or a CSS background
no longer shows it. That happens when `sanitize.svg` refuses the file (markup without an `<svg>` root,
a file above its `maxBytes`), when the cleaned file's root element is not in the SVG namespace (an
SVG that declares the namespace through an entity of its DOCTYPE, which the cleaning removes, as
some older drawing programs export it), when its original is missing, and for every 5.x SVG when no
module of the project registers `sanitize.svg`, which the report says in a note. An SVG whose
original is missing stays an image only when an earlier, interrupted run already wrote its cleaned
copy: the one `.svg` file in the item's `<id>/` folder that no other item uses as its key and that
`sanitize.svg` leaves unchanged.

- `migrate --plan` names each such item with the reason, such as "is an SVG that sanitize.svg
  refuses (invalid svg: …)", and counts them as `svgDemoted`; check that list before the update.
- To show one as an image again, upload the file again through a pipeline that runs `sanitize.svg`
  before `media.upload`. The upload is a new item with a new id, because the converted item keeps its
  `.bin` name; point every page, setting and document that uses the old item at the new one and
  publish them again, then delete the old item.
- When the module that registers `sanitize.svg` cannot be set up on its own, without the contracts of
  other modules, its config does not parse, or start-up refuses its config schema (a 5.x
  `sanitize-svg` next to 6.0.0 media packages), `migrate` stops with exit code `2` before it converts
  anything.
- When the config does not load, or a module entry does not load and no other one registers
  `sanitize.svg`, `migrate` does not know whether the project would clean its SVGs. If the store
  holds a 5.x SVG, it stops with exit code `2` before it converts anything, and `migrate --plan` says
  so in a note; make every module entry load and run it again. The same holds when `--root` has no
  `kestrel.config.ts` and no host plugin loads the project, such as the root of a workspace whose
  project lives in a subdirectory: name the directory that holds `kestrel.config.ts` with `--root`. An entry without `config` is set up with `{}` and the defaults, as at start-up.
- Only a module whose name starts with `sanitize/` and whose `describe()` lists an `svg` step is set
  up. Another `sanitize/*` module, such as one with only an `html` step, is neither parsed nor set up.
  A `sanitize/*` module whose `describe()` cannot be read without its instance is set up to find
  out; when that fails, it counts as an entry that does not load.

### Leftovers

The conversion leaves these in place on purpose:

- The 5.x originals under `<prefix><folder>/<filename>`. Their keys are recorded in
  `media_legacy_keys`; `media.reconcile` lists them as `legacyKeys`, apart from `blobsWithoutRow`,
  and `media.reconcileDelete` never deletes them. They keep the backup taken before the conversion
  complete until the update is accepted.
- An item whose original was missing keeps its row (or moves to the trash, see `--answers`);
  `media.reconcile` lists its new key under `rowsWithoutBlob`. Its variants still serve.
- Some of the 5.x static export copies under the delivery prefix (`site/media/<folder>/<filename>`
  and `….<size>.<ext>`). `media.syncPublic` removes those exactly one folder deep, because they sit
  where its own copies `<id>/<name>` go; a copy directly under the media path or in a deeper folder
  stays. [`data/site-media-leftovers`](#data-site-media-leftovers) names the entries of that
  directory that are not an `<id>/` directory of a stored item; delete those by hand once every page
  that might link them is published again, and keep the `<id>/` directories.

### Not included

- Converting media in an S3 bucket. `migrate` reads and writes a filesystem blob tree only; for a
  bucket, `kestrel update` runs the same migrations with server-side copies.
- Deleting the 5.x originals and their `media_legacy_keys` rows. That is a separate cleanup after the
  update has been accepted.
- Any change to the 5.8 data: the copy is converted, the original stays a 5.8 backup.

## 8. Known devices at sign-in

Nothing changes until a project opts in. A `username` bucket in front of the login blocks the account
for everyone once its budget is used up, whoever sent the attempts. To keep the owner's own devices out
of that block, add `knownDevices` to the bucket, `deviceCookies` with a `secretKey` of 32 bytes to the
`ratelimit-memory` config, and `ratelimit.rememberDevice:<bucket>` after the login steps, including
`mfa.check`; the module's README shows the whole pipeline. A custom HTTP transport that writes
`HttpResponse` itself must also send `cookies`, one `set-cookie` header each, or the device cookie never
reaches the browser. Devices get their cookie at their next successful sign-in.

## Cutover

Switching an already-running project's event delivery to `events-queue`, or draining it before a
later switch back, moves stored events through the queue rather than losing them. The order is:
stop writes, drain, stop the 5.8 process, deploy 6.0.

1. Take a consistent snapshot of the database close to the moment of cutover (a replication
   snapshot, or `sqlite3 <db> ".backup <copy>"` while the process keeps running).
2. Run `kestrel upgrade data --db <copy> --root <project>` against it. `data/queue-unfanned` names
   every event name with rows not yet delivered to any pipeline; `data/queue-dead-unassigned` names
   dead-letter rows with no pipeline assigned yet. Neither blocks a deploy — they describe what the
   first tick after boot will do. Both count only rows with no pipeline assigned yet, so they stop
   being useful once a row has been fanned out at least once; they are a pre-deploy heads-up, not
   the drain condition below.
3. Deploy. On `events-queue`'s first scheduled tick, it fans every unfanned row out to every
   pipeline currently subscribed to that event, and re-fans a dead-letter row the same way on its
   next retry.
4. Take another snapshot after the first few ticks and run `data` again to confirm both counts have
   dropped to 0 (or are only events still arriving normally).
5. To move back to `events-direct`, or to stop running `events-queue` at all, stop writes first,
   then drain: call `events.readQueueStatus` on the running project and wait for both `pending` and
   `running` to reach 0. This counts every row regardless of pipeline assignment, so it is the
   correct condition after the first tick has already given every row a pipeline — `data`'s
   pipeline-less counts no longer see those rows. With several worker processes, poll each one;
   `running` must be 0 on all of them. Only once drained, swap the module. A row still in the queue
   when the module is removed is never delivered.

## Rule reference

Every finding's `docs` field links to one of the anchors below.

Rules read each module entry's effective config: its `config` laid over its `defaults`, if it has
any (see [configuration](configuration.md#host-supplied-defaults)). A fix writes only into `config`.
Where writing an array would replace one the defaults supply, the rule goes manual, so the default
entries are never dropped. A fix that swaps one module for another writes the new entry without the
old entry's `defaults`, because they belong to the module being removed.

| Rule id | Tier | Fix | What it checks |
|---|---|---|---|
| [`modules/event-delivery`](#modules-event-delivery) | load | auto | `events-inmemory` with no delivery module next to it |
| [`modules/event-bus`](#modules-event-bus) | load | auto | `events-queue` with no `events-inmemory` next to it |
| [`steps/removed`](#steps-removed) | source | auto | a string-literal reference to a removed step |
| [`pipelines/verified-user`](#pipelines-verified-user) | load | auto / ask / manual | `revisions.reassignAuthor` with no verify step ahead of it |
| [`pipelines/require-role`](#pipelines-require-role) | load | auto | `authn.requireUser` with no `authz.requireRole` after it, with authz-roles |
| [`authz/media-list`](#authz-media-list) | load | auto | a role in authz-roles' config that grants `media.read` but not the media listing permission, with media-default |
| [`steps/undeclared-output`](#steps-undeclared-output) | boot | ask | a step writes `result` without declaring its shape |
| [`steps/undeclared-required`](#steps-undeclared-required) | boot | ask (no default) | an output schema declares properties without `required` |
| [`steps/output-fold`](#steps-output-fold) | boot | manual | two steps' output schemas cannot fold onto one active schema |
| [`steps/terminal-output`](#steps-terminal-output) | boot | manual | a misplaced or misdeclared `terminalOutput` |
| [`pipelines/optional-read-order`](#pipelines-optional-read-order) | boot | manual | an optional read only a later step in the same pipeline writes |
| [`pipelines/unwritten-optional-read`](#pipelines-unwritten-optional-read) | boot | none (warning) | an optional read nothing writes and no trigger provides |
| [`model/underscore-field`](#model-underscore-field) | load | ask / auto | a content field name starting with `_` |
| [`responses/delivery-members`](#responses-delivery-members) | load | none (info) | an HTTP pipeline running a delivery step |
| [`runtime/bus-handler-throws`](#runtime-bus-handler-throws) | source | none (info) | a local `events.on` subscriber under `events-direct` |
| [`runtime/bus-subscriber-queue`](#runtime-bus-subscriber-queue) | source | none (info) | a local `events.on` subscriber under `events-queue` |
| [`data/queue-unfanned`](#cutover), [`data/queue-dead-unassigned`](#cutover) | data | none (warning / info) | stored queue rows the `data` command finds |
| [`data/underscore-field-stored`](#model-underscore-field) | data | none (warning) | the `data` command counted a stored value under a `_`-prefixed content field |
| [`steps/closed-event-input`](#steps-closed-event-input) | source | manual | an event-triggered pipeline's step closes its input schema |
| [`modules/emits`](#modules-emits) | source | ask | a local module's heuristic `.emit(` calls, undeclared in `emits` |
| [`modules/delivery-media`](#modules-delivery-media) | source | auto | `delivery-static`'s removed `media` option |
| [`modules/media-public-path`](#modules-media-public-path) | source | auto (warning) | `images-default`'s `publicPath` not matching `media-default`'s |
| [`modules/images-media-option`](#modules-images-media-option) | source | auto (error / warning) | `images-default`'s removed `media` option |
| [`modules/images-render-timeout`](#modules-images-render-timeout) | source | manual | `images-default`'s `renderTimeoutMs` not below its `staleAfterMs` |
| [`modules/references-media-target`](#modules-references-media-target) | source | auto (warning) / none (info) | a `references-default` target reading `media_items`, or any other collection, directly |
| [`events/images-variants-changed`](#events-images-variants-changed) | source | none (info) | a pipeline on `media.updated` that does not also listen to `images.variantsChanged` |
| [`pipelines/media-serve`](#pipelines-media-serve) | source | auto (pipeline files + trigger) / manual | `publicCopy` set with no pipeline serving it, or anonymous callers refused it |
| [`pipelines/media-repair`](#pipelines-media-repair) | source | auto (info) | `publicCopy` set with no pipeline running the public-copy repair |
| [`pipelines/images-resume-cron`](#pipelines-images-resume-cron) | source | manual (warning) | `images-default` configured with no cron-triggered `images.resume` |
| [`pipelines/media-delete-order`](#pipelines-media-delete-order) | source | auto (warning) / none (info) | an images cleanup step running before the media delete it follows from, or a folder delete not raising `media.deleted` |
| [`runtime/authz-anonymous-floor`](#runtime-authz-anonymous-floor) | source | none (info) | `authz-roles` with a non-empty `anonymous` |
| [`pipelines/field-step`](#pipelines-field-step) | boot | ask (no default) | a pipeline anonymous callers reach without `authz.fields` at its end, or without an anonymous field grant |
| [`authz/field-grant-unknown`](#authz-field-grant-unknown) | boot | manual | a field grant or an `authz.fields` step that does not fit the declared output |
| [`responses/anonymous-fields`](#responses-anonymous-fields) | load | none (info) | an HTTP pipeline anonymous callers reach and the members they stop receiving |
| [`responses/thrown-error-text`](#responses-thrown-error-text) | load | none (info) | a file next to a local module matching on an answer's `error` text |
| [`runtime/anonymous-media-list`](#runtime-anonymous-media-list) | source | none (info) | anonymous `media.read` granted while `anonymousList` stays `"ids"` |
| [`imports/removed-export`](#imports-removed-export) | source | manual | an import or call of a `delivery-static` export removed in 6.0.0 |
| [`imports/contract-helpers`](#imports-contract-helpers) | source | auto | an import of a contracts helper at its pre-6.0.0 path, moved under `helpers/*` |
| [`types/breaking-signatures`](#types-breaking-signatures) | source | none (info), always | type-level members a hand-built implementation must add |
| [`responses/breaking-step-shapes`](#responses-breaking-step-shapes) | source | none (info) | a pipeline running a step whose response or manifest shape changed |
| [`responses/binary-cache-control`](#responses-binary-cache-control) | source | none (info) | a local module mentioning `cache-control` near a binary step result |
| [`pipelines/images-plan`](#pipelines-images-plan) | source | manual (warning) | a pipeline calling `images.plan` directly |
| [`data/translation-slug`](#data-translation-slug) | data | manual (error) | a stored translation of a routed type that is published without a slug of its own, or below a page without a slug in its locale |
| [`data/media-layout`](#data-media-layout) | data | none (error / warning) | media or variant rows in the 5.x storage shape, found by the storage migrations `media-default` and `images-default` export; `kestrel upgrade migrate` converts them |
| [`data/redirect-reserved-paths`](#data-redirect-reserved-paths) | data | manual (warning) | a stored `redirects-default` rule or automatic redirect whose source can match a reserved path (`/admin`, `/api`, `/media` unless `reservedPaths` says otherwise) |
| [`data/site-media-leftovers`](#data-site-media-leftovers) | data | manual (warning) | a leftover 5.x static export copy next to the public copies `media.syncPublic` writes |
| [`data/blobstore-tmp-suffix`](#data-blobstore-tmp-suffix) | data | none (info) | a stored filesystem-blobstore key already ending in `.kestrel-tmp` |
| [`steps/ctx-done-terminal-output`](#steps-ctx-done-terminal-output) | source | none (info) | a local module calling `ctx.done()` |
| [`tests/run-pipeline-validates`](#tests-run-pipeline-validates) | source | none (info) | a file importing `testing/runPipeline` |
| [`boot/dependency-cycle`](#boot-dependency-cycle) | boot | manual | a module dependency cycle |
| [`runtime/restore-freshness`](#runtime-restore-freshness) | load | none (info) | `restoreOnStart` left on for `replication-sqlite`/`backup-blobstore` |
| [`runtime/single-process`](#runtime-single-process) | load | none (info) | a `persistence-sqlite`, `replication-sqlite` or `backup-blobstore` entry, each of which takes the instance lock on its database file |
| [`http/trusted-proxies`](#http-trusted-proxies) | load | none (info) | `http.trustProxy` or `http.trustedHeader` without `http.trustedProxies` |
| [`delivery/dependents`](#delivery-dependents) | source | none (info) | `delivery-static` publishing on events without marking dependent outputs |
| [`delivery/export-llms`](#delivery-export-llms) | load | auto / manual | a pipeline file naming the removed `delivery.exportLlms` |
| [`delivery/site-url`](#delivery-site-url) | load | auto / manual | `delivery-static`'s `llms.siteUrl`, moved to a top-level `siteUrl` |
| [`delivery/robots-policy`](#delivery-robots-policy) | load | manual (warning) | `delivery-static` without `robots.policy`, so robots.txt follows `NODE_ENV` |
| [`delivery/restore-check`](#delivery-restore-check) | load | none (info) | a pipeline running `delivery.checkBuild` without the `checkRestored` step of a `replication-sqlite`/`backup-blobstore` on the persistence-sqlite file directly before it |
| [`delivery/index-triggers`](#delivery-index-triggers) | load | auto (pipeline files + triggers) / manual | `dependencies.render: "events"` without the jobs that export the index files |
| [`site/routed-slug-unique`](#site-routed-slug-unique) | load | auto (error / warning) | a `unique` slug field on a type in `site-default`'s `routes` |
| [`site/path-wiring`](#site-path-wiring) | boot | manual | a routed write without `site.indexPath`/`site.announcePaths`, or a read with another `home`/`slugField` |
| [`site/path-events`](#site-path-events) | load | manual (error / warning) | `routes` without an `events@1` provider, or without a pipeline on `site.pathsMoved` |
| [`redirects/requires-persistence`](#redirects-requires-persistence) | load | manual | `redirects-default` without a `persistence@1` provider |
| [`imports/redirects-impl`](#imports-redirects-impl) | load | none (info) | a local module importing `kestrel-redirects-default/impl` |
| [`deps/kestrel-range`](#deps-kestrel-range), `deps/mixed-majors`, `deps/pre-install` | source | auto / manual / none | a `@michaelthielemann/kestrel*` dependency range |
| [`deps/zod-range`](#deps-zod-range) | source | auto | a `zod` dependency range that admits a release below 4.6.6 or another major |
| [`zod/record-key`](#zod-record-key) | source | auto | a `z.record` call with only a value schema |
| [`zod/object-default`](#zod-object-default) | source | auto / manual (warning) | an object or union schema's object-literal `.default({…})`; a default whose nested defaults zod 4 no longer fills |
| [`zod/describe-order`](#zod-describe-order) | source | auto | a `.describe()` followed by `.strict()`, `.partial()`, `.or()` or another method that drops it |
| [`scripts/kestrel-binaries`](#scripts-kestrel-binaries) | source | auto / manual (warning) | a `kestrel-openapi` or `kestrel-upgrade` command, or an unscoped `npx kestrel`, in `package.json` scripts or another project file |
| [`deps/host-outdated`](#deps-host-outdated), `deps/host-refused` | source | manual | a direct dependency whose plugin is not built for this version, or whose `kestrel` field is refused |
| [`offer/event-queue`](#offer-event-queue) | source | none / ask / auto | the switch from `events-direct` to `events-queue` |
| [`boot/<code>`](#boot-code) | boot | manual | any boot error no rule above claims |
| `boot/not-checked` | boot | none (warning) | a module or pipeline `checkBoot()` could not check safely |
| `load/failed` | source | manual | a config, module or pipeline file that failed to load |
| [`sandbox/blobstore-standin`](#sandbox-blobstore-standin) | boot | none (info) | a `blobstore@1` provider the sandbox replaced to keep the boot tier open |
| [`sandbox/unmatched-entry`](#sandbox-unmatched-entry) | boot | manual (warning) | a plugin's sandbox key that matches no module-list entry |
| [`plugin/hook-failed`](#plugin-hook-failed) | source | manual | a plugin hook (`dataModel`) or a rule's own `check()` threw instead of returning |
| [`preview/edit-refused`](#preview-edit-refused) | boot | none (warning) | a boot-preview edit could not be verified (its target escaped the preview copy, or the copy could not reload) |
| [`data/config-load-failed`](#data-config-load-failed) | data | manual | `kestrel.config.ts` exists but could not be loaded, so the `data` command's underscore-field count was skipped |

#### modules-event-delivery
An event trigger or `events.emit` needs exactly one delivery module (`events-direct` or
`events-queue`) configured next to `events-inmemory`. The fix inserts `events-direct`.

#### modules-event-bus
`events-queue` requires `events@1` instead of providing it; the fix inserts `events-inmemory` next
to it.

#### steps-removed
A step removed in 6.0.0 (for example `media.folderItems`) is renamed to its replacement.

#### pipelines-verified-user
`revisions.reassignAuthor` now requires a preceding `authn.verifyUser` step naming the target; the
fix inserts one when the pipeline's own trigger makes the right path unambiguous, asks when it does
not, and stays manual without `authn-multi` configured.

#### pipelines-require-role
An account without a configured role may only sign out and read its own identity. With authz-roles,
every pipeline that runs `authn.requireUser` must run `authz.requireRole` after it, or boot fails
naming the pipeline; the fix inserts the step. A pipeline any signed-in account may run goes into
authz-roles' `rolelessPipelines` instead (default `["me", "logout"]`).

#### authz-media-list
With an `authz@1` module, media-default lists media only for callers holding `listPermission`
(default `media.list`). A role written in authz-roles' config that grants `media.read` without it
would lose the media library; the fix adds the permission to that role's list. Roles granting `*` or
`media.*` already hold it.

#### steps-undeclared-output
A step writes `result` without declaring `output`, `extendsOutput`, `extendsItems` or `binary:
true`. Answering "yes" (a binary body) adds `binary: true`; "no" or no answer stays manual.

#### steps-undeclared-required
An output schema declares properties without saying which are always present. There is no safe
default; the answer becomes the schema's `required` array, `"all"`, or `"none"`.

#### steps-output-fold
Two steps' output schemas contradict each other once folded (`extendsOutput`/`extendsItems`
against a non-object schema, or a shape mismatch) — `boot()` names the exact step and schema path.

#### steps-terminal-output
A step declares `terminalOutput` without writing `result`, or together with a `binary` step in the
same pipeline.

#### pipelines-optional-read-order
A step optionally reads a key only a *later* step in the same pipeline writes.

#### pipelines-unwritten-optional-read
A step optionally reads a key nothing writes and no trigger provides — almost always a typo.

#### model-underscore-field
A content type field name starts with `_`, which fails boot on 6.0.0. `data --db <file>` opens a
copy of the store and, through `persistence@1`, counts non-null stored values for the field: one
count per locale column for a localized field (`{ ne: null }` on `<field>__<locale>`), one count for
an unlocalized field. `--out <report>.json` writes these counts alongside its other findings; feed
that file back with `check --data-report <report>.json` / `fix --data-report <report>.json`:

- Zero everywhere — the rename is a data-verified auto edit, applied like any other automatic fix.
  Zero only comes from a successful count against a column that already exists on an already-existing
  table: a missing table, a missing column, or a count that itself fails is `null`, never `0`, and
  behaves like no data report at all.
- A stored value, or a `null`, in at least one locale — the rule still asks, with no default,
  reporting what it saw so you can judge which locales need a migration.
- No data report at all — the rule asks, with no default, and points at `kestrel upgrade data`.
- An explicit rename answer given without a data report proving the field empty is still applied,
  naming the old column and how to check it. Nothing remembers this across runs by itself: on a
  later `check`/`fix` run given `--data-report <report>.json`, the rule probes the *new* field name's
  own old, underscore-prefixed column directly against that report's raw counts, so it warns again as
  long as the old column still holds data — even though the field itself no longer starts with `_` —
  but a run given no `--data-report` at all stays silent about it, the same as any other data-report
  question. Run `kestrel upgrade data` again and pass its report to confirm the old column is empty.

Where a stored value can exist, rename it in two phases instead of trusting a mechanical edit:

1. On the running 5.8.x instance, add the new field next to the old one and a `defineMigration`
   that copies `_foo` to `foo`.
2. Deploy that change and let it apply to every stored document.
3. Remove `_foo` from the config.
4. Only then run this tool and upgrade to 6.0.0 — by that point the field no longer starts with `_`
   and this rule has nothing to ask about.

#### responses-delivery-members
An HTTP-triggered pipeline running a delivery step answers with the 6.0.0 response shape:
`delivery.publish` merges `{ document, delivery }` into `_delivery` instead of replacing the result
with it, and a missing id is `400` instead of `500`. A pipeline that ran `delivery.exportLlms` runs
`delivery.requestIndexes` instead (see [delivery-export-llms](#delivery-export-llms)), which adds
nothing to the result, so the response no longer has an `llms` member.

#### runtime-bus-handler-throws
A local module subscribes to `events@1` with `.on(...)`. Under `events-direct`, a handler that
throws now fails the emitting run with `500` instead of being logged and ignored.

#### runtime-bus-subscriber-queue
A local module subscribes to `events@1` with `.on(...)` for an event a trigger also listens to.
Under `events-queue`, a pipeline step's `events.emit` never touches the bus, so this subscriber
stops seeing it.

#### steps-closed-event-input
An event-triggered pipeline's step closes its input schema (`additionalProperties: false`), which
can now reject the event payload.

#### modules-emits
A local module raises an event from `setup()` (found heuristically via `.emit(` calls) without
declaring it in `emits`. The default answer lists the names found.

#### modules-delivery-media
`delivery-static`'s `media` option (URL rewriting, copying media into the output prefix, reading
`media_items`/`images_variants` directly) is removed in 6.0.0 — a config that still sets it fails
validation. The fix removes `media`, sets `publicCopy: { prefix: <delivery-static's own prefix> }`
on `media-default` and `images-default`, adds `reservedPaths: [<the old media.publicPath,
normalised>]` to `delivery-static`, and carries a non-default `publicPath` over to both media
modules. Falls back to manual, naming what it could not locate, when `reservedPaths` already has
entries the tool cannot safely merge into, or `media-default` is not configured at all. It also
falls back to manual, without guessing a value, when the old `media.publicPath`'s first segment is
`api` or `admin` — many projects reserve both for their own API and admin UI, and this
check cannot see where a given project actually mounts either one; pick a `publicPath` outside your
own project's mounts by hand (commonly `/media`) and list it in `reservedPaths` alongside them.

#### modules-media-public-path
`images-default`'s `publicPath` must match `media-default`'s exactly — no trailing slash, which a
5.x regex allowed on either. A mismatch answers 404 for every image variant path.

#### modules-images-media-option
`images-default`'s `media` option (`media.collection`, the collection it read `media-default`'s rows
from) is removed in 6.0.0: `images-default` requires `media@1` and reads media only through it, and a
config that still sets the option fails boot. The fix removes the option. It is an error when the
collection is `media_items` (or unset), since `media-default` provides `media@1` already; a warning
when it names another collection, since whichever module owns that store has to provide `media@1`
now for `images-default` to boot. Without any `media@1` provider, boot reports
`boot/missing-provider`.

#### modules-images-render-timeout
`images-default` holds a lease on a media item for `staleAfterMs` while it places, renders and writes
its paths, and renews it before each write, so a render has to end before the lease runs out. From
6.0.0 on its config fails validation with `renderTimeoutMs must be less than staleAfterMs` unless
`renderTimeoutMs` (default 30000) is below `staleAfterMs` (default 60000). Both options exist in 5.8,
so a project that set `staleAfterMs` to 30000 or less and left `renderTimeoutMs` at its default
booted there and fails here. The finding names both values, defaults included; raise `staleAfterMs`
above `renderTimeoutMs` or lower `renderTimeoutMs` below `staleAfterMs` by hand. When the boot tier
runs and this is the only issue in `images/default`'s config, the finding stands in for that boot
error, so `boot/invalid-module-config` is not listed for it as well.

#### modules-references-media-target
A `references-default` target `{ collection: "media_items" }` reads `media-default`'s collection
directly. With `media-default` configured, the fix sets the target to `{ media: true }`, which reads
the ready files through `media@1`: an upload still in flight or a file being deleted then counts as a
dangling reference instead of an existing one. A target on any other collection gets an info
finding: `{ collection }` is meant for a collection the project owns itself, and data another module
owns is read through that module's contract.

#### events-images-variants-changed
`images-default` announces that an item's variants changed — it placed the item, a size was added or
changed, a size was pruned, a re-crop or another render that changed a variant's `?v=` is at its path, or the focus changed — as its own event `images.variantsChanged` (`{ id: null, ids,
identity: null, params: {} }`), never as `media.updated`, which belongs to the pipeline that edits a
medium. A pipeline triggered by `media.updated` that should also follow variant changes, such as one
running `delivery.markDependents:media`, needs a second trigger on `images.variantsChanged`; the info
finding names the trigger to add for each such pipeline.

#### pipelines-media-serve
`publicCopy` set on `media-default` or `images-default` (including one `modules/delivery-media`'s
fix is about to add) needs a pipeline running `media.serve` / `images.serve`, or boot fails. Auto
when the project has a pipelines directory to scaffold into: creates `serveMediaFile.ts` /
`serveImageVariant.ts` (steps `authn.identifyUser`, `authz.require:media.read`, the serve step and
`authz.fields:mediaFile?shape=file`, whose grant `pipelines/field-step` proposes)
next to the project's other pipeline files, and adds the matching HTTP trigger(s)
(`GET <publicPath>/:id/:name` and `GET <publicPath>/:id/variants/:file`) in one edit; falls back to
manual, naming the steps and triggers to add by hand, when the directory or the config file cannot
be found — the write is refused outright if either target file already exists. A separate finding
fires when `authz-roles` is configured but its `anonymous` grants do not include `media.read`, since
a pipeline declaring its serve step's output public then fails boot too; this one stays manual.

#### pipelines-media-repair
`publicCopy` set needs a pipeline running `media.syncPublic` / `images.syncPublic`, or the public
copy tree drifts from what is stored without ever repairing itself. Auto when the project has a
pipelines directory: creates `repairPublicMedia.ts` (steps `authn.requireUser`,
`authz.require:media.manage`, `media.syncPublic`, `images.syncPublic`) behind an admin HTTP trigger,
and `syncPublicMedia.ts` (steps `media.syncPublic`, `images.syncPublic`) on a nightly cron trigger,
in one edit; falls back to manual otherwise.

#### pipelines-images-resume-cron
`images-default` configured with no pipeline running `images.resume` on a cron trigger: a failed
placement, a missed plan or an idempotent re-upload now depends entirely on this background repair
pass, so availability regresses silently without it. Always manual, naming the `resumeImages`
pipeline and cron trigger to add — a pipeline that already runs `images.resume` without a cron
trigger gets a finding naming that instead of "no pipeline runs it".

#### pipelines-media-delete-order
A pipeline running `images.remove` before `media.remove`, or `images.removeMany` before
`media.removeFolder` or `media.purge`: a render finishing in the gap between the two can leave a
public copy or a private blob behind. Auto-swaps the two steps' own text in place when the pipeline's file can be
read; manual otherwise. A separate, info-only finding fires when a pipeline runs
`media.removeFolder` without `events.emit:media.deleted` afterwards, since a subscriber (a
`delivery.markDependents:media` pipeline, for one) never sees the deleted ids.

#### runtime-authz-anonymous-floor
`authz-roles` with a non-empty `anonymous` list: a signed-in caller now also holds every permission
`anonymous` grants, in `authz.require`, `can` and `describePipelineAccess` — a signed-in caller
refused something an anonymous visitor could do before is served now.

#### pipelines-field-step
Every pipeline an anonymous caller reaches over HTTP must end with `authz.fields:<resource>?shape=<shape>`,
and `authz-roles`' `anonymousFields` must grant fields of that resource, or boot fails. The rule takes
the pipelines and shapes from boot's own message and the resource from the step that reads the answer
(`content.get`/`content.list`/`site.resolve:<type>` → `<type>`, `media.get`/`media.list` → `media`, a
file step → `mediaFile`, `redirects.render` → `redirectRules`). It proposes the grants from the loaded
project: `id` and every model field of a content type, `_locales` and `_translations` with locales,
`_locale` and `_links` behind `site.resolve`, `redirect` behind `redirects.lookup`; the public media
fields, and `focus` and the variant fields behind `images.attach`; the file headers `cache-control`,
`x-content-provenance` and, with `images-default`, `x-kestrel-variant`; the redirect rules' `pattern`,
`target` and `status`. It asks once, with no default, since every granted field is served to callers
without a session: "yes" appends the step to each pipeline file and sets `anonymousFields` (existing
grants kept), "manual" leaves both to you. A pipeline whose resource it cannot tell stays manual.

#### authz-field-grant-unknown
A grant names a field no pipeline of its resource declares, grants a resource no pipeline cuts, or an
`authz.fields` step does not fit its pipeline (a step after it, a shape the declared output does not
fit, an answer an earlier step ends the run with that the anonymous grant or a role's grant does not
cover).
Manual; the suggestion is the hint boot gives, for example `"variants" is a list, write
"variants[].path"`.

#### responses-anonymous-fields
An HTTP pipeline that anonymous callers reach answers them only the fields `anonymousFields` grants once
it ends with `authz.fields`. The finding names the members they stop receiving with the example's
grants: `createdAt` and `updatedAt` of a document; `folder`, `createdAt`, `updatedAt`, and behind
`images.attach` `available`, `variantCounts`, `framing` and each variant's `bytes` and `state` of a
media item; any header of a file the grant does not name. Signed-in callers whose roles have no
field grant keep the whole answer.

#### responses-thrown-error-text
A file next to a local module compares the `error` text of an answer (`res.error` with `toContain`,
`includes` and the like). A step that throws now answers `"<pipeline>/<step>: unexpected <ErrorName>"`
for every caller; its message and stack are in the log under the answer's `runId`. Match on `code` and
`step`, or read the log. Answers a step fails on purpose with `ctx.fail` keep their message.

#### runtime-anonymous-media-list
`authz-roles` grants anonymous `media.read`, but `media-default`'s own `anonymousList` stays at its
`"ids"` default: an anonymous caller can still only fetch media by explicit ids, not browse the full
listing or folders (401). Set `anonymousList: "all"` to restore that too, if intended.

#### imports-removed-export
`rewriteMedia`, `MediaMatch`, `MediaConfig` and `contentTypeByExtension` are no longer exported from
`kestrel-delivery-static/impl`, and the startup key migration `migrateKeys` no longer exists. Custom
code importing any of the former, or calling the latter, needs a by-hand rewrite: reach a media file
through the API's own `path` field and set `publicCopy` on the media modules for a static copy.

#### imports-contract-helpers
`content-locale`, `content-schema`, `mediaType`, `persistence.owned` and `steps` are runtime helpers
of `@michaelthielemann/kestrel-contracts`, not frozen contracts, and import as
`@michaelthielemann/kestrel-contracts/helpers/<name>`; the contracts package's own README lists
exactly what is frozen and what is a helper. `events.envelope`, `stepSet`, `links`, `events.steps`,
`persistence`, `renderer` and `migrations` split between the two: `stepSet`'s `StepSet` type,
`links`'s `INTERNAL_REF`/`InternalRef`/`LinkTarget`, and `events.steps`'s own step-set declaration and
shapes stay importable at their unchanged path, while a runtime function from the same old path
(`defineStepSet`/`stepSets`, `collectInternalRefs`, `relaySummary`/`mergeRelayReport`) moves to
`helpers/`. `events.envelope`'s own runtime functions
(`eventEnvelope`/`parseEmitSpec`/`withEventIdentity`) move to `helpers/events.envelope` too, but its
`EventEnvelope`/`EventIdentity` payload types move to a *different* top-level file, `events.steps`,
next to the other frozen shapes of the step set they belong to — not left importable from
`events.envelope` at all, since that path stops existing. `persistence`'s `fieldDefinition`,
`renderer`'s `renderFailed` and `migrations`'s `migrationFailed` move to
`helpers/persistence`/`helpers/renderer`/`helpers/migrations`; the contract's own interface and types
stay.

The rule scans every `.ts`/`.mts`/`.js`/`.mjs`/`.vue` file of the project (not an installed package's
own); in a `.vue` file, only its `<script>`/`<script setup>` block(s) are read, never the template.
`content-locale`, `content-schema`, `mediaType`, `persistence.owned` and `steps` move as a whole, so
every import form is rewritten: a static `import`, a dynamic `import()`, `require()`, `vi.mock()`, a
namespace import, a re-export. The other seven split between a name that stays and one that moves, so
only a static `import`/`export { … } from` naming one of them is rewritten — split into two
declarations when it mixes both. A namespace import, a default import, a side-effect import
(`import "…"` alone), `export * from`/`export * as … from`, or a dynamic `import()`/`require()` naming
one of these seven cannot be split by name, so the rule reports it as a manual finding naming the file
instead of silently leaving it broken. A file (or, in a `.vue` file, one of its script blocks) the rule
cannot parse at all is skipped with the same manual finding when its text still mentions
`@michaelthielemann/kestrel-contracts/`, and silently otherwise — never aborting the rule for the rest
of the project.

#### types-breaking-signatures
`Deps`, `Introspection`, `PipelineDefinition["steps"]`, `ModuleManifest`, `FakePersistence`,
`Manifest`, `Kestrel["contracts"]`, `Media` and `Images` all gained required members or new ones
worth knowing about — among them `createImages`'s required `deps.media`, `Media` extending
`MediaFiles` and `MediaStatus`'s `removing`; only the consumer's own typecheck sees a violation in a hand-built
implementation of one of them. The media trash adds to this: `MediaStatus` gains `trashed`, so an
exhaustive `switch` over it needs the case; `MediaItem` gains `trashedAt` and `trashVersion`, and its
`location` may be `null` (while the item is trashed), so code that reads `item.location` as a string
needs a check; `Media` gains `trash`, `trashFolder`, `restore`, `listTrash`, `trashIds`,
`selectTrash` and `purge`, and `Images` gains `hide`, `show` and `hidden`, which a hand-built test
double of either must add. Removing upload metadata adds `sourceChecksum` to `MediaItem`: the sha256
of the bytes as uploaded when removing their metadata changed them, `null` otherwise, which a
hand-built item must set. Focus and crop add `setFraming` and `framingsOf` to `Images` and the
fields `crop`, `renderedCrop`, `renders`, `originalWidth` and `originalHeight` to `Variant`, which a
hand-built variant row must set (`""` or `null` for the centre, `0` or `null` for no render yet or
unknown dimensions). `Planned`
gains `crop`: a `Renderer` passed to `createImages` as `deps.render` must cut `planned.crop` from the
original after its EXIF orientation before it resizes, or a framed size records a crop its bytes do
not have.
`ModuleDefinition["configSchema"]` and the `configSchema` that `defineModule` takes are
zod 4 schemas (`ZodTypeAny` from `zod` `^4.6.6`); a schema built with zod 3 no longer typechecks
there (see [`deps/zod-range`](#deps-zod-range)).

#### responses-breaking-step-shapes
A pipeline runs a step whose 6.0.0 response or manifest shape differs from 5.8's — `redirects.lookup`,
`media.upload`, `media.get`, `media.list`, `media.update`, `media.listFolders`, `media.remove`,
`media.removeFolder`, `media.renameFolder`, `media.reconcile`, `media.reconcileDelete`,
`images.attach`, `images.serve`, `images.prune`, `images.generate`, `images.retryFailed`,
`images.sync`, `images.readStatus`, `insights.readManifest` (a step description gains `narrows`) or
`events.listDead`; the finding names which one and how.
`media.upload`'s own change also covers the declared type: one that is not exactly one
`type/subtype` (a list such as `image/png, text/html`, or an empty type) is refused with 415, and
only its lower-cased `type/subtype` is stored, plus a `text/*` type's charset, so
`allowedTypes`/`deniedTypes` match it without parameters (a parameterised type that passed a denylist
before is now refused). The stored name's
extension comes from that stored type, never from the uploaded name: a listed type keeps its own
extension, and every other type — like an SVG that `sanitize.svg` did not clean in the same
pipeline — is stored as `<name>.bin` and published as `application/octet-stream`.

#### responses-binary-cache-control
A local module mentions `cache-control` in its own source, near a binary step result: 5.x silently
replaced a binary result's own `cache-control` header with `no-store`; 6.0.0 sends it as given. Info
only — the finding just points at the module to review by hand.

#### pipelines-images-plan
A pipeline calls `images.plan` directly. Always manual: with direct event delivery,
`images.generate` now plans internally, so a standalone `images.plan` step can usually be dropped;
with queue delivery and lane-based bulk pipelines, split it into a main-lane `planImageVariants` and
a `generateImageVariants` triggered on `images.planned` instead — which one applies depends on the
project's delivery mode and whether it has adopted lanes, so this tool does not guess. Silent once a
pipeline already does only the planning half and some pipeline triggered on `images.planned` does
the generating half — that split is already correct, not something to review again.

#### data-translation-slug
In 6.0.0 a locale is served only through its own slug: a translation published without one has no path,
answers 404, is not exported and cannot be saved as published again (`site-default`'s `site.indexPath`
refuses it). The `data` command reads every type `site-default` routes (its `routes`, or the ones a host
plugin's `dataModel` names) and reports each translation that passes the route's `liveWhen` in its own
locale, holds at least one localized value there and has no slug there. Set a slug in that locale, or
withdraw the translation. Where the default locale is published, the finding names its slug, which is
public already and may be copied; where it is not, the finding names only the document and locale, since
that slug is not public. It also reports every document published with a slug of its own in a locale
where a page above it (its parent chain, or the page its mounted collection lives under) has no slug:
6.0.0 takes every path segment from a slug of the path's own locale, so such a document has no path
there. Give that page a slug in the locale, or withdraw the documents below it. The tool does not change the database: make the change in the admin or through
the API, or with a migration on the running instance, then run `data` again.

#### data-media-layout
The detection step of the storage migrations that `media-default` and `images-default` export
under `./storage`, run by the `data` command on its own copy of the database. An error names the
module, the pending migration (`media-default:id-key-layout` for a `media_items` row whose key is not
`<prefix><id>/<name>` or that has no `location`, `images-default:variant-slots` for an
`images_variants` or `images_retired` row with no `slot`), how many items it found with a few of
their ids, and the command that converts them: setup refuses such data in 6.0.0. Run
[`kestrel upgrade migrate`](#7-converting-the-stored-media) on a copy of the data. A stored storage
version that 6.0.0 does not read is an error too. When the installed module has no `./storage`
export (its 5.x release is still installed), the finding is a warning: install the 6.0.0 packages
and run `data` again. The module configs, such as the media key prefix, come from
`kestrel.config.ts`, or through the project's host plugin when that file does not load by itself;
when neither loads, `data/media-layout:config` warns that the check ran with the defaults.

#### data-redirect-reserved-paths
A rule stored by the redirect editor whose `from` equals, lies below or, through a wildcard (`/**`,
`/*`, `/*/login`), can match a path in `redirects-default`'s `reservedPaths` (default `/admin`, `/api`,
`/media`). From 6.0.0 the editor refuses such a source, and publishing leaves a stored one out of `redirects.json` and the lookup, logging the row, so the redirect
silently stops working. The `data` command reads the rules of the type and field the module is
configured for and lists up to five of them. An automatic redirect, the kind a renamed page leaves
behind, whose source is at a reserved path is left out the same way; it is listed in a second finding
for `redirects_auto_paths`. Manual: remove or move the rule before the upgrade, or
change `reservedPaths` if the path is not one your application serves itself. A catch-all such as `/**` is
left out for every path, not only for the reserved ones.

#### data-site-media-leftovers
An entry of the 5.x delivery-static media export directory (the delivery prefix and the old
`media.target` under the filesystem blobstore's `root`, resolved relative to the project root) that
is not an `<id>/` directory of an item in `media_items`. With `publicCopy`, `media.syncPublic`
writes its copies into the same directory, one `<id>/` directory per item, so those are never
reported. Before the first `media.syncPublic` the finding also names the 5.x copies one folder deep
(`<folder>/<file>`); that run removes them, so a link to one of them stops working with it, while a
copy directly under the media path or in a deeper folder stays. Manual: names the entries (up to ten,
with the count of the rest) and says to delete what is left of them, and only that, once every page
that might still link one has been republished.

#### data-blobstore-tmp-suffix
A stored filesystem-blobstore key already ending in `.kestrel-tmp`: 6.0.0 reserves that suffix for
its own atomic-write temp files, so such a key is now unlisted and unreadable through the store.
Info only, since a legitimate use of that literal suffix before 6.0.0 is unlikely but not impossible.

#### steps-ctx-done-terminal-output
A local module calls `ctx.done()`. A step that ends the run this way without declaring
`terminalOutput` now fails that run with `INTERNAL` in every mode; under `validateOutput`, one whose
early result does not match its `terminalOutput` fails too. Boot cannot see the call by itself.

#### tests-run-pipeline-validates
A file imports `testing/runPipeline`, which now always validates `ctx.result` against the folded
output schema; a test that produced an undeclared shape now fails.

#### boot-dependency-cycle
A module dependency cycle — `boot()` names the full cycle path.

#### runtime-restore-freshness
`replication-sqlite`/`backup-blobstore` now fail boot when the database file was created during
this boot while a restore point exists, if `restoreOnStart` is on (the default).

#### runtime-single-process
`persistence-sqlite`, `replication-sqlite` and `backup-blobstore` take an instance lock on their
database file at setup. The lock is a sidecar `<file>.instance` next to the database (for a SQLite
`file:` URI, the file in its path, without the query), never a row inside it, so it does not travel with a replica, a snapshot or a backup. A second process that starts
on the same file fails boot with `instance-locked`, naming the host, PID and start time of the
process that holds the lock. A deploy that starts the new process before the old one has stopped
fails the same way; stop the old process first. A lock left behind by a killed process is taken over
60 s after its last heartbeat, at once when the process ran on the same machine in the same PID
namespace. The finding appears once for each such module entry, and not for an entry whose database
takes no lock (an in-memory or temporary database, for which the core's `instanceLockFile` returns
`undefined`; the core README lists those names and URIs) or with `allowConcurrentProcesses: true`, the
setting for several processes that share the file on purpose. The 5.x data is not changed by this: the first 6.0.0 start creates the
sidecar. `kestrel upgrade data` and `kestrel upgrade migrate` neither take nor honour the lock, so a
sidecar left next to a copy of the database does not stop them.

#### http-trusted-proxies
`http.trustProxy` or `http.trustedHeader` is set, but `http.trustedProxies` is not. Forwarding headers
now count only from a peer in `trustedProxies`, which defaults to loopback (`127.0.0.0/8`, `::1`). A
proxy that connects from another address — another host, a container network — is ignored, every
request is attributed to the proxy's address (one rate-limit key for all clients, and an allowlist
decides on the proxy), and the server logs `forwarding header from <peer> ignored` once per peer and
hour. List the proxy's address or network in `http.trustedProxies`.

#### delivery-dependents
`delivery-static` publishes on events, but no pipeline runs `delivery.markDependents:<type>`, no cron runs
`delivery.resumeStale`, or `dependencies.render` is `"events"` without a trigger that runs
`delivery.republishOutput` on `delivery.outputStale` (boot fails in that last case). The jobs on
`delivery.indexesStale` and `delivery.llmsStale` have their own rule,
[delivery-index-triggers](#delivery-index-triggers). Without marking, a published page is re-rendered only
when it is saved itself; a change to the settings, a document it shows or a page it links to leaves its
output stale. The `delivery-static` README ("Dependent outputs") shows the
wiring for both render modes. Outputs rendered before the upgrade have no recorded dependencies and are
re-rendered on every change until they render once; run "Publish all" (`delivery.publishAll`) or
`delivery.checkBuild` once after upgrading to record them all.

#### delivery-export-llms
`delivery.exportLlms` is removed, and a pipeline that still names it fails at boot as an unknown step.
The index files are no longer written inside the request that changed them: `delivery.requestIndexes`
asks for their export, and the export runs later, in the background loop or as a queued job. The fix
renames the step to `delivery.requestIndexes` wherever a page, a settings change or "Publish all" ran
it. In a pipeline on `delivery.llmsStale` it becomes `delivery.exportLlmsFull`, the step that writes
`llms-full.txt`. A file that holds both kinds of pipeline is left to you.

#### delivery-site-url
`delivery-static` takes `siteUrl` at the top level of its config, because llms.txt, sitemap.xml and
robots.txt all use it. `llms.siteUrl` fails at boot. The fix moves the value as written, including an
expression such as `process.env.SITE_URL`. When a top-level `siteUrl` is already set, the fix only
removes `llms.siteUrl`. A value the tool cannot find as a property in the config file, for example
one that comes from a variable or from host-supplied defaults, is left to you. Without `siteUrl` there
is no sitemap.xml, and boot warns about it.

#### delivery-robots-policy
`delivery-static` writes `<prefix>robots.txt` and, with a `siteUrl`, `<prefix>sitemap.xml` (`sitemap`
defaults to `true`), and overwrites a file of either name it finds there; while no page is listed (every
page `noindex`, or nothing published) it removes a `<prefix>sitemap.xml` instead. Both files appear at the
first export: the first `delivery.requestIndexes` (the pipeline that runs `delivery.checkBuild` at boot
ends with it, see the `delivery-static` README) or the first `delivery.resumeStale` run of the `*/5`
recovery cron. A project wired with neither gets them at the first editor save. Without `robots.policy`,
robots.txt is `User-agent: *` and `Disallow: /` unless the process runs with `NODE_ENV=production`, which
Kestrel itself never sets; boot logs a warning naming the choice. The rule reports a `delivery-static`
entry without a policy and changes nothing, so every deployment of one config keeps that default: a
staging instance stays closed to crawlers while production with `NODE_ENV=production` is open. Run
production with `NODE_ENV=production`, or set `robots.policy` by hand: `"allow"` (what a site that served
no robots.txt had), `"disallow"` for a site crawlers must not index, a value read per deployment from an
environment variable, or `robots: false` to keep a robots.txt of your own, which the module then neither
writes nor removes. With `sitemap: false` or without `siteUrl` the module writes no sitemap and
removes only one that still holds what an earlier export of its own wrote, so a sitemap.xml of the
site's own stays, also one uploaded in place of an exported one.
`<prefix>llms.txt` is written on every export and overwrites a file of the site's own; without
`llms.full` only an llms-full.txt that still holds what this version wrote is removed, and one an older version wrote stays
until you delete it.

#### delivery-orphan-removal
Older versions could leave a page's HTML at its old path after a failed render followed by a slug
change, still served. On a database that already held status rows when 6.0 first started, once no
output is marked or rendering, some output is `live`, every published document has a `live` output
and `delivery.checkBuild` has run in that process, `delivery.resumeStale` deletes every `index.<ext>`
file under `prefix` whose extension is one of `formats` (or one a status row recorded) at a path no
status row has, outside `reservedPaths`. The root page `<prefix>index.<ext>` is never deleted. It runs
only inside `delivery.resumeStale`, so it needs the `*/5` recovery cron (`resumeStalePages` in the
`delivery-static` README); a project without that cron never runs it. The first run only records the
paths it found; a run at least `claimTtlSeconds` later deletes those still unowned. Each deleted key is
logged at info level, and the run is recorded in `delivery_state`, so it never repeats on that
database. When more paths look orphaned than status rows own, it deletes nothing, logs a warning and records
the run. Paths at and below a directory under `prefix` that holds a `robots.txt`, `sitemap.xml` or
`llms.txt` are taken for another site and left alone. A new or empty database never
runs it, and it never runs with a `prefix` that does not end in `/`. A failure is logged and tried
again on the next recovery run. List the path of every other site below `prefix` that writes none of
those files (an uploaded tree of pages, a deployment of an older version) and of every hand-placed
`index.html` that no page owns in `reservedPaths`.

#### delivery-restore-check
`delivery.checkBuild` renders every output again after a database restore with an unchanged build
only when it is told about the restore: put `replication.checkRestored` (or `backup.checkRestored`,
when that module backs up the database) directly before it in the pipeline that runs it at boot, for
example `["replication.checkRestored", "delivery.checkBuild", "delivery.requestIndexes"]`. A step in
between that writes `result`, such as `delivery.resumeStale`, replaces the result and drops the
member; the boot check accepts that pipeline. The rule reports a pipeline that runs
`delivery.checkBuild` without such a step directly before it, offering only the step of a module whose
`file` resolves to the `persistence-sqlite` file. No trigger runs that pipeline at boot: the host runs
it once after `start()` with a build id it supplies,
`await kestrel.run("deliveryBuildCheck", { trigger: { kind: "event", name: "boot" }, payload: { build } })`.
Without that run (as in `examples/minimal`) there is no restore detection, no export of the index
files at boot and no orphan removal. In a pipeline without one of them before `delivery.checkBuild`, no step after it may
write `result`: boot rejects it with `optional-read-order`, so steps such as `delivery.resumeStale`,
`delivery.markAll:<type>` or `delivery.readStaleStatus` go into a pipeline of their own there. The step sets `result._databaseRestoredAt`
to the start of the boot that wrote the latest reported restore of the database file, and keeps that
value in later boots; `delivery.checkBuild` handles each value once, also when the restoring boot
stopped before the check. A prepared restore (`replication.prepareRestore`, `backup.restore`) is
reported, and so is backup-blobstore's restore of a missing file under `restoreOnStart`, which brings
back the last `backup.run` copy: on an ephemeral disk with that module, every start renders every
output again. Such a restore also records the orphan removal above as done, so it never runs on a
restored database. replication-sqlite's rebuild of a missing database file under `restoreOnStart`
brings back the latest replica and is no restore here, unless the generation it rebuilds from was
placed with `origin.json` (see
[Replica layout](../packages/replication-sqlite/README.md#replica-layout)): that rebuild is reported as
a restore. After any other rebuild that follows a stop without teardown, pages saved
since the last `replication.sync` keep files the rebuilt rows do not know. A database file copied into
place by hand is not detected either. After either one, run `delivery.markAll` for every delivered
type, or restore through one of those steps. The files of pages created or moved after the backup stay
under `prefix`: no status row owns them, so they are absent from `sitemap.xml` and `llms.txt` and
cannot be unpublished. Remove them by hand; they are the `index.<ext>` keys under `prefix` at paths
that no `delivery.readStatus` row reports.

#### delivery-index-triggers
With `dependencies.render: "events"`, boot fails unless a trigger runs `delivery.exportIndexes` on
`delivery.indexesStale`, and, with `llms.full`, `delivery.exportLlmsFull` on `delivery.llmsStale`. The
fix creates a `refreshIndexes` pipeline and, where needed, a `refreshLlms` pipeline next to the
project's other pipeline files, and adds their event triggers. When a pipeline of that name already
exists and runs the step, the fix only adds the trigger. When it runs something else, the fix is
left to you. A pipeline on `delivery.llmsStale` that still runs `delivery.exportLlms` counts as wired,
because [delivery-export-llms](#delivery-export-llms) renames its step. With `events-queue`, give
`refreshIndexes` a lane of its own and both jobs a `delayMs` window, so the index files never wait
behind a re-render backlog and one export follows a burst of saves (the `delivery-static` README,
"Dependent outputs", shows the wiring).

#### site-routed-slug-unique
A type listed in `site-default`'s `routes` has a public path that is unique per locale, so its slug
field need not be `unique`; a `unique` slug would reject the same slug under two parents without
naming the occupant, and with a `parentField` or a mount setup fails. The fix removes `unique: true`
from the slug field's definition: in `content-default`'s inline config, or in the file and type a
plugin's `contentModel` and `locateModelFields` hooks point at; the index drops at the next boot. A
definition the tool cannot locate as an object literal is left to you. The finding names the
`site/default` module when setup fails for this cause (the error case), so it is not reported a second
time; the warning for a flat route names `content-default` and never hides another setup failure.

#### site-path-wiring
With `routes`, every pipeline that writes a routed type ends that write's atomic group with
`site.indexPath:<type>` and runs `site.announcePaths` right after the group; a pipeline writing the
single type named in `mounts` does the same with `site.indexMounts`. `site.resolve`,
`site.resolveLinks`, `site.attachPaths` and `site.route` on a routed type name its route's `home`
and `slugField` or leave them out. Boot names the pipeline and the missing step; add it by hand.

#### site-path-events
Routed mode needs an `events@1` provider to raise `site.pathsMoved`, and a pipeline on that event
for anything to follow a path change: `["redirects.recordMoves", "redirects.export"]` for automatic
redirects and `["delivery.markMoved"]` for re-rendering static outputs.

#### redirects-requires-persistence
`redirects-default` stores automatic redirects in its own collections and requires `persistence@1`;
configure a persistence module next to it.

#### imports-redirects-impl
`createRedirects` from `kestrel-redirects-default/impl` is async and takes `db` next to `content`,
`blobs` and `logger`, and `Redirects.validate` returns a `Promise<Result>` instead of throwing
synchronously for anything but a malformed rule. Code calling them directly needs `await` and the
new dependency.

#### deps-kestrel-range
A `@michaelthielemann/kestrel*` dependency is not on a 6.x range; `deps/mixed-majors` fires when
some are on 6.x and others are not, and `deps/pre-install` when the 5.x packages are still
installed (source tier only). `deps/kestrel-range` reads and edits `package.json` alone, so it
still runs — and `fix --write` still bumps the range — even when the project itself could not load
at all (a `load/failed` finding alongside it names why); install the bumped range and run `check`
again to see the rest.

The same rule adds `@michaelthielemann/kestrel-cli`, the package the `kestrel` command lives in
from 6.0.0, at the same range. A backend project gets it in `dependencies`, since its `kestrel`
command starts the production server and a production install omits `devDependencies`; a project
a host package's plugin loads gets it in `devDependencies`. An entry in the other block is moved in
the same edit.

#### deps-zod-range
kestrel 6.0.0 depends on `zod` `^4.6.6` and reads a module's `configSchema` through zod 4's own
definitions: its JSON Schema, its variables, its defaults and its secrets. A schema built with zod 3
cannot be read that way, so a project that declares its own modules needs zod 4.6.6 or later; with
`^4.6.6` the install resolves one copy for the project and kestrel. A module whose `configSchema`
holds a node not built with zod 4.6.6 or a later 4.x fails boot with `invalid-config-schema`, naming
that module, the path of the first such node and the zod version it reports. Every node counts, not
only the root: a field, an array element, a union member or a lazy schema taken from another package
and nested in the module's own `z.object()`. That covers a package that depends on zod 3 itself,
and also one that depends on zod 3.25 and imports `zod/v4`: those schemas report zod 4.0.0 and keep
their descriptions, the `"secret"` marks included, in a registry of their own that kestrel does not
read. Such a package needs zod `^4.6.6` and `import { z } from "zod"`. The rule reads `zod` in `dependencies`, `devDependencies` and
`peerDependencies` of the project's `package.json` and of every other `package.json` in the
project outside `node_modules` and `dist`, such as the packages of a workspace, and sets every range
whose lowest release is below 4.6.6, or on another major, to `^4.6.6`; the zod source rules below
rewrite the schemas of the same packages. A range it cannot read as a version (`latest`,
`catalog:`, `workspace:*`, an `npm:` alias) is left alone; with a pnpm catalog, raise `zod` in the
catalog by hand. Like `deps/kestrel-range`, it reads only `package.json` files and runs even when
the project could not load.

#### zod-record-key
zod 4's `z.record` takes the key schema as its first argument. The rule finds a `z.record(value)`
with one argument in every `.ts`/`.mts`/`.js`/`.mjs` file of the project and inserts `z.string()`,
the key zod 3 used, so `z.record(z.number())` becomes `z.record(z.string(), z.number())`. It follows
the local name of the zod import (`import { z as schema } from "zod"`, `import * as schema from
"zod"`); a `record` imported on its own, a `.vue` file and a file that does not parse are not
rewritten, and the project's typecheck reports them.

#### zod-object-default
zod 3's `.default(value)` parsed `value` when the key was absent, so `z.object({ max:
z.number().default(5) }).default({})` produced `{ max: 5 }`. zod 4's `.default()` returns the value
as written, `{}` here; `.prefault()` parses it the way zod 3 did. The rule renames `.default` to
`.prefault` where the argument is an object literal and the schema it is called on starts at
`z.object`, `z.strictObject`, `z.looseObject`, `z.union`, `z.discriminatedUnion` or
`z.intersection`, directly or through a variable declared in the same file
(`const retry = z.object({ … }).strict()` and later `retry.default({})`). It is a warning: an
object default that already spells out every nested value behaves the same either way, and the
rename keeps it that way. A default given as a variable or a function, or on an array or a record,
is not rewritten. It is reported as a manual warning with its line when the object schema declares
nested defaults in the same file, as in `z.object({ perMinute: z.number().default(10), burst:
z.number().default(5) }).default(DEFAULT_LIMITS)` with `DEFAULT_LIMITS = { perMinute: 10 }`, where
zod 4 leaves `burst` undefined; and likewise when an array or record default holds object literals
for objects that declare nested defaults, as in `z.array(z.object({ host: z.string(), port:
z.number().default(25) })).default([{ host: "localhost" }])`, when a function returns such a
literal (`.default(() => [{ host: "localhost" }])`) and when the value is not a literal
(`.default([DEFAULT_SERVER])`). The rule finds nested defaults through the local variables the
schema refers to, at any depth: `z.array(server)` with `const server = z.object({ …, port:
z.number().default(25) })` counts, and so does `http.default(HTTP_DEFAULTS)` where `http` holds a
`retry` object that declares its own defaults. Rename those to `.prefault()` where the value can
leave out a key that has its own default. An object-literal `.default({…})` on a schema the rule
cannot trace, one imported from another file or returned by a function, or one built with
`z.preprocess`, `z.lazy`, `z.pipe`, `z.custom` or through `.pipe()` or `.transform()`, is reported
as a manual warning with its line; rename it by hand when that schema is an object or a union of
objects. An array or record whose element schema the rule cannot trace gets the same warning when
its default holds objects or is not a literal.

#### zod-describe-order
zod 4's object methods `.strict()`, `.passthrough()`, `.strip()`, `.catchall()`, `.extend()`,
`.safeExtend()`, `.merge()`, `.partial()`, `.required()`, `.pick()` and `.omit()` return a copy of
the schema without its description, and so do `.or()`, `.and()`, an enum's `.extract()` and
`.exclude()` and a tuple's `.rest()`. In `z.object({ user: z.string(), pass: z.string()
}).describe("secret").strict()` the `"secret"` mark is lost, and `kestrel describe`, the manifest
and the admin show `pass` in plain text; in `z.string().describe("secret").or(z.literal(false))`
the value shows the same way. The rule moves the `.describe()` after the last of these methods
that follows it: `z.object({ … }).strict().describe("secret")`,
`z.string().or(z.literal(false)).describe("secret")`. A wrapper after those methods
(`.optional()`, `.default()`, `.nullable()`) keeps the description and stays where it is. A schema
held in a variable and given an object method elsewhere, `const smtp = base.describe("secret")` and
later `smtp.strict()`, is not rewritten; keep `.describe()` the last call there by hand.

#### zod-4-schemas
What a module's own config schema may need beyond the rules above. The list is not complete:
zod's [migration guide](https://zod.dev/v4/changelog) lists every change between zod 3 and zod 4.

- Some schemas parse differently without a type error:
  - `z.string().default("x").optional()` and `.partial()` over a key with a `.default()` fill that
    default for an absent key, where zod 3 returned `undefined`.
  - `z.record(z.enum(["a", "b"]), value)` requires every key of the enum, so a config that sets
    only some of them fails boot; `z.partialRecord(z.enum(["a", "b"]), value)` accepts a subset as
    zod 3's record did.
  - `z.string().uuid()` accepts only RFC 9562 UUIDs and refuses an id such as
    `12345678-1234-1234-1234-123456789012`; `z.guid()` accepts any id of that shape as zod 3's
    `.uuid()` did.
  - `.int()` refuses a number above `Number.MAX_SAFE_INTEGER`.
  - `z.number()` refuses `Infinity` and `-Infinity`, which zod 3 accepted, so a config such as
    `cacheTtlMs: Infinity` for "never expire" fails boot with `Invalid input: expected number,
    received Infinity`. Use a large finite number, or accept `null` for that case through
    `.nullable()`.

- Error messages are zod 4's. A missing key reads `Invalid input: expected string, received
  undefined` instead of `Required`, an unknown key `Unrecognized key: "name"` instead of
  `Unrecognized key(s) in object: 'name'`. A test that matches on the text of an
  `invalid config: …` boot error needs the new wording. An enum mismatch still reads
  `Invalid enum value. Expected 'a' | 'b'`, because kestrel writes that line itself.
- Issue codes are zod 4's. A secret path in a boot error reports only the code, which is
  `invalid_value` where zod 3 said `invalid_enum_value` or `invalid_literal`, and `invalid_format`
  where it said `invalid_string`.
- A custom message is passed as a string or as `{ error: … }`, where `error` may be a function of
  the issue. A function as the second argument of `.refine()`, zod 3's way to build the message
  from the value, is ignored by zod 4, and the issue reads `Invalid input`.
- `.strict()` and `.passthrough()` still work and are read as `additionalProperties: false` and
  `true`; `z.strictObject()` and `z.looseObject()` are the zod 4 spellings and are read the same
  way. `.describe("secret")` still marks a value secret, as long as no object method,
  `.or()`, `.and()`, `.extract()`, `.exclude()` or `.rest()` follows it: each returns a schema
  without the mark (see [`zod/describe-order`](#zod-describe-order)).
- `.default()` on a schema with a `transform` takes the transformed output type; `.prefault()`
  takes the input, as zod 3's `.default()` did.

#### scripts-kestrel-binaries
6.0.0 removes the `kestrel-openapi` and `kestrel-upgrade` binaries; both are subcommands of
`kestrel` now. In `package.json` scripts the rule rewrites them automatically:

| Before | After |
|---|---|
| `kestrel-openapi …` | `kestrel openapi …` |
| `kestrel-upgrade …` | `kestrel upgrade …` |
| `npx [-y] @michaelthielemann/kestrel-upgrade@<v> …` | `npx -y @michaelthielemann/kestrel-cli@<v> upgrade …` |
| `pnpm dlx @michaelthielemann/kestrel-upgrade@<v> …` | `pnpm dlx @michaelthielemann/kestrel-cli@<v> upgrade …` |
| `npm exec @michaelthielemann/kestrel-upgrade@<v> [--] …` | `npm exec @michaelthielemann/kestrel-cli@<v> -- upgrade …` |
| `npx [-y] kestrel-upgrade …` | `kestrel upgrade …` (an error) |
| `npx [-y] kestrel …`, `npx [-y] kestrel-cli …` | `kestrel …` (an error) |

The unscoped npm names `kestrel`, `kestrel-cli`, `kestrel-openapi` and `kestrel-upgrade` do not
belong to this project. A runner that installs a missing package on the fly (`npx` or `pnpx` without
`--no`, `npm exec`/`npm x` without `--no`, `pnpm dlx`, `yarn dlx`, `bunx`, with any flags before the name,
or naming the package through `-p`/`--package`) fetches whatever the registry holds under such a
name when the project's own `@michaelthielemann/kestrel-cli` is not installed, and runs it with
access to the project and its `.env`. Every such command is an error; in a script the runner is
dropped, since a script finds the locally installed `kestrel` on its `PATH`; a `-p`/`--package` form
is reported without an edit.

Only a command token is rewritten: at the start of the script, after `&&`, `;` or `|`, after
`node_modules/.bin/`, or behind a runner (`pnpm`, `pnpm exec`, `yarn`) or an environment prefix
(`VAR=value …`, `cross-env …`), which stays in place; a longer word containing the name stays. A script that still runs one of the removed binaries in a form the rule cannot
rewrite, or runs the path of a removed bin file (`…/kestrel-openapi/dist/cli.js`), gets a manual
warning. `kestrel openapi` refuses flags it
does not know, so a rewritten line that passes one gets a warning naming the flag. In other project
files (`Dockerfile*`, `*.service`, `*.yml`/`*.yaml`, `*.sh`, `Makefile`, `Procfile`, `*.json` and
`*.js`/`*.mjs`/`*.ts`, never lockfiles) the rule reports each such line as a warning with its file
and line and the new form, and edits nothing. A line in one of those files or in a Markdown file that
runs an unscoped name through a fetching runner is an error instead, with the safe forms as the
suggestion: `pnpm exec kestrel …`, `npm exec --no -- kestrel …`, `yarn kestrel …` for the installed
command, or `npx -y @michaelthielemann/kestrel-cli@6 …` for the scoped package. A plain mention of a
removed binary in Markdown is not reported.

#### deps-host-outdated
A direct dependency of the project (not one of kestrel's own packages) carries a plugin that is not
built for the running version: it depends on `@michaelthielemann/kestrel-upgrade` but declares no
`kestrel` field in its `package.json`, its `kestrel.engine` range does not include the running
version, or its `kestrel.pluginApi` is below `PLUGIN_API_MIN`. The plugin is never imported. The
finding is an error, so `check` exits 1; `fix --write` and `data` refuse to run (exit 2) and write
nothing, since the built-in rules alone would edit a project they cannot load the way its host
does. Install the dependency's release for the target major first, then run the command again.

`deps/host-refused` names a dependency whose `kestrel` field cannot be used at all: the plugin
path is absolute, leaves the package directory (also through a symlink), is not a `.mjs`/`.js`
file or does not exist, `pluginApi` is not an integer or needs a newer engine, or `engine` is not
of the form `^<major>.<minor>.<patch>`. Nothing of that package runs, and `fix --write` and `data`
refuse to run (exit 2) the same way as for an outdated one.

#### offer-event-queue
See [Switching event delivery to the queue](#5-switching-event-delivery-to-the-queue) above.

#### boot-code
A boot error no rule above claims a finding for; the code and message come straight from `boot()`.

#### not-checked
A module or pipeline `checkBoot()` left unchecked because a problem it depends on, or the sandbox
consent list, made it unsafe to check. Run with `--run-setup <use>` to include it.

#### load
A config, module or pipeline file failed to load; the message is the load error itself, and the
suggestion is "fix the file so it loads, then run check again". A project that only loads through
its host package's plugin gets this finding when the plugin is missing; a host package that is
installed but not built for this version is reported as [`deps/host-outdated`](#deps-host-outdated).

#### sandbox-blobstore-standin
A configured module provides `blobstore@1` but the sandbox neither rewrites its config (unlike
`blobstore-filesystem`) nor lists it as known-safe — a network object store reaches outside the
sandbox by design. Rather than leaving every module requiring `blobstore@1` unchecked, the boot
tier swaps it for a local, filesystem-backed stand-in scoped to the scratch directory, so media,
images, delivery, replication and backup modules still get checked. The real module's own `setup()`
never runs during the check.

#### sandbox-unmatched-entry
A key of the active plugin's `sandbox` table matches no entry of the loaded project's module list,
so it rewrites nothing and the module it was meant for, if configured under another `use` string,
runs outside the sandbox or not at all. A key must be a module-list entry's full `use` string
without a `?`/`#` suffix; a key that carries such a suffix, or a bare module name, never matches.
The finding names the key and the plugin; the plugin's table needs fixing, not the project.

#### plugin-hook-failed
A plugin hook, or a rule's own `check()`, threw instead of returning or resolving; the message names
the plugin and the hook, or the rule's own id. `dataModel()` is the one plugin hook this covers, in
`check`/`fix` and in `data`; a throwing `check()` — a bug in it, or a `needs: "source"` rule reaching
into a project it was never given — is caught the same way in both the source and the project rule
loop, so one broken rule never aborts the run for every other rule. Always manual: the rule's own
code needs fixing, not the project being checked.

#### preview-edit-refused
A boot preview received an edit it could not verify: the edit's own file, or its mapped location in
the throwaway preview copy, resolved outside that copy (even through a symlink), or the preview copy
could not be reloaded after applying every edit. The affected rule's own finding still reports
unverified rather than clean; this finding names the specific path and the reason.

#### data-config-load-failed
`kestrel.config.ts` exists at the project root but threw while loading; the `data` command's
underscore-field counter has no content model to count against, so it reports nothing rather than
guessing. A project with no `kestrel.config.ts` at all is unaffected — the counter simply has nothing
to read. Error severity, unless a detected plugin provides no `dataModel` hook and needs its own
aliases to load the config — then it is a warning naming the plugin, since the config itself is not
the problem.

#### plugin-api
A `plugin.rules` id that collides with a built-in one is a load error, naming the id and the plugin;
that rule is dropped from the merge and the built-in keeps running under the id. A `plugin.sandbox`
key the built-in sandbox table already rewrites is a load error the same way, naming the key and the
plugin; that entry is dropped and the built-in rewrite applies. See "Programmatic
use" below for the full plugin API surface.

## What the tool never does

- Run a module's `setup()` outside the sandbox table without `--run-setup <use>` naming it.
- Prompt without a terminal, or write under `--write` without one unless `--yes` says so.
- Write anything outside `fix --write` (and `--out`/`--save-answers`, when asked) and `migrate`, which
  writes only into the database copy and the blob directory it is given.
- Accept a torn database copy.
- Install, commit, push, or reach the network on its own; it prints `pnpm install` as the next step.

## CI

`--json` prints a report on stdout (progress goes to stderr) with a stable `schema` field; validate
it against your own tooling before trusting the exit code. Exit codes: `0` nothing at or above
`--fail-on` (default `error`), `1` at least one finding, `2` the tool could not run.

## Testing before a 6.0.0 release

`check`/`fix` open the load and boot tiers only once the installed `@michaelthielemann/kestrel`
reports major `6` — a package built from this branch but not yet published still carries its last
released version, so testing against it sees the source tier only. Set
`KESTREL_UPGRADE_FORCE_MAJOR=6` in the environment to make that check treat the installed major as
`6` regardless of what `package.json` says, opening every tier the same way a real 6.0.0 install
would. This is an environment escape hatch for `kestrel upgrade` when testing a not-yet-published
build, never part of the plugin API: `RunUpgradeCliOptions`, `UpgradePlugin` and `Rule` are
unaffected, and a caller of `runUpgradeCli` should rely on its project's real installed version
instead of setting this.

## Programmatic use

The sandbox helper composes with `checkBoot()` directly — see `docs/configuration.md` § Checking a
boot without starting it, which also lists every boot error code. `@michaelthielemann/kestrel-upgrade/plugin`
exports the plugin API (`UpgradePlugin`, `Rule`, `RuleContext`, `runUpgradeCli`,
`createRuleContext`, `KestrelPluginFactory`, `PLUGIN_API_VERSION`, `PLUGIN_API_MIN`) a host package
registers its own project loader and rules through, instead of shipping a second copy of the
check-and-fix engine; `runUpgradeCli` also takes a `prompt` and `isInteractive` override for a
caller with its own UI.

### Registering a plugin

A host package registers its plugin with a `kestrel` field in its own `package.json`:

```json
"kestrel": { "plugin": "./cli/plugin.mjs", "pluginApi": 4, "engine": "^6.0.0" }
```

- `plugin` — a `.mjs` or `.js` file inside the package. Node does not strip types under
  `node_modules`, so a TypeScript host ships a small JavaScript entry that loads the rest. Its default
  export is a `KestrelPluginFactory`: `(host) => UpgradePlugin | Promise<UpgradePlugin>`, where
  `host` is `{ pluginApiVersion, cliVersion }` of the running CLI.
- `pluginApi` — the lowest `PLUGIN_API_VERSION` the plugin needs.
- `engine` — the kestrel-cli versions the plugin is built for, of the form
  `^<major>.<minor>.<patch>` and nothing else. kestrel-cli shares `@michaelthielemann/kestrel`'s
  version, so a host derives this from its own `@michaelthielemann/kestrel` range.

The kestrel CLI reads the field from the project's direct `dependencies` and `devDependencies`
only (never a transitive dependency, a global install or a path flag), resolved from the project
root, and checks it as data before importing anything:

- The package is refused, and every command except `start` stops with exit 2 naming it, when
  `plugin` is absolute, leaves the package directory (also through a symlink), is not a `.mjs`/`.js`
  file or does not exist, when `pluginApi` is not an integer or is higher than the engine's
  `PLUGIN_API_VERSION`, or when `engine` is malformed.
- The package is outdated, reported as [`deps/host-outdated`](#deps-host-outdated) and never
  imported, when the running version is outside `engine`, when `pluginApi` is below
  `PLUGIN_API_MIN`, or when it depends on `@michaelthielemann/kestrel-upgrade` without declaring the
  field.
- Otherwise the entry is imported and its factory called. A factory or a `detect` that throws, or a
  result that is not a plugin, is a refusal naming the package. More than one plugin whose `detect`
  accepts the project is an error naming every one of them; there is no first match.

`--no-plugins` loads no plugin and uses the built-in loader; an outdated or refused host package is
still reported and still blocks `fix --write` and `data`. A plugin runs with the user's privileges
like any other code of the packages the project installed; the rules above limit it to direct
dependencies and make a second plugin taking over a project an error instead of a silent choice.
Its factory and `detect` run with a scratch copy of the project (`check`, `explain`, `manifest`,
`openapi`) or the project root (`upgrade`) as the working directory.

A plugin compares `host.pluginApiVersion`, the running engine's number, never the
`PLUGIN_API_VERSION` it imports from its own copy of this package: a project can hold two copies,
the CLI's engine and the one the host package depends on for `./codemods`.

### The plugin API

A caller of `runUpgradeCli(argv, { plugins })` passes the plugins itself; the kestrel CLI passes the
one it discovered. For a given `root`, the first plugin whose `detect(root)` returns `true` becomes
the active one for that run; none matching falls back to the built-in backend loader
(`kestrel.config.ts`, module list, pipelines directory) with only the built-in rules. The engine also
classifies the project's direct dependencies on its own (`RunUpgradeCliOptions.hosts` passes a
result the caller already has), so a direct caller gets the `deps/host-outdated` findings too; that
classification never imports a plugin.

- `kind: string` — the plugin's own project kind, shown as `report.project.kind`.
- `detect(root): boolean | Promise<boolean>` — whether this plugin owns the project at `root`.
- `load(root, scratch, cache): Promise<LoadResult>` — loads the project into `scratch`, a fresh,
  uniquely-named directory this call alone ever sees. This runs unconditionally, before any consent
  question is asked: importing `kestrel.config.ts` (or a plugin's own equivalent) and any prepare
  step a plugin's own loading performs is project code the tool executes just by being pointed at a
  project, the same way the source-tier-only `check` in step 1 never does but every later one does.
  `--run-setup <use>` and its consent list govern a module's own `setup()` only, at the later boot
  tier — never whether `load()` itself runs. `LoadResult` is `{ project?, issues }`, the same shape
  the built-in loader itself returns: one bad file becomes an `issues` entry (surfacing as a
  `load/failed` finding) without stopping the rest of the load; `project` is absent only when nothing
  could be loaded at all. `load()` runs again, with a new `scratch`, for every re-ask round and every
  edit preview within one `check`/`fix` invocation, and again for each project a host processing
  several in one process loads — a loader with its own module cache keyed by a fixed path (one that
  does not vary with `scratch`) must make that cache fresh per call or disable it, or a later call can
  silently answer from an earlier project's or an earlier preview's cached module. `cache` is one
  plain `Map`, shared by every `load()` call for this one invocation only (never across two different
  projects, or two separate invocations): a plugin whose own loading runs something as expensive as a
  build tool's own prepare step can stash the result there and skip repeating it for the same
  project's later scratch copies — but only a path-independent value (a parsed config object, a
  computed flag); a cached path or handle into `scratch` itself must be rebased on every call, or a
  later round silently reads through a directory an earlier round's cleanup already removed.
  `LoadedProject.data` is the plugin's own, in whatever shape it likes — `check`/`fix` never reads or
  writes it, and `--data-report`'s parsed content lands in the separate `LoadedProject.dataReport`
  instead, so a data report never overwrites what `load()` stored. `LoadedProject.pipelineFiles` is a
  list of `{ file, pipelines }` — more than one pipeline name per entry for a layout that keeps
  several in one file — instead of one file per pipeline name, so a rule that walks every pipeline
  file reports at most once per file even then.
- `sandbox?: Record<string, (config, scratch) => unknown>` — extra sandbox config rewrites, added to
  the built-in table. A key is a module-list entry's full `use` string without a `?`/`#` suffix: a
  package name in any scope (`"@acme/kestrel-archive"`), or a local path exactly as the config writes
  it. The rewrite receives the entry's config and the scratch directory and returns the config that
  module's `setup()` gets during the boot tier, which then counts it as sandboxed. A key the built-in
  table already rewrites (kestrel's SQLite, blob store, backup, migrations and JSON Schema modules) is a
  load error naming the plugin and the key; the built-in rewrite stays in force. A key that matches no
  module-list entry is a `sandbox/unmatched-entry` warning naming the key.
- `rules?: readonly Rule[]` — extra rules, run alongside every built-in one. An id that collides with
  a built-in one is a load error naming both, and that rule is dropped from the merge; reach for a
  locator or hook (`locateSteps`, `locateModelFields`, `dataModel`, `switchEdits`) when a built-in
  rule only needs a different project layout, so a later fix to the built-in rule's own logic still
  reaches every project. A rule's `check(ctx)` gets the full `RuleContext` (a loaded project, its boot
  check, both preview forms) and runs only once the project loaded, unless it declares
  `needs: "source"`: such a rule gets the smaller `SourceRuleContext` instead (`root`, `scratch`,
  `readFile`, `answers` — no project, boot check or preview) and runs whether or not the project
  loaded this round, so it still finds and fixes what never depended on that — a dependency range in
  `package.json`, say, the way the built-in `deps/kestrel-range` does. Declare `needs: "source"` only
  for a rule that genuinely reads and edits files by their own path; one that reaches into
  `ctx.project` has nothing to read when the project itself failed to load.
- `locateSteps?`, `locateModelFields?` — locate a pipeline's step array(s) or a content type's fields
  object literal directly, for a project layout where a pipeline is not a
  `definePipeline({ name, steps })` call or a content type does not sit at
  `config.types.<typeName>.fields` on a module-list entry (for example, either living inside another
  call's options object). `RuleContext` carries the active plugin's own locators through, and
  `pipelines/verified-user` / `model/underscore-field` pass them to the codemod instead of only ever
  searching the built-in shape. Additive, not a replacement: absent, or returning nothing for the
  pipeline or type at hand (an empty array from `locateSteps`, `undefined` from `locateModelFields`),
  the exact built-in search runs for that target instead — a plugin's locator only needs to answer for
  the layouts it actually recognizes.
- `dataModel?(root): Promise<DataContentModel | undefined>` — supplies the content model the `data`
  command's underscore-field counter needs (`types`, each with a `fields` map of `{ localized? }`,
  plus optional `locales`, `defaultLocale`, `routes`, `mounts`, `use` and `file`; `routes` names the
  types whose paths come from a slug per locale, with `slugField`, `liveWhen`, `parentField` and
  `mount`, and `mounts` where the pages of mounted types are assigned, for `data/translation-slug`), for
  a project layout where it cannot be read from a
  `content-default` module's config on `kestrel.config.ts`. Consulted through the same `detect()` used
  for `check`/`fix`; `undefined`, from the hook or its result, skips underscore-field counting for
  this project without failing the rest of the `data` command, which stays SQLite-only either way.
  `check`/`fix` also derives `LoadedProject.contentModel` from this hook when `load()` did not set it
  directly, so `model/underscore-field` (including its orphaned-column warning) reads the same model a
  plugin need only describe once, whichever of the two it implements. `DataContentModel.file` is the
  file `model/underscore-field` reads and splices a verified-zero-count rename into; `LoadedProject.configFile`
  is used when absent, so a plugin whose content model does not live there (unlike the built-in
  `content-default`-on-`kestrel.config.ts` layout) still gets an automatic rename, not a manual one.
- `dataFindings?(db, root, model): Promise<readonly Finding[]>` — findings the `data` command adds for
  what the host package itself stores, a value shape its own fields write for example. `db` reads the
  verified copy through the project's own `persistence-sqlite`; declare a collection's columns with
  `ensureCollection` before querying it, and only read. `model` is what `dataModel` supplied, or
  `undefined`. A throw becomes a `plugin/hook-failed` finding and the rest of the `data` report still
  comes out. Available from plugin API `5`.
- `switchEdits?(ctx, relayPipelines): Promise<{ parts, blockers }>` — supplies `offer/event-queue`'s
  switch for a project layout where events-direct is not a `kestrel.config.ts` module-list entry:
  `parts` is the switch's edits as the same all-or-nothing `Record<label, Edit[] | undefined>` shape
  `combineEditParts` takes, and `blockers` names deployment markers that forbid the switch outright (a
  build setting that deploys the server as short-lived functions, say), the same role the built-in SERVERLESS_MARKERS
  check plays for a CLI/server backend project. The built-in rule keeps every gate (an open
  event-payload or emits finding, the serverless markers, no default when unverified) and only asks
  this hook for the edits and the extra markers, adding them to its own rather than replacing them;
  absent, the built-in kestrel.config.ts-shaped switch runs unchanged. Whichever edits end up in play,
  one boot preview of the full set is the one authority on whether the switch actually happened — with
  or without a plugin: the offer blocks unless the booted module list shows events-queue and not
  events-direct, naming this hook when it supplied the edits. A literal `"...events-direct"` string (any
  quote style, found by walking the parsed AST so a comment or a partial match never counts) decides
  nothing on its own; it only improves the blocker's message, naming the file and site to edit, so a
  module list built by a helper function or an imported constant is checked exactly the same way.
- `idempotentPipelines?(project): readonly string[]` — names pipelines this plugin already knows are
  safe to run more than once for the same event (its own preset's, audited and documented elsewhere,
  say). `offer/event-queue`'s own `idempotent:<pipeline>` question, gating the queue switch on a "yes"
  per consumer event pipeline, skips every name this hook lists, treating it as already answered "yes"
  without one in `--answers`; absent, every consumer event pipeline is asked about, unchanged. A
  project's own pipelines still get their own question — this only covers what the active plugin's own
  layout already vouches for.
- `mediaWiring?(project): MediaWiring | undefined` — supplies the host layer's own media wiring
  (`publicPath`, `copyPrefix`, and delivery-static's `reservedPaths`) for `modules/delivery-media`:
  with it, the rule compares each of delivery-static, media-default and images-default against these
  values directly and produces one auto-fixing finding per module entry that does not already match,
  instead of the single manual finding it falls back to when it cannot tell where a project mounts its
  own routes. Absent, or when it returns `undefined`, the built-in heuristic runs unchanged.
- `hostChecks?(project, bootCheck): readonly HostProblem[] | Promise<…>` — the checks the host's own
  server start runs beyond `boot()`, given the loaded project and its boot check. `kestrel check`
  lists what it returns (`code`, `severity` `error` or `warning`, `owner`, `reason`, optionally
  `pipeline`, `module`, `file`) next to the boot problems; an `error` fails the check. The upgrade
  commands do not call it.
- `ops?(root): OpsFacts | undefined | Promise<…>` — what the operations tooling (backup, restore,
  update) needs about a project it cannot read from a `kestrel.config.ts`: `readyPath` (the path that
  answers 200 once a started instance serves requests), `localBootEnv` (variables without secrets for
  a local start of the project), `exportChecks` (paths inside the static export that must exist once
  the project has rendered again), `blobstoreFromEnv(env)` and `databaseFile(env)` (the blob store
  entry and the database file the project builds from an environment passed as a plain map, never
  `process.env`), `secretEnvNames` (variables the tooling never prints, logs or puts on a command line)
  and `migrationSwitches` (the variables that switch content and storage migrations at start-up).
  Every member is optional. The upgrade commands do not call it. Available from plugin API `6`.

A `Rule` answers one of its own `ask` questions the same way every other finding changes: through
`ctx.answers` on the next `check()` call — there is no separate answer-to-edit path a plugin's rule
implements. `AskFix.closedChoices: true` marks `choices` as the complete, exhaustive set of valid
answers; only then is an answer checked against it before it reaches a rule — a question whose
`choices` are only a default or example (a comma list, a free-form name, a literal path) is never
validated, since the rule parses the raw answer itself. A rejected answer from `--answers` exits `fix`
with 2, naming the id and the value, the same as an unknown id, on every `fix` run (`--write` or not);
a rejected TTY answer is asked again instead.

`RuleContext` (passed to every `Rule.check()`) additionally carries `locateSteps`, `locateModelFields`
and `switchEdits` from the active plugin, and two forms of boot verification. `previewBoot(edits)` is
the low-level form: it applies the given edits to a scratch copy, reloads the project (through the
active plugin's own `load()`, or the built-in loader) and runs `checkBoot()` on it, returning the raw
`BootCheck` or `undefined` when the boot tier is not available, an edit's target could not be verified
this way (see `preview-edit-refused` above), or the reload itself failed — the mechanism `fix` itself
uses to report what remains after writing. A package a switch's own edits add but that is not
installed yet is not a refusal: the preview genuinely reloaded, so it stays on its own "install it"
line, never a `preview-edit-refused` finding. Repeated preview calls for the identical edit set within
one `check`/`fix` round may reuse the first boot instead of reloading again. `verifyEdits(edits, {
pipelines })` is the higher-level form built on it: it diffs the preview's errors against this run's own
baseline and folds in whether every name in `pipelines` was actually checked, answering `{ verified,
newErrors, unchecked }` — `verified` only when the preview booted and none of `pipelines` is in the
result's `notChecked`, so a rule that only diffed errors cannot mistake an unchecked pipeline for a
clean one. `offer/event-queue` verifies its own switch this way.

`createRuleContext(project, overrides?)` builds that `RuleContext` for a plugin's own rule tests,
without running the CLI: `root` and `scratch` default to the directory of `project.configFile`,
`bootCheck` to a check with no problems, `readFile` to reading from disk and `answers` to none;
`overrides` replaces any of them. A member `RuleContext` gains later gets its default there, so a
test built on it keeps compiling.

`PLUGIN_API_VERSION` is the version of this plugin API, `6` as 6.0.0 ships it. It covers every type
`./plugin` exports, the ones a plugin returns to the engine as much as the ones it receives:
`UpgradePlugin`, `LoadResult`, `LoadedProject`, `LoadIssue`, `PipelineFile`, `DataContentModel` and
its parts, `SwitchEditsResult`, `Rule` with its `needs` values, `RuleContext`/`SourceRuleContext`, the
locator types, `Finding`/`Edit`, `KestrelPluginHost`, `HostProblem`, `OpsFacts` with its parts,
`KestrelPluginFactory` and `RunUpgradeCliOptions`. A member added to any of them later is an optional one, and a new `needs`
value is a new variant of `Rule`; each such addition raises the number by one. An engine older than
an addition ignores a hook or member it does not know, so a plugin that relies on one compares
`host.pluginApiVersion` first and reports the engine as too old instead. The number only grows: a
new major of this package continues from the previous major's value and never resets it.
`PLUGIN_API_MIN`, `4` in 6.0.0, is the lowest `pluginApi` the engine still runs; a major that removes
an API member raises it.

`@michaelthielemann/kestrel-upgrade/codemods` exports the primitives a plugin's own `Rule` or locator
writes edits with, so it never needs a second copy of this engine's own edit machinery:

- `applyEdits(source, edits)` — the edit primitive: splices non-overlapping edits into `source` in one
  pass; an edit that fully contains an already-accepted one takes its place, any other overlap drops
  the later-processed edit.
- `verifiesAfterEdit(file, text)` — the verify primitive: whether `text` (a file's content after
  applying edits) is still syntactically sound — valid JSON for a `.json` file, otherwise a TS/JS
  source with no array hole an edit can leave behind. An edit that fails this never gets written.
- `combineEditParts(parts)` — the all-or-nothing combine primitive: `Record<label, Edit[] | undefined>`
  becomes one accepted set, or none at all (`missing` naming every part that could not be located) —
  a multi-part edit (a module-list entry plus a `package.json` range, say) is never applied halfway.
- `replaceModuleListEntry(file, source, { use, newUse, config? })` — replaces a `kestrel.config.ts`-shaped
  module-list entry named `use` with a new `{ use: newUse, config }` literal; `undefined` when the array
  or the entry cannot be found. The primitive `switchEdits`'s own built-in fallback is written with, for
  a plugin whose project layout keeps a hand-written module list of the same shape.
- `parseTs`, `walk`, `findAll`, `findCalls`, `firstArgument`, `objectProperty`, `objectPropertyNodes`,
  `propertyKeyName`, `propertyKeyNode`, `isAstNode`, `isArrayExpression`, `arrayElements`, `span`,
  `stringValue`, and the `AstNode` type — the AST reading primitives `locateSteps` and
  `locateModelFields` are written with; a babel AST node read generically (`type`, `start`, `end`),
  never depending on a more specific shape.
