# @michaelthielemann/kestrel-upgrade

**What.** The library behind `kestrel upgrade` (the command lives in `@michaelthielemann/kestrel-cli`):
it finds the breaks a 5.8 project meets on 6.0.0, preview and apply a fix for the ones that can be edited mechanically, ask about the ones a
person must decide, offer switching event delivery to the queue where the project can support it,
and read a copy of a project's database for the checks only stored data can answer.

**Why.** Every break in `CHANGELOG.md`'s Breaking section is real, but a consumer should not have
to read the whole file and grep their own project for each item by hand. This package turns that
list into findings against the consumer's own files, with a stable id, a tier (what it took to find
it) and a fix class (auto, ask, manual). It shares its check engine with `@michaelthielemann/kestrel`'s
`checkBoot()`, so it never drifts from what `boot()` actually enforces.

**Commands.** This package ships no binary. Run the commands through the kestrel CLI, locally or,
from a project still on the previous major, with `npx -y @michaelthielemann/kestrel-cli@6 upgrade …`
(or `pnpm dlx`):

```
kestrel upgrade check [--root <dir>] [--entry <file>] [--json] [--fail-on error|warning|info]
                      [--run-setup <use>]... [--data-report <file>]
kestrel upgrade fix   [--write] [--yes] [--answers <file>] [--save-answers <file>] [--allow-dirty]
                      [--data-report <file>] (+ the check flags)
kestrel upgrade data  --db <sqlite file> --root <dir> [--json] [--out <file>]
```

`check` never writes anything. `fix` without `--write` previews every finding, showing a unified
diff for each automatic edit; `--write` shows the same diff per file and asks `y`/`n`/`d` on a
terminal, or needs `--yes` without one (never silent). A question a finding's fix needs is asked
over `node:readline` in order, resolved from `--answers` first, then the prompt, then `--yes`'s
default; a question with no safe default stays open under `--yes`. `--data-report <file>` is the
JSON the `data` command's own `--out <file>` writes, read back through `RuleContext.project.dataReport`
(`model/underscore-field` reads its `underscoreFields` counts from there, kept separate from a
plugin's own `LoadedProject.data` so a report never overwrites it). `data` copies the given SQLite
file (and any `-wal`/`-shm` siblings), verifies the copy with `PRAGMA quick_check` — the only SQL
the tool issues itself — then reads it through the project's own installed `persistence-sqlite`, so
the storage layout stays that module's knowledge. Exit codes: `0` nothing at or above `--fail-on`
(default `error`), `1` at least one finding, `2` the tool could not run (bad arguments, a dirty
write target, a copy that fails `quick_check`, an `--answers` value outside its question's choices).
An `--answers` id no pass asked is ignored with a warning. `fix --write` applies edits that only
appear after earlier ones in the same run, for at most five passes.

**Config.** No `kestrel.config.ts` of its own; every option is a CLI flag or a call to the library
functions below.

**Library.** The root export carries the report types (`Finding`, `UpgradeReport`) and
`runUpgradeCli(argv, options?)`, the function `kestrel upgrade` calls with the plugin it discovered;
`options.prompt`/`options.isInteractive` let a caller supply its own UI instead of a terminal. A host
package registers its project loader and rules as a plugin through the `kestrel` field of its own
`package.json` (see `docs/upgrading.md` § Registering a plugin); `./hosts` reads that field from a
project's direct dependencies as data (`scanHosts`, `loadHostPlugins`, `selectHostPlugin`). `./plugin` carries the plugin API (`UpgradePlugin`, `Rule`, `RuleContext`,
`KestrelPluginFactory`, `KestrelPluginHost`, `HostProblem`, `OpsFacts`, `PLUGIN_API_VERSION`, `PLUGIN_API_MIN`,
and `createRuleContext` for a plugin's own rule tests) — see `docs/upgrading.md`'s "The plugin API" for the full surface, and `./codemods` for the edit,
verify and AST-reading primitives a plugin's own rule or locator is written with, so it never needs
a second copy of this engine's own edit machinery. A registered plugin's own `load()` (its config
import, any prepare step it runs) executes unconditionally, before any consent question — `--run-setup`
and its consent list only ever gate a module's own `setup()`, at the later boot tier. `./sandbox`
carries `sandboxBootInput()`, which rewrites a loaded project's storage modules to write into a
scratch directory instead of the project's own files, for a CI gate that wants `checkBoot()` without
a full `kestrel upgrade` run. `./project` (`loadBackendProject`) and `./scratch`
(`createScratchCopy`, `removeScratchCopy`) are the loader and scratch copy the kestrel CLI's
inspection commands share with the engine; none of these subpaths loads the source parser.

**Not included.** Installing, committing, pushing or reaching the network — the tool prints the next
command and lets the consumer run it. Draining a queue, renaming a stored column or any other write
to a live database — the `data` command only reads.
