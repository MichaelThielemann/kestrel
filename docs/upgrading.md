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
or `modules/emits` finding), or that it can switch. `fix` then asks `switch-to-queue` (default
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
