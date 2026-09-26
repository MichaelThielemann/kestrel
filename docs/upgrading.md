# Upgrading: 5.x -> 6.0.0

`@michaelthielemann/kestrel-upgrade` finds the 6.0.0 breaks a 5.8 project meets, previews a fix for
the ones it can edit mechanically, asks about the ones only a person can decide, and reads a
database copy for the checks only stored data can answer. It never installs, commits, pushes or
reaches the network on its own.

## 1. See what breaks

With the 5.x packages still installed:

```
pnpm dlx @michaelthielemann/kestrel-upgrade@6 check
```

At this point the tool sees the **source tier** only — it reads `kestrel.config.ts`, every pipeline
file, every local module file and `package.json` as text, without importing the 6.0 packages.
Every finding the tool did not name explicitly but the checker underneath still catches shows up as
`boot/<code>`, so a break nobody wrote a rule for is still listed.

## 2. Bump and install

```
pnpm dlx @michaelthielemann/kestrel-upgrade@6 fix --write
pnpm install
```

`fix` without `--write` only previews: it shows a unified diff of every file it would change and
never touches the project. `--write` on a terminal shows the same diff per file and asks `y` (write
it), `n` (skip it) or `d` (show the diff again); without a terminal it needs `--yes` or is refused
(exit 2) rather than write silently. It refuses a file with uncommitted changes unless
`--allow-dirty` is also given, so `git diff` shows exactly the tool's edits and `git checkout`
reverts them. When an applied edit brings up a new finding (a question that only makes sense once the
first edit is in, say), `--write` checks again and applies it in the same run, for at most five passes;
a finding already handled in an earlier pass is not applied again. The tool never runs `pnpm install`
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
kestrel-upgrade data --db <a copy of the database> --root <project>
```

The tool copies the given file (and any `-wal`/`-shm` siblings) into its own temp directory and
never opens the path it was given again. It verifies the copy with `PRAGMA quick_check` before
reading anything else — the only SQL it issues itself; a copy that fails this, or does not open, is
refused (exit 2) rather than read, since a plain file copy of a live database can be torn. It then
reads the verified copy through the project's own installed `persistence-sqlite`, so the collection
layout stays that module's knowledge, and reports stored `events_queue` rows not yet fanned out to a
pipeline or a dead-letter row with no pipeline assigned. Take a consistent snapshot close to
cutover (a replication snapshot, or `sqlite3 <db> ".backup <copy>"`).

## Cutover

Switching an already-running project's event delivery to `events-queue`, or draining it before a
later switch back, moves stored events through the queue rather than losing them. The order is:
stop writes, drain, stop the 5.8 process, deploy 6.0.

1. Take a consistent snapshot of the database close to the moment of cutover (a replication
   snapshot, or `sqlite3 <db> ".backup <copy>"` while the process keeps running).
2. Run `kestrel-upgrade data --db <copy> --root <project>` against it. `data/queue-unfanned` names
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

| Rule id | Tier | Fix | What it checks |
|---|---|---|---|
| [`modules/event-delivery`](#modules-event-delivery) | load | auto | `events-inmemory` with no delivery module next to it |
| [`modules/event-bus`](#modules-event-bus) | load | auto | `events-queue` with no `events-inmemory` next to it |
| [`steps/removed`](#steps-removed) | source | auto | a string-literal reference to a removed step |
| [`pipelines/verified-user`](#pipelines-verified-user) | load | auto / ask / manual | `revisions.reassignAuthor` with no verify step ahead of it |
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
| [`types/breaking-signatures`](#types-breaking-signatures) | source | none (info), always | type-level members a hand-built implementation must add |
| [`responses/breaking-step-shapes`](#responses-breaking-step-shapes) | source | none (info) | a pipeline running a step whose response or manifest shape changed |
| [`responses/binary-cache-control`](#responses-binary-cache-control) | source | none (info) | a local module mentioning `cache-control` near a binary step result |
| [`pipelines/images-plan`](#pipelines-images-plan) | source | manual (warning) | a pipeline calling `images.plan` directly |
| [`data/media-layout`](#data-media-layout) | data | none (error) | a stored `media_items` key off-layout, or a pre-6.0 `images_variants`/`images_retired` row with no `slot` |
| [`data/site-media-leftovers`](#data-site-media-leftovers) | data | manual (warning) | a leftover 5.x static export copy `media.syncPublic` never touches |
| [`data/blobstore-tmp-suffix`](#data-blobstore-tmp-suffix) | data | none (info) | a stored filesystem-blobstore key already ending in `.kestrel-tmp` |
| [`steps/ctx-done-terminal-output`](#steps-ctx-done-terminal-output) | source | none (info) | a local module calling `ctx.done()` |
| [`tests/run-pipeline-validates`](#tests-run-pipeline-validates) | source | none (info) | a file importing `testing/runPipeline` |
| [`boot/dependency-cycle`](#boot-dependency-cycle) | boot | manual | a module dependency cycle |
| [`runtime/restore-freshness`](#runtime-restore-freshness) | load | none (info) | `restoreOnStart` left on for `replication-sqlite`/`backup-blobstore` |
| [`delivery/dependents`](#delivery-dependents) | source | none (info) | `delivery-static` publishing on events without marking dependent outputs |
| [`site/routed-slug-unique`](#site-routed-slug-unique) | load | auto (error / warning) | a `unique` slug field on a type in `site-default`'s `routes` |
| [`site/path-wiring`](#site-path-wiring) | boot | manual | a routed write without `site.indexPath`/`site.announcePaths`, or a read with another `home`/`slugField` |
| [`site/path-events`](#site-path-events) | load | manual (error / warning) | `routes` without an `events@1` provider, or without a pipeline on `site.pathsMoved` |
| [`redirects/requires-persistence`](#redirects-requires-persistence) | load | manual | `redirects-default` without a `persistence@1` provider |
| [`imports/redirects-impl`](#imports-redirects-impl) | load | none (info) | a local module importing `kestrel-redirects-default/impl` |
| [`deps/kestrel-range`](#deps-kestrel-range), `deps/mixed-majors`, `deps/pre-install` | source | auto / manual / none | a `@michaelthielemann/kestrel*` dependency range |
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
- No data report at all — the rule asks, with no default, and points at `kestrel-upgrade data`.
- An explicit rename answer given without a data report proving the field empty is still applied,
  naming the old column and how to check it. Nothing remembers this across runs by itself: on a
  later `check`/`fix` run given `--data-report <report>.json`, the rule probes the *new* field name's
  own old, underscore-prefixed column directly against that report's raw counts, so it warns again as
  long as the old column still holds data — even though the field itself no longer starts with `_` —
  but a run given no `--data-report` at all stays silent about it, the same as any other data-report
  question. Run `kestrel-upgrade data` again and pass its report to confirm the old column is empty.

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
with it, `delivery.exportLlms` writes `_llms` instead of `llms`, and a missing id is `400` instead
of `500`.

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

#### modules-references-media-target
A `references-default` target `{ collection: "media_items" }` reads `media-default`'s collection
directly. With `media-default` configured, the fix sets the target to `{ media: true }`, which reads
the ready files through `media@1`: an upload still in flight or a file being deleted then counts as a
dangling reference instead of an existing one. A target on any other collection gets an info
finding: `{ collection }` is meant for a collection the project owns itself, and data another module
owns is read through that module's contract.

#### events-images-variants-changed
`images-default` announces that an item's variants changed — it placed the item, a size was added or
changed, a size was pruned — as its own event `images.variantsChanged` (`{ id: null, ids,
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
`media.removeFolder`: a render finishing in the gap between the two can leave a public copy or a
private blob behind. Auto-swaps the two steps' own text in place when the pipeline's file can be
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
fields, and the variant fields behind `images.attach`; the file headers `cache-control`,
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
`images.attach` `available`, `variantCounts` and each variant's `bytes` and `state` of a media item;
any header of a file the grant does not name. Signed-in callers whose roles have no field grant keep
the whole answer.

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

#### types-breaking-signatures
`Deps`, `Introspection`, `PipelineDefinition["steps"]`, `ModuleManifest`, `FakePersistence`,
`Manifest`, `Kestrel["contracts"]`, `Media` and `Images` all gained required members or new ones
worth knowing about — among them `createImages`'s required `deps.media`, `Media` extending
`MediaFiles` and `MediaStatus`'s `removing`; only the consumer's own typecheck sees a violation in a hand-built
implementation of one of them.

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

#### data-media-layout
The `data` command's own SQL check: a `media_items` row whose key is not `<prefix><id>/<name>` makes
setup stop in 6.0.0 (start with an empty media store instead); a pre-6.0.0 `images_variants` or
`images_retired` row with no `slot` is invisible to the new `ownerOf` lookup — Node 404s it and a
sync treats its copy as foreign — and setup requires both collections empty. Error, no fix: the
project's own data determines whether this is even reachable.

#### data-site-media-leftovers
A file under the filesystem blobstore's own root (resolved from its `root` config, relative to the
project root) that looks like a 5.x static export copy — `<folder>/<filename>` or
`….<size>.<ext>` directly under the delivery prefix and the old `media.target` — that
`media.syncPublic` never reaches, since it only ever considers depth-1 copies under the *new*
public-copy tree. Manual: lists what it found and says to delete it once every page that might
still link it has been republished.

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

