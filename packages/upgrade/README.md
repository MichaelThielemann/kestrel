# @michaelthielemann/kestrel-upgrade

**What.** A CLI (`kestrel-upgrade`) and a small library that find the breaks a 5.8 project meets on
6.0.0, preview a fix for the ones that can be edited mechanically, and read a copy of a project's
database for the checks only stored data can answer.

**Why.** Every break in `CHANGELOG.md`'s Breaking section is real, but a consumer should not have
to read the whole file and grep their own project for each item by hand. This package turns that
list into findings against the consumer's own files, with a stable id, a tier (what it took to find
it) and a fix class (auto, ask, manual). It shares its check engine with `@michaelthielemann/kestrel`'s
`checkBoot()`, so it never drifts from what `boot()` actually enforces.

**Commands.**

```
kestrel-upgrade check [--root <dir>] [--entry <file>] [--json] [--fail-on error|warning|info] [--run-setup <use>]...
kestrel-upgrade fix   [--write] [--allow-dirty] [--run-setup <use>]... (+ the check flags)
kestrel-upgrade data  --db <sqlite file> [--json] [--out <file>]
```

`check` never writes anything. `fix` without `--write` previews every automatic edit as a finding;
`--write` applies them to the project, refusing a file with uncommitted changes unless
`--allow-dirty`. `data` copies the given SQLite file (and any `-wal`/`-shm` siblings), verifies the
copy with `PRAGMA quick_check` before reading anything else, and reports what only stored rows can
answer (an unfanned 5.x event queue, so far). Exit codes: `0` nothing at or above `--fail-on`
(default `error`), `1` at least one finding, `2` the tool could not run (bad arguments, a dirty
write target, a copy that fails `quick_check`).

**Config.** No `kestrel.config.ts` of its own; every option is a CLI flag or a call to the library
functions below.

**Library.** The root export carries the report types (`Finding`, `UpgradeReport`) and
`runUpgradeCli(argv, options?)`, the same function the bin calls, so a host CLI (a layer's own
bin) can register its own project loader and rules as a plugin and delegate to this engine instead
of shipping a second copy of it. `./plugin` carries the plugin API
(`UpgradePlugin`, `Rule`, `RuleContext`, `Question`). `./sandbox` carries `sandboxBootInput()`,
which rewrites a loaded project's storage modules to write into a scratch directory instead of the
project's own files, for a CI gate that wants `checkBoot()` without a full `kestrel-upgrade` run.

**Not included.** Installing, committing, pushing or reaching the network — the tool prints the next
command and lets the consumer run it. An interactive TTY prompt: every rule shipped in this release
fixes automatically or stays manual, so none needs one; `--run-setup <use>` is the one way to let a
module outside the sandbox table run its `setup()`. Draining a queue, renaming a stored column or
any other write to a live database — the `data` command only reads.
