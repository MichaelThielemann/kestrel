# @michaelthielemann/kestrel-cli

**What.** The `kestrel` command. It starts a Kestrel project, checks its boot without starting it,
explains a pipeline or an event, prints the project's manifest, writes an OpenAPI document and runs
the major-version upgrade assistant. The package installs the same program under two names,
`kestrel` and `kestrel-cli`.

**Install.** A backend project lists it in `dependencies`, next to `@michaelthielemann/kestrel`,
because `kestrel` starts the production server:

```
pnpm add @michaelthielemann/kestrel @michaelthielemann/kestrel-cli
```

A project a host package starts (see "Host packages" below) lists it in `devDependencies`. The CLI
runs the project's own installed `@michaelthielemann/kestrel`; its major must match the CLI's.

**Commands.**

```
kestrel [start]
kestrel check    [--root <dir>] [--json] [--fail-on error|warning] [--run-setup <use>]... [--no-plugins]
kestrel explain  <pipeline> [--json | --mermaid] [--depth <n>] [--root <dir>] [--run-setup <use>]... [--no-plugins]
kestrel explain  --event <name> [--json | --mermaid] [--depth <n>] [--root <dir>] [--run-setup <use>]... [--no-plugins]
kestrel manifest [--json] [--root <dir>] [--run-setup <use>]... [--no-plugins]
kestrel openapi  [--out <file>] [--title <t>] [--version <v>] [--server <url>] [--mount <path>]
                 [--root <dir>] [--run-setup <use>]... [--no-plugins]
kestrel upgrade  check|fix|data [options]
kestrel help [<command>] | kestrel --help | kestrel --version
```

- `start` (the default) boots the project in the current directory and starts its triggers. It
  takes no options: relative paths in module configs resolve against the current directory, so run
  it from the project root (a systemd unit sets `WorkingDirectory=`). Starting loads only the
  project's own core, never the inspection or upgrade code.
- `check` runs every boot check in a scratch copy of the project and prints each problem with its
  module and cause. Storage modules are rewritten into the copy; a module the sandbox does not know
  runs its `setup()` only when `--run-setup <use>` names it, and otherwise its pipelines are listed
  as not checked. Exit `0` clean, `1` a problem at or above `--fail-on` (default `error`), `2` the
  check could not run.
- `explain` shows a pipeline's triggers and steps (with atomic groups, the events each step emits
  and the relay), then every pipeline listening to those events with its delivery (direct, or queue
  with lane and whether the request relays it), following listeners up to `--depth` levels
  (default 4). `--mermaid` prints the same graph as a Mermaid flowchart.
- `manifest` prints what `describe()` returns for the checked project: modules, contracts,
  pipelines and triggers, as tables or `--json`.
- `openapi` boots the project without HTTP inside the same sandbox and writes an OpenAPI 3.1
  document to stdout or `--out`. A module the sandbox does not know stops it (exit `2`) unless
  `--run-setup` names it, so it never opens the project's own database or files.
- `upgrade` runs the upgrade assistant of `@michaelthielemann/kestrel-upgrade` with the rest of
  the arguments unchanged; see the repository's `docs/upgrading.md`.

To upgrade a project that still has the previous major installed, run the target version's CLI
without installing it:

```
npx -y @michaelthielemann/kestrel-cli@6 upgrade check
pnpm dlx @michaelthielemann/kestrel-cli@6 upgrade check
```

Both pick the `kestrel-cli` name, so an older `kestrel` binary in the project is never run instead.

**Host packages.** A package that loads a project in its own shape registers a plugin in its own
`package.json`:

```json
"kestrel": { "plugin": "./cli/plugin.mjs", "pluginApi": 4, "engine": "^6.0.0" }
```

The CLI reads this field from the project's direct dependencies only, as data, before importing
anything. `plugin` is a `.mjs` or `.js` file inside the package; its default export receives
`{ pluginApiVersion, cliVersion }` and returns an `UpgradePlugin`. `engine` is the range of CLI
versions the plugin is built for, of the form `^<major>.<minor>.<patch>`. A field that is malformed
or points outside its package stops every command except `start`; a plugin built for another
version is reported as `deps/host-outdated` and never runs. Two plugins that both detect the
project stop the command and name both. `--no-plugins` loads no plugin, but an
outdated or refused one is still reported. The configuration docs
describe the field in full.
