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
reverts them. The tool never runs `pnpm install` itself.

## 3. Full check

After installing the 6.0.0 packages, running `check` again also loads the config, every module and
every pipeline, and boots the instance in a scratch copy of the project — never the project itself
— to run the same checks `boot()` runs. A module the tool does not know is safe to run `setup()`
against (anything beyond kestrel's own storage modules) does not run unless named with
`--run-setup <use>`; its pipelines are then reported as not checked instead of run against a real
config.

## 4. Answering questions

A finding whose fix needs a person's decision carries a question. `fix` on a terminal asks each one
in turn, with its default shown; pressing enter takes the default. Without a terminal it never
prompts: pass `--answers <file>` (a JSON object of `{ "<question id>": "<answer>" }`) to supply
them, or `--yes` to take every default — a question with no safe default (whether an output
property is always present, for one) stays open under `--yes` either way. `--answers` naming an id
this run never asked is refused (exit 2). `--save-answers <file>` writes down what was answered
interactively, to replay with `--answers` next time.

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
| [`model/underscore-field`](#model-underscore-field) | load | ask | a content field name starting with `_` |
| [`responses/delivery-members`](#responses-delivery-members) | load | none (info) | an HTTP pipeline running a delivery step |
| [`runtime/bus-handler-throws`](#runtime-bus-handler-throws) | source | none (info) | a local `events.on` subscriber under `events-direct` |
| [`runtime/bus-subscriber-queue`](#runtime-bus-subscriber-queue) | source | none (info) | a local `events.on` subscriber under `events-queue` |
| [`data/queue-unfanned`](#cutover), [`data/queue-dead-unassigned`](#cutover) | data | none (warning / info) | stored queue rows the `data` command finds |
| [`steps/closed-event-input`](#steps-closed-event-input) | source | manual | an event-triggered pipeline's step closes its input schema |
| [`modules/emits`](#modules-emits) | source | ask | a local module's heuristic `.emit(` calls, undeclared in `emits` |
| [`types/breaking-signatures`](#types-breaking-signatures) | source | none (info), always | type-level members a hand-built implementation must add |
| [`responses/breaking-step-shapes`](#responses-breaking-step-shapes) | source | none (info) | a pipeline running a step whose response or manifest shape changed |
| [`steps/ctx-done-terminal-output`](#steps-ctx-done-terminal-output) | source | none (info) | a local module calling `ctx.done()` |
| [`tests/run-pipeline-validates`](#tests-run-pipeline-validates) | source | none (info) | a file importing `testing/runPipeline` |
| [`boot/dependency-cycle`](#boot-dependency-cycle) | boot | manual | a module dependency cycle |
| [`runtime/restore-freshness`](#runtime-restore-freshness) | load | none (info) | `restoreOnStart` left on for `replication-sqlite`/`backup-blobstore` |
| [`deps/kestrel-range`](#deps-kestrel-range), `deps/mixed-majors`, `deps/pre-install` | source | auto / manual / none | a `@michaelthielemann/kestrel*` dependency range |
| [`offer/event-queue`](#offer-event-queue) | source | none / ask / auto | the switch from `events-direct` to `events-queue` |
| [`boot/<code>`](#boot-code) | boot | manual | any boot error no rule above claims |
| `boot/not-checked` | boot | none (warning) | a module or pipeline `checkBoot()` could not check safely |
| `load/failed` | source | manual | a config, module or pipeline file that failed to load |

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
A content type field name starts with `_`, which fails boot on 6.0.0. The tool cannot see stored
values — `data` reads queue rows, not content documents — so it always asks, with no default,
unless `--data-report <file>` supplies a hand-written `{ "<type>.<field>": false }` entry you have
independently confirmed by hand (for example, that the field was added after the last write path
that could have populated it, or by querying the content collection directly).

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

#### types-breaking-signatures
`Deps`, `Introspection`, `PipelineDefinition["steps"]`, `ModuleManifest`, `FakePersistence`,
`Manifest` and `Kestrel["contracts"]` all gained required members; only the consumer's own
typecheck sees a violation in a hand-built implementation of one of them.

#### responses-breaking-step-shapes
A pipeline runs `redirects.lookup`, `media.upload`, `insights.readManifest` or `events.listDead`,
each of which has a different 6.0.0 response or manifest shape; the finding names which one and how.

#### steps-ctx-done-terminal-output
A local module calls `ctx.done()`. A step whose early result does not match its `terminalOutput`
schema now fails the run, and boot cannot detect a mismatch by itself.

#### tests-run-pipeline-validates
A file imports `testing/runPipeline`, which now always validates `ctx.result` against the folded
output schema; a test that produced an undeclared shape now fails.

#### boot-dependency-cycle
A module dependency cycle — `boot()` names the full cycle path.

#### runtime-restore-freshness
`replication-sqlite`/`backup-blobstore` now fail boot when the database file was created during
this boot while a restore point exists, if `restoreOnStart` is on (the default).

#### deps-kestrel-range
A `@michaelthielemann/kestrel*` dependency is not on a 6.x range; `deps/mixed-majors` fires when
some are on 6.x and others are not, and `deps/pre-install` when the 5.x packages are still
installed (source tier only).

#### offer-event-queue
See [Switching event delivery to the queue](#5-switching-event-delivery-to-the-queue) above.

#### boot-code
A boot error no rule above claims a finding for; the code and message come straight from `boot()`.

#### not-checked
A module or pipeline `checkBoot()` left unchecked because a problem it depends on, or the sandbox
consent list, made it unsafe to check. Run with `--run-setup <use>` to include it.

#### load
A config, module or pipeline file failed to load; the message is the load error itself.

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

## Programmatic use

The sandbox helper composes with `checkBoot()` directly — see `docs/configuration.md` § Checking a
boot without starting it, which also lists every boot error code. `@michaelthielemann/kestrel-upgrade/plugin`
exports the plugin API (`UpgradePlugin`, `Rule`, `RuleContext`, `runUpgradeCli`) a host CLI registers
its own project loader and rules through, instead of shipping a second copy of the check-and-fix
engine; `runUpgradeCli` also takes a `prompt` and `isInteractive` override for a host with its own UI.
