# Upgrading: 5.x -> 6.0.0

`@michaelthielemann/kestrel-upgrade` finds the 6.0.0 breaks a 5.8 project meets, previews a fix for
the ones it can edit mechanically, and reads a database copy for the one check only stored data can
answer. It never installs, commits, pushes or reaches the network on its own.

## 1. See what breaks

With the 5.x packages still installed:

```
pnpm dlx @michaelthielemann/kestrel-upgrade@6 check
```

At this point the tool sees the **source tier** only — it reads `kestrel.config.ts`, every pipeline
file and `package.json` as text, without importing the 6.0 packages. It reports:

- **`modules/event-delivery`** — an `events-inmemory` bus with no `events-direct` or `events-queue`
  next to it. `events-inmemory` now provides the bus only; delivering event-trigger pipelines is a
  separate module's job.
- **`modules/event-bus`** — an `events-queue` module with no `events-inmemory` next to it, for the
  same reason in the other direction.
- **`config/sqlite-acquire-timeout`** — a `persistence-sqlite` entry whose `acquireTimeoutMs` does
  not exceed its `busyTimeoutMs` (both default to 5000, so an untouched config fails this).
- **`steps/removed`** — a pipeline step named `media.folderItems`; `media.listFolderItems` is the
  same handler.
- **`deps/kestrel-range`** — a `@michaelthielemann/kestrel*` dependency whose range is not `^6.0.0`.

Every finding it cannot edit mechanically is reported with its exact location and what to change,
never a silent edit. Every finding the tool did not name explicitly but the checker underneath still
catches shows up as `boot/<code>`, so a break nobody wrote a rule for is still listed.

## 2. Bump and install

```
pnpm dlx @michaelthielemann/kestrel-upgrade@6 fix --write
pnpm install
```

`fix` without `--write` only previews: it shows what would change and never touches the project.
`--write` edits the project's own files in place, refusing a file with uncommitted changes unless
`--allow-dirty` is also given, so `git diff` shows exactly the tool's edits and `git checkout`
reverts them. The tool never runs `pnpm install` itself.

## 3. Full check

After installing the 6.0.0 packages, running `check` again also loads the config, every module and
every pipeline, and boots the instance in a scratch copy of the project — never the project itself
— to run the same checks `boot()` runs. A module the tool does not know is safe to run `setup()`
against (anything beyond kestrel's own storage modules) does not run unless named with
`--run-setup <use>`; its pipelines are then reported as not checked instead of run against a real
config.

## 4. The boot result

`fix`'s preview always shows the boot result the edited project would have: how many errors remain,
how many still need an answer, how many stay manual.

## 5. Data

```
kestrel-upgrade data --db <a copy of the database>
```

The tool copies the given file (and any `-wal`/`-shm` siblings) into its own temp directory and
never opens the path it was given again. It verifies the copy with `PRAGMA quick_check` before
reading anything else; a copy that fails this, or does not open, is refused (exit 2) rather than
read, since a plain file copy of a live database can be torn. Take a consistent snapshot close to
cutover (a replication snapshot, or `sqlite3 <db> ".backup <copy>"`).

## What the tool never does

- Run a module's `setup()` outside the sandbox table without `--run-setup <use>` naming it.
- Write anything outside `fix --write` (and `--out`, when asked).
- Accept a torn database copy.
- Install, commit, push, or reach the network on its own; it prints `pnpm install` as the next step.

## CI

`--json` prints a report on stdout (progress goes to stderr) with a stable `schema` field; validate
it against your own tooling before trusting the exit code. Exit codes: `0` nothing at or above
`--fail-on` (default `error`), `1` at least one finding, `2` the tool could not run.

## Programmatic use

The sandbox helper composes with `checkBoot()` directly — see `docs/configuration.md` § Checking a
boot without starting it. `@michaelthielemann/kestrel-upgrade/plugin` exports the plugin API
(`UpgradePlugin`, `Rule`, `RuleContext`, `runUpgradeCli`) a host CLI registers its own project loader
and rules through, instead of shipping a second copy of the check-and-fix engine.