#### delivery-dependents
`delivery-static` publishes on events, but no pipeline runs `delivery.markDependents:<type>`, no cron runs
`delivery.resumeStale`, or `dependencies.render` is `"events"` without a trigger that runs
`delivery.republishOutput` on `delivery.outputStale` (boot fails in that last case). Without marking, a
published page is re-rendered only when it is saved itself; a change to the settings, a document it shows or
a page it links to leaves its output stale. The `delivery-static` README ("Dependent outputs") shows the
wiring for both render modes. Outputs rendered before the upgrade have no recorded dependencies and are
re-rendered on every change until they render once; run "Publish all" (`delivery.publishAll`) or
`delivery.checkBuild` once after upgrading to record them all.

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

#### offer-event-queue
See [Switching event delivery to the queue](#5-switching-event-delivery-to-the-queue) above.

#### boot-code
A boot error no rule above claims a finding for; the code and message come straight from `boot()`.

#### not-checked
A module or pipeline `checkBoot()` left unchecked because a problem it depends on, or the sandbox
consent list, made it unsafe to check. Run with `--run-setup <use>` to include it.

#### load
A config, module or pipeline file failed to load; the message is the load error itself. Without a
plugin registered, the suggestion is "fix the file so it loads, then run check again" — unless a
project dependency's own `package.json` both declares a `bin` and depends on
`@michaelthielemann/kestrel-upgrade` itself: that dependency ships its own upgrade command, running
this package's own rules against a project shape only it can load, so the suggestion names that
command instead. A plugin already registered keeps the generic suggestion, since it is the one
already trying to load the project this way.

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
- Write anything outside `fix --write` (and `--out`/`--save-answers`, when asked).
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
would. This is a CLI/environment escape hatch for testing a not-yet-published build, never part of
the plugin API: `RunUpgradeCliOptions`, `UpgradePlugin` and `Rule` are unaffected, and a host
embedding `runUpgradeCli` should rely on its own project's real installed version instead of setting
this.

## Programmatic use

The sandbox helper composes with `checkBoot()` directly — see `docs/configuration.md` § Checking a
boot without starting it, which also lists every boot error code. `@michaelthielemann/kestrel-upgrade/plugin`
exports the plugin API (`UpgradePlugin`, `Rule`, `RuleContext`, `runUpgradeCli`,
`createRuleContext`, `PLUGIN_API_VERSION`) a host CLI registers
its own project loader and rules through, instead of shipping a second copy of the check-and-fix
engine; `runUpgradeCli` also takes a `prompt` and `isInteractive` override for a host with its own UI.

### The plugin API

A host registers one or more `UpgradePlugin`s through `runUpgradeCli(argv, { plugins })`. For a given
`root`, the first plugin whose `detect(root)` returns `true` becomes the active one for that run;
none matching falls back to the built-in backend loader (`kestrel.config.ts`, module list, pipelines
directory) with only the built-in rules.

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
  plus optional `locales`, `use` and `file`), for a project layout where it cannot be read from a
  `content-default` module's config on `kestrel.config.ts`. Consulted through the same `detect()` used
  for `check`/`fix`; `undefined`, from the hook or its result, skips underscore-field counting for
  this project without failing the rest of the `data` command, which stays SQLite-only either way.
  `check`/`fix` also derives `LoadedProject.contentModel` from this hook when `load()` did not set it
  directly, so `model/underscore-field` (including its orphaned-column warning) reads the same model a
  plugin need only describe once, whichever of the two it implements. `DataContentModel.file` is the
  file `model/underscore-field` reads and splices a verified-zero-count rename into; `LoadedProject.configFile`
  is used when absent, so a plugin whose content model does not live there (unlike the built-in
  `content-default`-on-`kestrel.config.ts` layout) still gets an automatic rename, not a manual one.
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

`PLUGIN_API_VERSION` is the version of this plugin API, `1` as 6.0.0 ships it. It covers every type
`./plugin` exports, the ones a plugin returns to the engine as much as the ones it receives:
`UpgradePlugin`, `LoadResult`, `LoadedProject`, `LoadIssue`, `PipelineFile`, `DataContentModel` and
its parts, `SwitchEditsResult`, `Rule` with its `needs` values, `RuleContext`/`SourceRuleContext`, the
locator types, `Finding`/`Edit` and `RunUpgradeCliOptions`. A member added to any of them later is an
optional one, and a new `needs` value is a new variant of `Rule`; each such addition raises the
number by one. An engine older than an addition ignores a hook or member it does not know, so a
plugin that relies on one compares `PLUGIN_API_VERSION` first and reports the engine as too old
instead. The number only grows: a new major of this package continues from the previous major's
value and never resets it.

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
