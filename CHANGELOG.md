# Changelog

## Unreleased

Net changes since 5.8.2.

### Breaking

- `persistence-sqlite`, `replication-sqlite`, `backup-blobstore`: **a second process on the same database file
  fails to boot.** Each of the three modules takes an instance lock on its `file` as the first thing its `setup()`
  does: before it opens the file, applies a staged restore or rebuilds a missing file from the replica or the
  backup. Another process that boots on the same file while one runs fails with the new boot error code
  `instance-locked`, naming the module setting `allowConcurrentProcesses: true` and, for a readable lock, the
  holder's host, PID and start time and the time from which the lock is taken over (an unreadable lock file is
  refused while it was written within the TTL); the database, its `-wal` and
  `-shm`, a staged restore and the restore records next to it stay as they were, and `restoreOnStart` creates no
  file. The lock is the sidecar `<file>.instance` next to the database, never a row inside it, and it is not part
  of a snapshot, a replica or a backup; the lock also writes short-lived siblings whose names start with
  `<file>.instance`, and none of them belongs in a copy of the data directory (the scratch copy of `kestrel check`,
  `explain`, `manifest`, `openapi` and `upgrade` leaves them out). The modules of one process that
  name the same file share the lock, and the lock file goes with the last of them; `replication-sqlite` gives its
  share up only after its teardown has shipped the last WAL frames and sealed the generation. An in-memory
  database takes no lock. `kestrel.health()` reports a lost lock (another instance took it over, or its file was
  gone after the process had not renewed it for longer than its TTL) as `ok: false` with `restartRequired: true`.
  `checkBoot()` with `setup: "all"`, or with `setup: { only: [...] }` naming one of these modules, takes the lock
  on the real file while it runs and gives it up before it returns, so a process that boots on the file during the
  check is refused;
  `kestrel check --run-setup` runs these modules against a scratch database. To run several processes on one file
  on purpose, set the new option `allowConcurrentProcesses: true` (default `false`) on every module that names
  the file; one module of the file with it and another without it fails boot with `invalid-module-config`, naming
  both. The mismatch is found when the second of them is set up: `replication-sqlite` or `backup-blobstore` with
  the option, set up before `persistence-sqlite` without it, has by then run without a lock, also beside a process
  that holds one, and may have applied a staged restore or rebuilt a missing file, and `replication-sqlite` ships
  and seals a generation when the failed boot tears it down. After an unclean stop (a crash, `kill -9`, a power loss, a container restarted in a new PID namespace, a
  restart of the machine) the next start is refused until the old lock's TTL (60 s by default) has passed since
  its last heartbeat, unless the old process is provably gone on this machine: the lock was written on this
  machine and in this PID namespace, and its process no longer runs. On Linux that is judged by PID and process
  start time; on macOS and Windows by the PID alone, so a lock whose PID went to a new process waits for the TTL.
  "The same machine" means the same Linux boot id, or the same hostname where the system has none; on Linux a
  restart of the machine changes the boot id, so its lock always waits for the TTL. Only when the kernel gave a
  restarted container's new namespace the old one's id is its lock judged by PID and start time and taken over at
  once. A supervisor should restart the service with a delay; for systemd, `Restart=on-failure` with
  `RestartSec=15s`, so that the retries during the TTL do not reach `StartLimitBurst`. A clean stop releases the
  lock at once, and the next start takes it without waiting. The lock comes from the new core entry point
  `@michaelthielemann/kestrel/instanceLock` (`acquireInstanceLock`, `instanceLockFile`), which a module of a
  project can use for its own database file the same way. A `KestrelBootError` that a module's `setup()` throws
  and that names that module is reported with its own code, module and reason instead of `setup-failed`, also
  when another copy of the core created it; `isKestrelBootError` from `@michaelthielemann/kestrel` makes the same
  check.
- `site-default`: **a resolve step must carry the route's `liveWhen` filter, and `site.resolveLinks` a filter.** A
  pipeline whose `site.resolve:<type>` on a routed type lacks a field of the route's `liveWhen`, or names a value
  the route excludes, fails boot with `site/default: pipeline "<name>": <step> must carry status=published, …`,
  because the step would serve drafts and other unpublished documents at their path. A `site.resolveLinks` step
  with no filter argument fails boot when any route has a `liveWhen`, because it would give drafts a path in
  every document it rewrites. Add the filter, for example
  `site.resolve:pages?home=home&status=published&fallback=true` for `liveWhen: { status: "published" }`, and
  `site.resolveLinks:pages?home=home&status=published&fallback=true`. A filtered `site.resolveLinks` links a
  target only while it passes the filter's fields that its own type declares, and a routed target also only
  while its own route publishes it; a type without a field of the filter is not restricted by it. A resolve step behind `authn.requireUser` is a signed-in
  preview and stays unfiltered; `authn.identifyUser` does not make a step one. Routed types without a
  `liveWhen` and resolve steps on types that are not routed are not checked.
- **zod 4.** Every package that lists `zod` requires `^4.6.6` (was `^3.23.8`), which fixes a published
  advisory in array parsing that no zod 3 release fixes. A module's `configSchema` is read through
  zod 4's own definitions for its JSON Schema, variables, defaults and secrets, so a project's own
  modules build their schemas with zod 4: depend on `zod` `^4.6.6`, and the install resolves one copy
  for the project and kestrel. `ModuleDefinition["configSchema"]` and the `configSchema` that
  `defineModule` takes are zod 4 types. In a module's own schema, `z.record` takes the key schema
  first (`z.record(z.string(), value)`); an object schema's `.default({})` no longer fills the nested
  defaults inside it, `.prefault({})` does, as zod 3's `.default()` did; a function as the second
  argument of `.refine()` is ignored, pass `{ error: … }`. `.strict()`, `.passthrough()` and
  `.describe("secret")` keep working, but `.describe()` must come after the methods that drop it:
  zod 4's `.strict()`, `.passthrough()`, `.extend()`, `.partial()`, `.pick()` and the other object
  methods return a copy without the description, as do `.or()`, `.and()`, an enum's `.extract()`
  and `.exclude()` and a tuple's `.rest()`, so a `"secret"` mark set before them is lost and
  the value shows in plain text in `describe()`. The JSON Schema, variables and defaults of every
  bundled module's config are unchanged, but the integer settings of `kestrel.config` and of every
  bundled module refuse a value above `Number.MAX_SAFE_INTEGER` (`http: { maxBodyBytes:
  Number.MAX_VALUE }` now fails boot with `Too big: expected int to be <=9007199254740991`), and every
  number setting refuses `Infinity`. `kestrel upgrade`'s new `deps/zod-range` raises the
  project's `zod` range, `zod/record-key` inserts the key schema, `zod/object-default` renames such
  a `.default` to `.prefault` and `zod/describe-order` moves a `.describe()` after the methods that
  follow it and drop it; `types/breaking-signatures` names the schema type. A module whose `configSchema`
  holds a node not built with zod 4.6.6 or a later 4.x, at the root or nested at any depth, such as a
  field from a package that still depends on zod 3 or imports zod 3.25's `zod/v4`, fails boot with the
  new problem code `invalid-config-schema`, naming that module, the path of the first such node
  (`configSchema.servers[].endpoint`) and the zod version it reports, before its config is parsed.
  `zodSchemaProblem(schema)` from the package root returns that reason, or `undefined` for a schema
  boot reads.
- An `invalid config: …` or `invalid kestrel.config: …` boot error carries zod 4's messages: a missing
  key reads `Invalid input: expected string, received undefined` (was `Required`), an unknown key
  `Unrecognized key: "name"` (was `Unrecognized key(s) in object: 'name'`). A secret path reports
  zod 4's issue code, `invalid_value` where zod 3 said `invalid_enum_value` or `invalid_literal` and
  `invalid_format` where it said `invalid_string`. An enum mismatch still reads
  `Invalid enum value. Expected 'a' | 'b'`. A value in a union, such as `http`, a trigger or a
  `references-default` target, reports the issue of the option it fits under that issue's full path
  (`http.port: Invalid input: expected int, received number`, `targets.page.content: invalid_type`):
  an option whose literal or enum differs at a key the value shares with another option, or that
  calls a key unrecognized that another option declares, does not fit, and the option declaring
  most of the value's keys wins. A value that fits no option, or two equally (a trigger with both
  `event` and `cron`), reports `Invalid input` at the union's path.
- `images-default`: the `VALIDATION` error of `images.register` for an invalid size carries zod 4's
  message after `images: <path>: `: a width below 16 reads `Too small: expected number to be >=16`
  (was `Number must be greater than or equal to 16`), a missing name `Invalid input: expected
  string, received undefined` (was `Required`), a name that is not a slug `Invalid string: must
  match pattern /^[a-z][a-z0-9-]*$/` (was `Invalid`) and an unknown `fit` or `format` `Invalid
  option: expected one of "inside"|"cover"` (was `Invalid enum value. Expected 'inside' | 'cover',
  received 'fill'`).
- `delivery-static`: **`delivery.exportLlms` is gone.** A pipeline that still names it fails at boot
  as an unknown step. Index files are never written inside a request any more: put
  `delivery.requestIndexes` where `delivery.exportLlms` was, and with `dependencies.render: "events"`
  subscribe `delivery.exportIndexes` (sitemap.xml, robots.txt, llms.txt) to `delivery.indexesStale`
  and `delivery.exportLlmsFull` (llms-full.txt) to `delivery.llmsStale`. A response that carried
  `llms` from the old step no longer has it. `kestrel upgrade`'s `delivery/export-llms` renames the
  step, to `delivery.exportLlmsFull` in a pipeline on `delivery.llmsStale` and to
  `delivery.requestIndexes` everywhere else, and `delivery/index-triggers` adds the `refreshIndexes`
  and `refreshLlms` jobs that `"events"` needs.
- `delivery-static`: **`llms.siteUrl` moved to a top-level `siteUrl`**, which llms.txt, sitemap.xml and
  robots.txt share. `llms.siteUrl` fails at boot; `kestrel upgrade`'s `delivery/site-url` moves it.
  `siteUrl` must be an absolute `http` or `https` URL without credentials, query or fragment; it is
  normalized (host lower-cased, default port dropped, trailing slashes stripped) and keeps a base path.
  The fix also moves a value read from an environment variable that is unset where the check runs.
- `delivery-static`: **writes and owns `<prefix>robots.txt` and, with a `siteUrl`,
  `<prefix>sitemap.xml`** (`sitemap` defaults to `true`), overwriting a file of either name found
  there, and removing a `<prefix>sitemap.xml` while no page is listed (every page `noindex`, or
  nothing published). Both appear at the first `delivery.requestIndexes` or `delivery.resumeStale`
  run, not at boot by themselves. Without `robots.policy`, robots.txt is `Disallow: /` unless
  `NODE_ENV` is `production`, which Kestrel never sets itself; boot warns, and `kestrel upgrade`'s
  `delivery/robots-policy` reports it without changing the config. `robots: false` keeps a
  robots.txt of the site's own. With `sitemap: false` or without `siteUrl` only a sitemap.xml that
  still holds what an earlier export wrote is removed. `<prefix>llms.txt` is written on every export, whether or not a
  pipeline asked for llms files before, and overwrites a file of the site's own; without
  `llms.full`, only an llms-full.txt that still holds what an export of this version wrote is removed.
- `delivery-static`: **deletes orphaned page files once after the upgrade.** On a database that held
  status rows when 6.0 first started, `delivery.resumeStale` (so only with the `*/5` recovery cron)
  removes every `index.<ext>` file under `prefix`, with the extension of a configured format, at a
  path no status row has and outside `reservedPaths`, logging each key (see upgrading.md,
  "delivery-orphan-removal"). The root page stays. It runs once per database and waits for the build
  check of the process; a restore that `delivery.checkBuild` learns of through `_databaseRestoredAt`
  records it as done. It never runs on a new or empty database or with a `prefix` that does not end in
  `/`. Paths at and below a directory under `prefix` that holds a robots.txt, sitemap.xml or llms.txt
  are taken for another site and left alone; any other site below `prefix` and hand-placed index
  files that no page owns need their path in `reservedPaths`.
- **A slug belongs to its locale; a translation without a slug of its own is never served.** `site@1`
  finds a locale only by its own slug there: `site.resolve`, `pathOf`, `resolveLinks`, `_paths`,
  `site.attachPaths`, the moves `site.pathsMoved` reports (and so the automatic redirects built from
  them) and `delivery-static`'s export no longer use the default locale's slug for a locale that has
  none, whether the default locale is published or not, in routed and unrouted mode; such a locale
  answers 404 and a link to it is broken. `/en/<default slug>` no longer finds a translation that has
  a slug of its own either. In routed mode `site.indexPath` refuses a save (`VALIDATION` on the slug
  field) that leaves the written locale published, translated and without a slug of its own; the
  written locale is `params.locale`, else `payload.locale`, else the default locale, so a pipeline
  writing a translation passes its locale that way. Every path segment comes from a slug of the path's
  own locale: a page without a slug in a locale gives nothing below it a path there, publishing a
  document below such a page is refused (`VALIDATION` on the parent field, the slug field for a mounted
  document, naming the page), and so are clearing a page's slug, removing its translation or moving a
  mounted collection while documents below are published in that locale (naming them). The shared
  `site@1` suite tests it, and `pathOf` answers `null` for a document whose slug came from another
  locale. `kestrel upgrade data` reports stored translations that are published without a slug of
  their own, and published documents below a page without a slug in their locale
  (`data/translation-slug`, an error).
- One command, `kestrel`, from the new package `@michaelthielemann/kestrel-cli`, replaces the three
  binaries. `@michaelthielemann/kestrel` no longer ships the `kestrel` binary: add
  `@michaelthielemann/kestrel-cli` at the same version, in `dependencies` for a backend project,
  since its `kestrel` starts the production server. `kestrel` alone still starts the project in the
  current directory, with the same log lines and exit codes; any argument after `start` is an error.
  `kestrel upgrade`'s `deps/kestrel-range` adds the dependency (to `devDependencies` when a host
  package's plugin loads the project) and moves it out of the wrong block.
- `kestrel-openapi` is gone; run `kestrel openapi` with the same options, plus `--root`,
  `--run-setup` and `--no-plugins`. It refuses an unknown option (exit 2), and it boots the project
  in a sandboxed scratch copy: storage modules write into the copy, and a module the sandbox does not
  know stops it (exit 2, naming the module) unless `--run-setup <use>` names it, so it no longer
  opens the project's own database or files. `@michaelthielemann/kestrel-openapi` is a library only.
  `kestrel upgrade`'s new `scripts/kestrel-binaries` rewrites the command in `package.json` scripts
  and warns about it in other project files, including a flag the command now refuses.
- `kestrel-upgrade` is gone; run `kestrel upgrade check|fix|data` with unchanged options, and from a
  5.x project `npx -y @michaelthielemann/kestrel-cli@6 upgrade …` (or `pnpm dlx`). The package
  ships the program under a second name, `kestrel-cli`, which is what both run.
  `@michaelthielemann/kestrel-upgrade` is a library only; `scripts/kestrel-binaries` rewrites the old
  command, including the `pnpm dlx`/`npx` form.
- `scripts/kestrel-binaries` reports every command that runs the unscoped name `kestrel`,
  `kestrel-cli`, `kestrel-openapi` or `kestrel-upgrade` through a runner that installs a missing
  package on the fly (`npx`/`pnpx` and `npm exec`/`npm x` without `--no`, `pnpm dlx`, `yarn dlx`, `bunx`,
  with any flags, or through `-p`/`--package`) as an error,
  in `package.json` scripts, other project files and Markdown: those names belong to unrelated
  registry packages. In a script it drops the runner (`npx kestrel check` becomes `kestrel check`);
  elsewhere it names `pnpm exec kestrel …`, `npm exec --no -- kestrel …` or
  `npx -y @michaelthielemann/kestrel-cli@6 …`.
- A host package registers its upgrade plugin through a `kestrel` field in its own `package.json`
  (`plugin`, `pluginApi`, `engine`) instead of shipping its own binary; the load-failure hint that
  pointed at such a binary is removed. A direct dependency that depends on
  `@michaelthielemann/kestrel-upgrade` without that field, or whose `engine`/`pluginApi` do not match
  the running CLI, is reported as `deps/host-outdated` (an error): its plugin is never run, and
  `fix --write` and `data` refuse to run (exit 2) until its matching release is installed. A
  malformed field is `deps/host-refused`: it stops the kestrel commands with exit 2, and the engine
  refuses `fix --write` and `data` for it too. `--no-plugins` loads no plugin but keeps both guards.
  `PLUGIN_API_VERSION` is `6`; the new `PLUGIN_API_MIN` (`4`) is the lowest `pluginApi` the engine
  runs. Plugin API `5` adds the optional `UpgradePlugin.dataFindings` hook, through which a host
  package reports what only its stored data can show in `kestrel upgrade data`. Plugin API `6` adds
  the optional `UpgradePlugin.ops` hook and its `OpsFacts` type: the readiness path, environment
  mapping for the blob store and the database file, secret variable names, migration switches and the
  ids of the release's content migrations the operations tooling needs; the upgrade commands do not
  call it. A plugin that declares `pluginApi` `5`
  keeps running.

- The pipeline grammar gains an atomic group: `steps` accepts `{ atomic: [...] }` next to a plain
  step name, and the runner wraps such a group in one all-or-nothing scope it obtains from a
  module hook. `PipelineDefinition["steps"]` is now `readonly PipelineEntry[]`, not
  `readonly string[]`; code that reads, filters or maps a pipeline's steps as plain strings must
  flatten first with the exported `pipelineSteps()`, or narrow a single entry with the exported
  `isAtomicGroup()`. `ResolvedStep` and
  `PipelineStepManifest` gain an optional `atomic` ordinal; `ModuleManifest` gains a required
  `atomicScope` boolean, so a hand-built manifest must add it.
  - `ModuleDefinition` (and `ModuleInput`) gain an optional `atomicScope(instance, info, body)`
    hook, published as `AtomicScope` from the new `@michaelthielemann/kestrel/atomic` export path.
    At most one loaded module may declare it; a pipeline with a group and no provider, or two
    providers, fails to boot naming the pipeline or the two modules.
  - `StepDescription` gains an optional `atomicSafe` boolean, default `false`. A step inside a
    group whose `describe()` does not declare `atomicSafe: true` fails boot, naming the pipeline
    and the step. `atomicSafe` means the step writes only through the scoped `persistence@1` and
    has no effect outside it; it says nothing about how long the step runs. A group holds the
    store's write lock for its whole duration.
  - `persistence/sqlite` implements the scope: one `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK` per
    group, serialized by a FIFO mutex so a concurrent read never observes an uncommitted row.
    `createMany` now uses `BEGIN IMMEDIATE` and joins an outer scope instead of opening its own;
    outside a group, a `COMMIT` that fails with an error SQLite reports rolls back and answers
    `Err(TRANSIENT)`.
    Two new config keys, `acquireTimeoutMs` and `scopeTimeoutMs`. `scopeTimeoutMs` defaults to
    `5000`; `acquireTimeoutMs` defaults to `busyTimeoutMs + 10000`. An explicit `acquireTimeoutMs`
    that does not exceed `busyTimeoutMs` is rejected at setup, naming the key. `acquireTimeoutMs`
    bounds every wait for the connection: a `persistence@1` call still waiting when it runs out
    answers `Err(TRANSIENT)` and a group a failed `begin`, and neither runs afterwards. Both budgets
    are timers enforced when the event loop gets a turn, so synchronous SQLite work delays them,
    and neither covers SQLite's own busy wait on a lock another connection holds, which
    `busyTimeoutMs` bounds. An `acquireTimeoutMs` at or below `scopeTimeoutMs + busyTimeoutMs`
    boots and logs a warning at setup. A persistence call
    made after its own atomic scope rolled back or timed out **throws** instead of writing (only
    reachable from work a step did not await); a call made after the scope committed writes
    normally, with a warning logged.
  - These steps declare `atomicSafe: true`: every step of `content-default` and
    `revisions-default`; every step of `events-queue` except `events.relay`; every step of
    `references-default` except `references.guardAll`, `references.scan` and `references.rebuild`;
    every step of `links-default` except `links.check` and `links.rebuild`; `delivery-static`'s
    `delivery.readStatus`; and `authn-multi`'s `authn.verifyUser` and `authn.deleteUser`. Each of
    them writes only through `persistence@1`, some over a whole collection (`events.purgeDone`,
    `references.report`, `revisions.prune`). Every other shipped step keeps the default `false`.
  - `fakePersistence` (the contracts package's testing fake) gains the same `scope`/`failScope`/
    `scopeTimeoutMs`/`acquireTimeoutMs` surface, so a module test can exercise a grouped pipeline
    without SQLite, including its own FIFO queue, the same acquire budget for every call and scope
    (`Err(TRANSIENT)` or a failed `begin` once it runs out, never running afterwards) and the two
    terminal states of a closed scope. Both run the shared `atomicScopeTests` suite
    (`@michaelthielemann/kestrel-contracts/atomic.contract.test`), whose fixture names the store's
    `acquireTimeoutMs`. **`FakePersistence` gains four new required members**: anyone who built a
    hand-written implementation of that interface's type (rather than using `createFakePersistence`)
    must add them. The core's `testing/runPipeline.ts` test helper gains a typed `atomicScope`
    option with no default.
  - `insights.readManifest`'s output schema follows the two new manifest fields.
- Event delivery is a separate module from the `events@1` bus. `events-inmemory` now provides
  `events@1` and nothing else — no `events.emit` step, no event trigger hook. Configure exactly one
  delivery module next to it: `events-direct` (new, inline — subscribes event-trigger pipelines to
  the bus and runs them within the emitting request) or `events-queue` (outbox — see below). An
  instance without a delivery module fails to boot as soon as a pipeline has an event trigger
  (`event triggers need a module that provides an event trigger hook`) or uses `events.emit`
  (`unknown step "events.emit"`); two delivery modules fail to boot with `step "events.emit" is
  already registered by <module>`.
- `events-direct`'s `events.emit` no longer swallows a subscribed handler's rejection: it answers
  500 `INTERNAL` with the aggregated failure as `cause` instead of logging and ignoring it. This
  only affects a programmatic `events.on` handler that throws; a pipeline handler never throws.
- `events-queue` no longer provides `events@1` and now requires it (`persistence@1` + `events@1`);
  it keeps its own `events.emit` (writes one row per subscribed pipeline, never touches the bus),
  the worker and the admin steps. It subscribes on the bus, at `setup()`, to every event name a
  configured pipeline trigger names, so an event raised through `events@1` by a module (for example
  `migrations.applied`) is still queued and a failed insert still rejects that `emit`.
- `events-queue`'s dead-letter and retry are per pipeline: one row per `(event, pipeline)`, so a
  failing pipeline's retries no longer re-run the other pipelines subscribed to the same event.
  `events.listDead` items gain a required `pipeline` field (`""` for a row stored before this
  change); queue counters grow accordingly, since they now count `(event, pipeline)` rows. **No
  ordering is guaranteed between the pipelines subscribed to one event.** Rows stored before this
  change (or written while the delivery table did not exist yet) carry no pipeline; the worker fans
  them out to every currently subscribed pipeline at the start of its first tick after upgrading.
- Every event a pipeline receives now carries `eventId` (a fresh UUID unless the emitter supplied
  one), `event` and `at` — additive to the payload, not a contract change — including events raised
  through `events@1` by a module. `eventId` is the documented dedup key for at-least-once delivery.
  A consumer step that validates the event payload against a schema with
  `additionalProperties: false` must allow these three fields, or validation now rejects an event
  it accepted before.
- `core`: `Deps` (the argument to a module's `setup()`) gains a required `eventTriggers` property,
  the configured event triggers in configuration order. `Kestrel["contracts"]` is now typed
  `ContractLookup & { names(): string[] }` instead of `Deps & { names(): string[] }`; a reader of
  `kestrel.contracts` is unaffected, a consumer constructing a `Deps` by hand must add the field.
- `core`: `sortModules` adds a soft ordering edge from a module declaring `emits` to the module
  providing the event trigger hook, unless that module already depends on it, so an event a module
  raises during its own `setup()` can already be delivered once the instance starts. This changes
  the setup order only for such a module; every other module keeps the order the config lists.
  **`emits` is load-bearing for this edge**: a module that raises an event through `events@1` during
  its own `setup()` and does not declare that event in `emits` may be set up before the delivery
  module exists, and with `events-queue` that event is then lost — there is nobody subscribed yet to
  catch it.
- Rolling back to the previous major with `events-queue` configured requires a drained queue first
  (`pending` and `running` at zero, visible through `events.readQueueStatus`): a fanned-out row is
  one row per pipeline where the previous major expects one row per event, and its worker would
  otherwise run every registered handler for each row it claims.
- `core`: `Introspection` (the read-only view a module's `attach(instance, kestrel)` receives)
  gains a required `health()` method next to `describe()` and `observe()`. A hand-built
  `Introspection` value, such as a test double, must add it.
- `sortModules` applies `defineModule`'s `before: readonly Contract<unknown>[]` as a real ordering
  edge: a module declaring `before: [C]` is now set up before the provider of `C`, regardless of
  where either module sits in `kestrel.config.modules`. A module whose target's provider depends on
  it, directly or transitively — including a module that both `requires` and declares `before` on
  the same contract — fails the boot as a dependency cycle naming the path, since "set up before
  the thing I need" cannot be satisfied. The `BootWarning` member `module-order` is removed: a
  hand-written `modules` list that this reordering silently fixed no longer produces a warning,
  since there is no longer anything to warn about.
- `content-default`: a content field name may no longer start with `_`, on every path and under no
  feature condition. Boot fails naming the type and the field. That namespace is reserved for
  members the system adds to a document (`_locale`, `_links`, `_translations`, and any future one), and
  closes a collision that nothing previously guarded.
- `delivery-static`: `delivery.publish` merges its result into `_delivery` instead of replacing it
  with `{ document, delivery }`, a member of the reserved underscore namespace (the index exports add
  `_indexes` and `_llmsFull` the same way). `delivery.publish` and `delivery.unpublish`
  take the document id from `result.id`/`params.id` or, when neither is present, from an event
  envelope's `payload.id`, so both can run as the first step of a pipeline an event triggers.
  `delivery.publish` answers `VALIDATION` (400) when no id is available; it used to throw, which
  surfaced as `INTERNAL` (500).
- Both event delivery modules gain the step `events.relay`, and `EVENT_DELIVERY_STEPS` lists it
  next to `events.emit`. Placed after a pipeline's last `events.emit:`, it reports how that run's
  own events were delivered and adds `_events: { status, pipelines: [{ event, pipeline, status,
  attempts, dead, error }] }` to the result — so a pipeline ending in an emit now has that member
  in its response and its OpenAPI schema. The step is not `atomicSafe`; boot rejects it inside an
  atomic group.
  - `events-direct`: the subscribed pipelines already ran, inline, during `events.emit`; the relay
    only reports the outcome (`attempts` is always `1`, `dead` is always `true` on an error, since
    nothing here retries). Recorded outcomes older than 60 seconds are dropped on the next emit,
    with one `warn` naming the count.
  - `events-queue`: the relay **delivers** the run's own rows inside the request, through the same
    `attempts`/backoff/dead-letter machinery the worker uses. A new config key `relayMs` (default
    5000, `0` disables the relay) bounds how long it may spend; a row it does not reach stays
    `pending` for the worker. `events_queue` rows gain a `runId` column, filled from the event
    envelope, and a row belonging to a run is written with `availableAt = createdAt + relayMs`
    instead of being immediately due, so the worker takes it only once no relay claimed it in time.
    `events.listDead` items gain a required `runId` field (`""` for a row that names none).
  - Both relays require `ctx.result` to be an object or `undefined`: a result that is already some
    other value (an array, a string, …) is a wiring error and throws, the same way
    `authz.listRoles` treats it.
  - `events-queue` gains a config key, `relayPipelines`: an array of pipeline names, or `"all"`
    (the default, the behaviour above unchanged for every subscribed pipeline). A row whose
    pipeline is left out of the list gets no head start (`availableAt = createdAt`, same as a row
    with no `runId`) and the relay never claims it by id, so it is the worker's from the moment
    the response goes out; `events.relay`'s `_events` report still names it, with a new fourth
    status, `"queued"` (`RelayEntry["status"]` in `@michaelthielemann/kestrel-contracts`), so a
    client can tell delivery is still pending. This is the setting for a pipeline whose delivery
    work must not run inside the emitting request (rendering image variants on upload, writing a
    login audit) while another subscriber of the same event keeps its head start. Naming a
    pipeline the booted manifest does not know, or one no event trigger runs, fails boot at
    `attach()`, naming the module, the pipeline(s) and which of the two it is. `events-direct` has
    no equivalent key: its delivery is inline by nature.
- `core`: `boot()` fails outright, with a `KestrelBootError` naming the pipeline and the step, for
  shapes it previously let through: a step that writes `result` without declaring `output`,
  `extendsOutput`, `extendsItems` or `binary: true`; an object schema inside one of those that
  declares `properties` without a `required` key (the error also names the JSON path); and a
  step's `extendsOutput` or `extendsItems` that cannot fold onto the active output schema.
  `extendsOutput` now merges into every branch of a `oneOf`/`anyOf` instead of silently collapsing
  it to the extension alone, and `extendsItems` merges into the list-shaped branches of a union and
  falls back to a root merge on the others; the error names the step, which of the two keywords it
  used, the reason, and, where relevant, the earlier step that set the active schema. The reason is
  one of: another type, a type array, a schema without a declared type, an `allOf` schema, `type:
  "object"` together with `oneOf`/`anyOf`/`allOf`, a schema with both `oneOf` and `anyOf`, a union
  with a non-object branch (a boolean branch included), an extension that is itself not an object
  schema, or, for `extendsItems` only, no list-shaped branch in the union, or list items that are
  not an object schema (a plain type or a union) at the root or in a union branch. Every one of
  these previously coerced silently instead of failing boot.
- `core`: `StepDescription` gains `terminalOutput`, the complete shape of `result` when a step ends
  the run with `ctx.done()` — never folded with any other step's `output`, `extendsOutput` or
  `extendsItems`, and never applied to a run that continues past the step. With `validateOutput`
  (always on in `testing/runPipeline`), a step that calls `ctx.done()` without declaring it, or
  whose early result does not match it, fails the run naming the step; a step that declares only
  `terminalOutput` but changes `result` without calling `ctx.done()` fails as well. Boot cannot
  detect a `ctx.done()` call, so a mismatch surfaces only at run time — add `terminalOutput` to
  every step that calls `ctx.done()`, the same schema as `output` when the early result has that
  shape, and declare `writes: ["result?"]` with no `output` for a step that only ever writes
  `result` through `ctx.done()`. Boot fails for `terminalOutput` on a step with no write to
  `result`, and for `terminalOutput` together with a `binary` step in the same pipeline.
- `redirects-default`: `redirects.lookup`, which declared no `output` at all, now describes its hit
  as `terminalOutput`: `{ redirect: { to, status } }`, with `status` narrowed to
  `301 | 302 | 307 | 308` and the schema closed (`additionalProperties: false`). The 200 of a route
  running it already published the page; it now also documents this redirect shape, combined as
  `anyOf`, and generated types become a union.
- `media-default`: `media.upload`'s 200, `oneOf[item, list]`, is now `anyOf` as well: the continuing
  branch (after `events.relay`) carries the item or list result plus `_events`, and the idempotent
  `ctx.done()` paths — which never reach `events.relay` — carry the item or list result alone.
  `_events` is therefore not on every member of the union; a client narrows with `'_events' in res`,
  the only way TypeScript narrows a union like this, not `res._events`. Responses themselves are
  unchanged.
- `media-default`: the step `media.folderItems`, deprecated since 5.4.0 in favour of
  `media.listFolderItems`, is removed; call `media.listFolderItems` instead.
- `revisions-default`: `revisions.reassignAuthor` no longer reads `reassignTo` from the payload or
  the event hand-over itself. It declares `reads: ["verifiedUser"]` and requires a preceding step —
  `authn.verifyUser:reassignTo` or `authn.verifyUser:result.reassignTo` — to verify the target and
  write it there; a pipeline that omits such a step fails to boot naming both steps, instead of
  reassigning to an unverified target at runtime. `examples/minimal`'s `reassignRevisionAuthor` and
  `retryReassignRevisionAuthor` pipelines already run the verify step first.
- `Manifest` gains a required `warnings: BootWarning[]`, the same entries as `kestrel.warnings`, so
  `describe()` and `insights.readManifest` carry the boot warnings. Code that builds a `Manifest` by
  hand adds `warnings: []`.
- `new KestrelBootError(module, reason, code)` now requires a third argument, `code: BootErrorCode`;
  code that constructs a `KestrelBootError` directly (rather than catching one `boot()` throws) adds it.
- `core`: the `./dataflow` export path is gone. `checkDataflowCollecting` was only ever meant for
  `boot()`'s own use; `checkDataflow`, the throwing check pipelines already relied on, remains
  available from the package's main export.
- `core`: `Kestrel.steps` is now typed as the new exported `Steps` interface (`has`, `names`,
  `owner`, `list`, `resolve`) instead of the internal `StepRegistry` class. `register()` and
  `failedToRegister()` are boot-time-only operations with no reader outside `boot()` and are no
  longer part of the public type; code that only read a booted instance's steps is unaffected.
  `RegisteredStep`, already `list()`'s return type, is now exported alongside `Steps`.
- `site-default`'s `site.resolve` and `resolveLinks`, and `delivery-static`'s `delivery.publish` and
  its llms.txt and llms-full.txt exports, no longer fill an empty localized field from the default locale unless the
  default locale's own values pass the request's filter too (e.g. `status=published`); with no such
  default locale the field stays empty instead of showing a draft value — including a linked page's
  slug (`resolveLinks`, so a link no longer points at a path taken from a draft default locale) and a
  page's title/description in `llms.txt`/`llms-full.txt`. `_translations` now lists only the locales
  that pass the filter themselves. A locale that does not pass the filter itself was already never
  replaced by another one, and still isn't. A page that relied on inheriting a field, a link target's
  slug, or an `llms.txt` title/description from a default locale that is only a draft renders with
  that field, link or entry empty after upgrading; publish the default locale, or fill the field
  directly in each locale, to keep it.
- The same rule now also covers `content-default`'s `content.get`/`content.list` steps: whenever a
  step argument carries a fixed filter (e.g. `content.list:pages?status=published`, already what
  every shipped public read pipeline uses), `_translations` on the response is narrowed to the
  locales that pass that filter too. This is automatic wherever a public read pipeline's step
  argument already names the filter (as `content.list:pages?status=published` does); a consumer
  whose collection pipelines apply a public filter some other way (outside the step argument) must
  move it into the step argument for the narrowing to see it. The narrowing applies to every fixed
  filter alike, not only a public one: an editorial step such as
  `content.list:pages?status=draft` now reports `_translations` as "complete and matching that
  filter" too, not just "complete".
  `delivery-static`'s index exports re-check a source locale's own current values instead of trusting
  its `delivery_publish_status` row being `live` (that row can lag one failed or queued publish behind).
  `delivery.publish` removes a locale's previous static output once it can no longer be published at
  all (no slug of its own), instead of leaving the old file live at its old path. A step
  argument may no longer combine a fixed filter with `fallback=true`; boot refuses it, naming the
  step and pointing at `site.resolve` — `fallback` is status-unaware by contract, so a filtered read
  must never use it. Every `site@1` implementation must follow the fallback/`_translations` rule now;
  the shared contract suite (`@michaelthielemann/kestrel-contracts/site.contract.test`) tests it.
- **Every media file has exactly one public URL, and the API returns it.** `media-default` stores an
  original under `<prefix><id>/<name>`. `media.upload`, `media.get`, `media.list` and `media.update`
  return it as `path`, `<publicPath>/<id>/<name>` (new config key `publicPath`, default `"/media"`).
  Renaming or moving an item and renaming a folder change metadata only: no blob moves, and neither
  the key nor `path` changes. `filename` starts out equal to `<name>` and is the display name from then
  on. A name is still unique within its folder; a clash answers 409 with `details.field: "location"`
  (was `"key"`).
  - The declared content type must be exactly one media type — `type/subtype` of RFC 9110 token
    characters, optionally with `;` parameters, and no comma. A list such as
    `image/png; x=1, text/html`, which a browser would read as its last type, or an empty type answers
    415 (`UNSUPPORTED`). What is stored and written to the blob store is the lower-cased
    `type/subtype`, plus the `charset` of a `text/*` type when it is a token, lower-cased
    (`text/plain; charset=utf-8`); no other parameter survives. `allowedTypes`/`deniedTypes` and their
    entries are matched by the `type/subtype` alone, ignoring parameters and case on both sides:
    `image/svg+xml; charset=utf-8` is denied wherever `image/svg+xml` is, and an entry
    `IMAGE/SVG+XML; charset=utf-8` denies `image/svg+xml`. An entry `*/*` now matches every type, like
    `*`; it used to match none, so `deniedTypes: ["*/*"]` refuses every upload.
  - `<name>` is fixed at upload and never changes, except for a demotion to `.bin` (below); its one
    extension comes from the stored type, never from the uploaded name. A listed type — images, PDF, audio, video, plain text, CSV, JSON, office documents
    (DOC, XLS, PPT, RTF, DOCX, XLSX, PPTX, ODT, ODS, ODP) and archives (ZIP, 7Z, RAR, TAR), none of
    which a browser runs as a document — replaces the uploaded extension (`Photo 1.JPG` sent as
    `image/jpeg` is stored as `Photo-1.jpg`). Every other type gets `.bin` and keeps the uploaded
    extension in the stem (`x.html` sent as `image/x-foo` or `text/html` is stored as `x-html.bin`);
    its public copy is stored as `application/octet-stream`, and `media.serve` answers with that type
    too. Every other dot becomes `-`, so a name has exactly one extension.
  - An SVG is published as `image/svg+xml` only when its bytes passed `sanitize.svg`. `media_items`
    gains a `svgSanitized` column (rows without it read as `false`), which `media.upload` sets when its
    pipeline runs `sanitize.svg` before it with no step in between that declares a write to `files`
    — known from the pipelines at attach, never from the request. Any other SVG is stored and served
    like an unlisted type (`logo.svg` becomes `logo-svg.bin`, `application/octet-stream`, on
    `media.serve`, `media.download` and in the public copy), also once `publicCopy` and
    `sanitize.svg` are turned on later, and each write of its public copy logs a warning naming its
    id. A run the booted instance did not start (the `testing/runPipeline` helper) never counts as
    sanitising. With `publicCopy` set and SVG uploads allowed, boot fails unless every pipeline that runs
    `media.upload` runs `sanitize.svg` before it with no such step in between.
  - Every public copy — `media-default`'s upload and `media.syncPublic`, `images-default`'s variants
    and placeholders — and `media.serve`, `media.download` and `images.serve` take the `Content-Type`
    from `publicFormOf` (new, see Added), never from the stored value as it is, and the published name
    is the stored one. A name stored as `.bin` stays `.bin` and is published as
    `application/octet-stream`, also once the list holds its type, so the name and the type always
    agree for a static host that types by extension. Any other name that does not end in the extension
    its type is listed with — an SVG without the `sanitize.svg` record, a row already stored with a
    list or an empty type — is demoted: every `.` turned into `-`, plus `.bin`, published as
    `application/octet-stream`; `path`, `media.serve` and the public copy follow it. The list only
    ever grows.
  - An upload stuck in `uploading` for longer than `uploadStaleAfterMs` — its `ready` update failed, or
    the blob store threw — is released by the next upload of the same name, also without
    `publicCopy`.
  - An upload turns its row `ready` only while the row is still `uploading`. When `media.syncPublic`
    abandoned a stalled upload meanwhile, the upload removes what it wrote and answers `TRANSIENT`
    (503); uploading the file again succeeds.
  - A media item in any output no longer carries `key`, `checksum` or `status`.
  - Anonymous callers read media by id only: `media.list` without `ids`, and `media.listFolders`,
    answer 401 to a caller without an identity. Set `anonymousList: "all"` to allow listing the
    library anonymously.
  - The start-up key migration of `media-default` is removed. Setup refuses media stored by 5.x
    (keys `<prefix><folder>/<filename>`) and `images_variants` and `images_retired` rows without a
    `slot`, naming the storage migration and the command that runs it. `media-default:id-key-layout`
    converts the media offline (`kestrel upgrade migrate --db <file> --blobs-dir <dir>`, or
    `kestrel update`); `images-default:variant-slots` fills in the slots, also at start-up with
    `storageMigrations: "apply"` (see Added).
  - New step `media.serve` answers a file at its public URL (`params.id`, `params.name`), cacheable
    for a year as `immutable`; any other name is 404. `media.download` answers with the same type as
    `media.serve` (see above), so an unlisted type is a download there too.
  - `media.remove` and `media.removeFolder` delete the copy and the blob first and the row last, then
    sweep the item's files once more. A failed blob delete now fails the step with the blob store's
    error; it used to be logged. `media.removeFolder`'s result gains `ids`. Run `images.remove` /
    `images.removeMany` after them, not before.
- **Image variants have their URL before an image can be used.** New step `images.plan` decides each
  size's format, extension, width and height from the original and makes every variant path answer
  with the original's bytes and type until the rendered variant replaces them at the same path. With
  a queue-style delivery module, placing and rendering are separate jobs connected by the new event
  `images.planned`, so an item never waits for a render to become usable; with inline event delivery,
  `images.generate` renders straight into the paths and a size it could not render is placed and
  rendered by `images-default`'s background loop right after the request. `images.attach` adds `available` per
  item: `false` while an image still lacks a variant path, and such an item lists no variant; an
  output never names a path without a file. Variant rows gain the state `planned` (never in an
  output); an attached variant carries its final `width`/`height` and `path` in every state. A variant
  that fails keeps answering with the original instead of 404; an image that cannot be decoded gets
  its variant paths the same way, and its rows turn `failed` only once those paths exist. A size
  whose format changes, and a pruned size, keep their old path answering with the original's bytes
  until the item is deleted (new collection `images_retired`); a format change moves the size's own
  row to the new path, so an item never has two rows for one size. `original`-format sizes render
  as JPEG for types other than JPEG, PNG, WebP and AVIF; every render has exactly the planned
  dimensions, and `cover` keeps the declared aspect without enlarging. `images.serve` answers a
  size's current file and every file a format change or a prune retired, and 404 for any other file;
  until a render is at the path, and after a render failed for good, it answers with the original's
  bytes and type (header `x-kestrel-variant: original`) instead of 404. Variants are generated for
  `ready` media items only. `publicPath` must be `/` followed by path segments, without a trailing
  `/`.
  - `images_variants` gains a unique `slot` (`<mediaId>/<size>`) and `images_retired` a unique `slot`
    (`<mediaId>/<file>`): the store keeps at most one row per item and size, so two planners of one
    item at once create one set of rows.
  - `retryFailed`'s return type `RetriedFailures` is renamed `RetiredFailures`. `Images.failure()` and
    its `VariantFailure` return type are removed; a variant's failure is visible on its own row
    (`state: "failed"`) instead of a separate lookup.
  - A plan or a render re-reads its media item after writing; when the item was deleted meanwhile —
    in this process or another — it removes what it wrote. `images.remove` waits for a plan or a
    render of the same item already running in this process.
  - A missing original is a data problem: `images.plan` and `images.generate` answer `INTERNAL` (500)
    for it instead of `TRANSIENT`, unless the item was deleted meanwhile. The repair pass in
    `images.resume` and the sync job log an item they cannot place or render and go on with the next
    one; `images.resume` resumes a stalled sync job either way. The repair pass reads only media items
    created in the last 24 hours.
  - A failed write of a rendered variant, private or public, counts an attempt like a failed render,
    so a size whose copy cannot be written gives up after `maxAttempts` instead of being retried for
    good.
  - Whether an item gets variants, and the format of an `original` size, are decided by the media type
    without parameters, ignoring case: `image/svg+xml; charset=utf-8` gets no variants, and neither
    does any other XML image type (`image/foo+xml`), which a browser would open as a document.
  - A sync job that cannot start after a size-set change is logged instead of being dropped.
  - `images.remove` stops a render of the same item in this process after the size it is rendering,
    instead of waiting for every size.
  - `images-default` raises its own event `images.variantsChanged` (`{ id: null, ids, identity: null,
    params: {} }`) through `events@1` for items it made available, after `images.prune`, and for items
    whose variants changed because a size was added or its spec changed. It declares the event in
    `emits` and uses `events@1` optionally. It never raises `media.updated`, which stays the fact of a
    pipeline that edits a medium: a pipeline that re-renders what shows media subscribes to both, as
    `mediaDependents` does in `examples/minimal`.
  - When a size is added or a size's spec changes (via `images.register` or at start), `images-default`
    notices and its background sync places the new or changed variants of every existing image.
- **Public copies.** `media-default` and `images-default` gain an optional `publicCopy: { prefix }`.
  With it, each module keeps a copy of every ready original and every variant path at
  `<prefix><publicPath without the leading "/">/<id>/<name>` and `…/<id>/variants/<size>.<ext>`. The
  copy is written by the step that makes the file visible — upload, variant planning and rendering
  including the background sync job and retries — and removed when the item is deleted. A failed copy
  fails that step like a failed blob write. New steps `media.syncPublic` and `images.syncPublic`
  reconcile the copies with the stored items and add `_publicMedia` / `_publicVariants` to the result;
  `media.syncPublic` also treats an upload stuck longer than the new `uploadStaleAfterMs` (default 15
  minutes) as failed, and `images.syncPublic` plans missing variants and starts a sync job that
  renders unrendered ones. Both syncs page through their rows by id, so rows deleted or added during
  a run never make them skip another, and `images.syncPublic` also reads a file's owner again right
  before it removes the file, so a concurrent upload, plan or delete never costs a live item its copy.
  Setup fails when the copy location overlaps the module's own `prefix`; boot fails
  when `publicCopy` is set and no pipeline runs the module's serve step, or when a pipeline runs a
  `syncPublic` step without `publicCopy`.
- `StepDescription` gains an optional `anonymous: "required"`: the step's output is also published
  without an access check, so every pipeline running it must let an anonymous caller through. With
  `publicCopy`, `media.serve` and `images.serve` declare it. `authz-roles` checks it when attached and
  fails boot, naming the pipeline, the step and the permission anonymous callers lack, the step
  that requires a signed-in caller, or the missing `authz.require` step: such a pipeline without any
  `authz.require` fails boot as well. Another `authz@1` provider has to make the same check itself.
  `insights.readManifest`'s output schema follows the new field.
- A binary step result may now set its own `cache-control`; without one, or with an empty one,
  responses stay `no-store`.
  `media.serve` uses it to mark an original `immutable`; `images.serve` keeps `no-store`, because a
  variant path changes content when its render replaces the original's bytes.
- **`delivery-static` no longer handles media.** The `media` option is removed — a config that still
  sets it fails validation — and with it the rewriting of media URLs in rendered output, the copying
  of media into the output prefix and the reads of `media_items` and `images_variants`. Rendered
  output is stored byte for byte. `rewriteMedia`, `MediaMatch`, `MediaConfig` and
  `contentTypeByExtension` are no longer exported from `./impl`. Pages reach media through the URLs the
  API returned; set `publicCopy` on the media modules instead. New option `reservedPaths`: a page, or a
  renderer asset, whose path equals or lies under one of them is not written, and the page's status is
  `error`. Every asset is checked before the page is written, so such a publish leaves the live page
  as it was.
- `blobstore-filesystem` replaces a file atomically (a temporary file in the same directory, then a
  rename), so a reader never sees a partly written file. Keys ending in `.kestrel-tmp` are rejected.
  The temporary name has a fixed length, so a key's last segment may still use the file system's
  whole name limit.
- **`authz-roles`: what anonymous callers may do, every signed-in caller may do too.** `can`, and with
  it `authz.require` and `authz.describePipelineAccess`, grants a permission to a signed-in caller when
  its roles grant it or when `anonymous` grants it. A signed-in user whose roles lack `media.read` was
  refused (403) a medium that an anonymous visitor could read; it is now served. A deployment that
  relied on signed-in users being refused something anonymous callers may do must remove that
  permission from `anonymous`. `authn-multi`'s last-admin guard asks the same `can`, so granting its
  `adminPermission` to `anonymous` makes every user an administrator.
- `images-default` requires `media@1` and reads media only through it. A config with
  `images-default` and no `media@1` provider fails boot (`missing-provider`); its `media` option
  (`media.collection`) is removed, so a config that still sets it fails boot; `createImages` takes
  `deps.media`. The module's setup hands `createImages` only a persistence handle limited by
  `ownedPersistence` to the collections it stores, exported as `COLLECTIONS` (`images_sizes`,
  `images_variants`, `images_jobs`, `images_retired`, `images_hidden`, `images_framing` and
  `images_items`), which throws a wiring error for any other collection; `createImages` uses the
  handle it is given as it is.
  - `images.generate` and `images.retryFailed` answer 404 for an item that is not ready (an upload in
    flight, a failed upload, an item being deleted); they answered 200 with no variants.
  - The sync job's `total`, `done` and `failed` count the ready items that get variants, not every
    media item, and its cursor is the provider's.
  - Which items get variants is one rule, `ELIGIBLE` (`image/*` without `image/gif` and
    `image/*+xml`), used both by the module and for the provider's `scan` and `count`, so the size-set
    check at start begins a sync only for a real shortfall. A type that is not exactly one media type
    no longer gets variants.
  - A placeholder, a retired path and `images.serve`'s fallback carry the `publishedType` the provider
    reports for the original. `images.export:<dir>` skips variants of an item that is not ready. A
    ready item whose provider lost its bytes fails a plan or render with
    `images: the stored bytes of media/<id> are missing`, naming no storage key; an item whose delete
    began while it was planned or rendered ends that work quietly instead of failing `INTERNAL`.
- `contracts`: the package exports its contracts, helpers, testing fakes and the shared contract
  suites, each suite listed by name (`@michaelthielemann/kestrel-contracts/<name>.contract.test`), and
  nothing else. Its own unit tests are neither built nor published; any other `*.test` subpath answers
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- `http.healthPath` answers from `kestrel.health()`: the body is `{ ok, restartRequired }`, and the
  status is 503 while a module reports `restartRequired: true`, 200 otherwise (also while `ok` is
  false). `uptimeSeconds` is gone from the body. A probe that expected `{ ok: true }` on every 200,
  or 200 on every request, reads the new body and status.
- **Field grants in `authz-roles`.** `anonymousFields` (resource → field paths) and `fields` (role →
  resource → field paths) say which fields of an answer a caller keeps; the new step
  `authz.fields:<resource>?shape=<item|list|array|file>`, last in a pipeline, cuts the answer to them.
  A caller without an identity, or with one that holds no configured role, keeps its resource's
  `anonymousFields` (403 where there is none); any other signed-in caller keeps everything unless every
  one of its roles has a grant for the resource, and then the union of those grants and the anonymous
  one. Boot fails when a pipeline anonymous callers reach over HTTP does not end with the step, when
  `anonymousFields` grants nothing for its resource, when the pipeline's declared output does not fit
  the shape or `?shape=item` cuts a `{ items, total }` answer as one object, when a grant names a
  field no pipeline of that resource declares or a resource no
  pipeline cuts, or when the pipeline can end earlier with an answer the anonymous grant or a role's
  grant does not cover. Add the step and the grants to every pipeline your anonymous
  callers read; `examples/minimal` shows the lists, and `kestrel-upgrade`'s `pipelines/field-step`
  proposes them. An anonymous caller of the example receives no `createdAt` or `updatedAt`, and no
  media item's `folder`, `available`, `variantCounts` or variant `bytes` and `state`.
- A step that throws answers `"<pipeline>/<step>: unexpected <ErrorName>"` as its `error`, for every
  caller, instead of its message; the message and the stack are in the log under the answer's `runId`.
  A failure a step returns with `ctx.fail` keeps its message. `testing/runPipeline` called without a
  `logger` answers `"<pipeline>/<step>: <message>"`, so a failing module test still names the cause;
  with a `logger`, the message is in its log. The log entry of a thrown step carries `message` next to
  `stack`.
- A step that ends the run with `ctx.done()` without declaring `terminalOutput` fails the run with
  `INTERNAL` in every mode, not only under `validateOutput`, and never answers the early result.
- OpenAPI: the 200 of an operation ending with a narrowing step is `anyOf`
  `#/components/schemas/<operationId>` and one `#/components/schemas/<operationId>.<label>` per
  audience (`.anonymous`, `.role.<name>`); types generated from the 200 become a union — use the
  components.
- The boot error for a step writing `result` without a declaration names `narrows` among the
  keywords that declare it.
- `redirects-default` requires `persistence@1`; a config loading it without a persistence provider
  fails to boot, naming the contract. It stores `redirects_auto_paths` and `redirects_auto_targets`.
  `Redirects.validate` returns a `Promise<Result>`, and `createRedirects` is async and takes `db`.
- `redirects-default`: a rule's `from` holds at most 8 wildcards and 512 characters, and a list at most
  1000 rules; saving more fails with `VALIDATION`, and on publish a stored rule over a limit is skipped
  and logged.
  `redirects.lookup` matches `from` in linear time instead of through the regex, with the same
  captures; a request path longer than 2048 characters matches no rule. Every entry of
  `redirects.json` and `redirects.render` carries `from` (the canonical wildcard path) next to
  `pattern`; a field grant for `redirectRules` names `from` to pass it on. The njs example matches
  `from` with the same algorithm.
- `links-default` resolves a URL's hostname before a check and requests it only when every address is
  globally reachable, connecting to the checked address; redirects are followed by hand, at most 5
  hops, each checked the same way (`private address`, `too many redirects`). Hostnames are compared
  without trailing dots, and the blocked ranges cover the IANA special-purpose ranges, including
  shared, benchmarking, multicast and broadcast addresses and IPv4 addresses inside IPv4-mapped,
  NAT64 and 6to4 IPv6 addresses. `Fetcher` receives `redirect: "manual"` and the checked
  `addresses` (the connection falls back from one to the next) and returns `headers` for `Location`; the default is `httpFetcher` (`node:http`/`node:https`)
  instead of the global `fetch`. `createLinksDefault` takes an optional `Resolver` after `now`.
- `links-default` stores at most `maxLinksPerDocument` links per document (default 1000) and marks a
  document with more by one report row carrying `LINK_LIMIT_ERROR`; extraction stops scanning at the
  limit and leaves out URLs longer than 2048 characters (`MAX_URL_LENGTH`). `links.check` works in batches of 100 rows, yields to the event loop between them, writes
  results by row, and ends after `checkBudgetSeconds` (default 3600), leaving the rest due for the
  next run; `urls` counts the URLs handled in the run. `Config` has both new fields.
- `media-default` treats an upload declared as an image type or PDF as the type its leading bytes
  identify when they differ: SVG or HTML markup sent as `image/png` meets `deniedTypes`, and PNG bytes
  sent as `image/jpeg` are stored as `image/png` with a `.png` name. `sanitize.svg` also sanitizes SVG
  markup declared as another image type. `images-default` hands an original to sharp only when its
  bytes are its stored type, passes `renderTimeoutMs` to sharp's own time limit (`Renderer` takes an
  optional `RenderOptions`), and renders no further size of an item in a run after a timeout.
  `helpers/mediaType` adds `sniffMediaType`, `verifiedMediaType` and `contentMatchesMediaType`. An AVIF
  file whose major brand is `mif1` counts as AVIF.
- `@michaelthielemann/kestrel-contracts`'s runtime helpers moved under
  `@michaelthielemann/kestrel-contracts/helpers/*`, no re-export left at the old path:
  `content-locale` → `helpers/content-locale`, `content-schema` → `helpers/content-schema`,
  `mediaType` → `helpers/mediaType`, `persistence.owned` → `helpers/persistence.owned`, `steps` →
  `helpers/steps`. Four old paths split between frozen surface (unchanged) and a helper (moved):
  `events.envelope`'s `eventEnvelope`/`parseEmitSpec`/`withEventIdentity` and `events.steps`'s
  `relaySummary`/`mergeRelayReport` → `helpers/events.envelope` (its `EventEnvelope`/`EventIdentity`
  types stay at `events.steps`, frozen with the step set they belong to); `stepSet`'s
  `defineStepSet`/`stepSets` → `helpers/stepSet` (its `StepSet` type stays at `stepSet`, frozen);
  `links`'s `collectInternalRefs` → `helpers/links` (`INTERNAL_REF`/`InternalRef`/`LinkTarget` stay
  at `links`, frozen); `persistence`'s `fieldDefinition` → `helpers/persistence`; `renderer`'s
  `renderFailed` → `helpers/renderer`; `migrations`'s `migrationFailed` → `helpers/migrations` (each
  contract's own interface and types stay at its unchanged path). `errors` stays at its top-level
  path. `kestrel-upgrade`'s new `imports/contract-helpers` rule rewrites a consumer's import
  specifiers automatically, splitting an import statement that names both a frozen and a moved
  symbol; it reads a project's `.vue` files too (their `<script>`/`<script setup>` block only), and
  reports — rather than silently skipping — a namespace, default, side-effect, `export *` or dynamic
  import of one of the seven split paths, and a file it cannot parse at all. The contracts package's
  own README states which of its exports are frozen contracts and which are helpers, additive-only
  within a major.
- `blobstore-s3` refuses a plain `http://` `endpoint` outside loopback (`localhost`, `127.0.0.0/8`,
  `[::1]`) with a config error at boot. The new option `allowInsecureEndpoint: true` accepts it for a
  trusted network and logs a warning at every boot.
- `replication-sqlite` names a new generation by its time, an order key, the time its snapshot was
  taken and 20 random hex digits (`<prefix>gen/<time>-<order><taken><random>/…`); generations of the
  same second sort in the order they were taken, so a snapshot key cannot be guessed from the time it
  was taken; generations named by the time alone are still listed, restored and pruned. The READMEs of
  `media-default` and `blobstore-s3` list every key family on the blobstore and which of them may be
  public (`site/*` only), with an example bucket policy.
- `replication-sqlite` refuses to rebuild a missing database at start when a generation named by its
  time alone and without `origin.json`, as 5.x releases name every generation, sorts after the newest
  generation that this version wrote or that carries `origin.json`. Restoring it would start from data
  this version never wrote; the error names the generations and how to go on. A replica written only by
  5.x releases restores its newest generation as before.
- `replication-sqlite`: the `Replication` interface of `./impl` gains `seal()` and `restoreHandled()`;
  an implementation of it outside this package has to add both.
- `replication-sqlite`: the `Replication` interface of `./impl` gains `settled()` and `quiesce()`; an
  implementation of it outside this package has to add both.
- `examples/nginx-njs` proxies to the origin over `https://` with certificate verification and passes
  `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`; `ORIGIN_UPSTREAM` defaults to `origin` (port 443).
- Forwarding headers count only from a trusted proxy. The new `http.trustedProxies` (also an option
  of `createKestrelHandler`) lists the peers, as addresses or CIDR ranges, whose `trustedHeader` or
  `X-Forwarded-For` is read; it defaults to loopback, and a connection without a peer address (a Unix
  domain socket, an in-process call) counts as loopback. A request from any other peer is attributed
  to the peer's own address for `ctx.ip`, `http.allow` and rate limits. A proxy on another host must
  now be listed, otherwise every request is attributed to the proxy. `trustedHeader` takes the value
  the proxy set last instead of the first. The core server answers 403 to a request from a trusted
  proxy without the trusted header, with or without `http.allow`, except a `GET` of `http.healthPath`,
  which is answered and judged by its peer address so load-balancer probes keep working; the h3
  adapter leaves `ctx.ip` absent for such a request. A request from an untrusted peer that carries the
  forwarding header is logged once per peer and hour (`forwarding header from <peer> ignored`), and
  `kestrel upgrade`'s new info rule `http/trusted-proxies` names a config with `trustProxy` or
  `trustedHeader` but no `trustedProxies`. **Upgrading:** if your proxy does not connect over loopback,
  set `http.trustedProxies` to its address or network before deploying 6.0.0. New exports:
  `clientIpResolver`, `forwardingWarner`, `LOOPBACK_PROXIES`, `ClientAddress`, `ForwardingWarnerOptions`,
  `PeerRequest`; `clientIp` accepts any request with `headers` and `socket`.
- A `multipart/form-data` body is limited per request by the new `http.multipart`
  (`maxParts` 120, `maxFiles` 20, `maxFields` 100; the h3 adapter's `multipart` option): the core's own
  multipart parser reads it part by part, and the first part past a limit answers 413 before it is
  decoded. The `Content-Type` parameters are parsed per RFC 9110; a malformed or repeated parameter, a
  missing `boundary` or a body without its closing delimiter answers 400. A file part's name follows
  the HTML form encoding (`%22`, `%0D`, `%0A` decoded), its content type is lowercased and defaults to
  `application/octet-stream`. A route whose
  pipeline has no step reading `files` answers 415 (`UNSUPPORTED`) to a multipart body without reading
  it. Boot marks each route with `files`; new exports `MultipartLimits`, `DEFAULT_MULTIPART_LIMITS`,
  `isMultipart`, `multipartRefusal`, and `parseRequestBody` takes the limits as a third argument.
- A request whose path has a `.` or `..` segment, literal or percent-encoded, answers 400 on the core
  server and in the h3 adapter instead of being routed to the resolved path (new export
  `hasDotSegment`). The h3 adapter exports `routedPipeline(event)`, the pipeline a request was routed
  to, for a handler that wraps it.
- `authn/multi` stores a session under the SHA-256 digest of its token instead of the token itself,
  and issues tokens of 32 random bytes (base64url). A copy of the database — a replica, a backup —
  holds no token that authenticates. Sessions stored in the earlier plain format are removed when the
  module starts, so everyone signed in logs in once more after the upgrade. `authn/single` issues
  tokens of the same shape.
- A request body is parsed as JSON only when its `Content-Type` says so (`application/json` or
  `application/*+json`); a non-empty body of any other type, or without one, is answered
  `415 UNSUPPORTED` before a pipeline runs, by the built-in server and by `kestrel-h3` alike. Send
  `content-type: application/json` with every JSON body.
- `authn/single` and `authn/multi` set the session cookie themselves: `authn.login` answers with
  `Set-Cookie: __Host-kestrel_token=…; Path=/; Max-Age=<sessionTtlSeconds>; HttpOnly; Secure;
  SameSite=Strict` and `authn.logout` removes it; a cookie named `kestrel_token` is no longer read, so
  everyone signed in through a browser signs in once more. A `POST`, `PUT`, `PATCH` or `DELETE` authenticated by that cookie
  must come from the same origin (`Sec-Fetch-Site: same-origin`, or an `Origin` matching `Host`), or
  `authn.identifyUser`/`authn.requireUser` answer `403 FORBIDDEN`; bearer requests are unchanged. The
  new config option `secureCookie` (default `true`) drops `Secure`, and with it the `__Host-` prefix
  (the cookie is then `kestrel_token`), for development reached over plain HTTP from another host;
  browsers accept the `Secure` cookie on `http://localhost`.
- `authn.setPassword` refuses the caller's own account with 400; one's own password changes only
  through `authn.changePassword`, which needs the current one. The step now reads `identity?`.
- A signed-in account without a configured role may only sign out and read its own identity. New step
  `authz.requireRole` (401 without an identity, 403 without a configured role); `authz-roles` fails boot
  for every pipeline in which a step declaring `security: "required"` (such as `authn.requireUser`) is not
  followed by it before the first step outside `authn.*`, `authz.*` and `ratelimit.*`, unless the new config option `rolelessPipelines` (default `["me", "logout"]`) names the
  pipeline. `kestrel upgrade`'s new `pipelines/require-role` inserts the step. On public pipelines such an
  account is served like an anonymous visitor.
- `media.list` without `ids` and `media.listFolders` need the new `listPermission` (default `media.list`)
  when an `authz@1` module is loaded, instead of any signed-in identity; 403 otherwise. `media.*` grants it.
  `kestrel upgrade`'s new `authz/media-list` adds it to each role in authz-roles' config that grants
  `media.read`.
- The media trash changes exported types of `media-default` and `images-default` (`/impl`):
  `MediaStatus` gains `"trashed"`, so an exhaustive `switch` over it needs the case; `MediaItem` gains
  `trashedAt` and `trashVersion`, and its `location` is `null` while the item is trashed, so code that
  reads it as a string needs a check; `Media` gains `trash`, `trashFolder`, `restore`, `listTrash`,
  `trashIds`, `selectTrash` and `purge`, and `Images` gains `hide`, `show` and `hidden`, which a
  hand-built implementation or test double must add. `kestrel upgrade`'s `types/breaking-signatures`
  names them.
- Focus and crop change exported types of `images-default` (`/impl`): `Images` gains `setFraming`
  and `framingsOf`, and `Variant` gains `crop`, `renderedCrop`, `renders`, `originalWidth` and
  `originalHeight` (`""` or `null` for the centre, `0` or `null` for no render yet or unknown
  dimensions), which a hand-built
  implementation, test double or variant row must add. `Planned` gains `crop`: a `Renderer` passed
  to `createImages` as `deps.render` must cut `planned.crop` from the original after its EXIF
  orientation before it resizes, or a framed size records a crop its bytes do not have. `kestrel
  upgrade`'s `types/breaking-signatures` names them.
- `images-default`'s config must set `renderTimeoutMs` below `staleAfterMs` (the defaults are 30000
  and 60000); a config that does not fails boot, since a render could outlast the lease on its item.
  `kestrel upgrade`'s `modules/images-render-timeout` reports (manual) such a config, defaults
  included.
- `redirects-default`: a redirect source may not take a path the application serves itself. The new
  config key `reservedPaths` (default `["/admin", "/api", "/media"]`) lists the prefixes; the editor
  refuses a `from` that equals, lies below or, through a wildcard, can match one of them
  (`/admin`, `/admin/x`, `/*/login`; `/administration` stays allowed) with `VALIDATION` and the row.
  A rule whose first segment is a wildcard, such as `/*/old-page` for every language prefix, is
  refused too; write one rule per prefix. A rule already stored under such a path is left out of
  `redirects.json`, `redirects.lookup` and `redirects.render` and logged. An automatic redirect from a
  reserved path is left out of the same three, but only `redirects.json` and `redirects.render` log it. Set `reservedPaths`
  to the mounts of your own project. `kestrel upgrade data`'s `data/redirect-reserved-paths` lists the
  stored rules and the stored automatic redirects an upgrade would leave out, wildcard sources such as
  `/**` included.
- The two admin routes that repeat a user's cleanup, `POST /admin/users/:id/revisions/reassign` and
  `POST /admin/users/:id/audit/anonymize`, answer 409 `CONFLICT` while `:id` still names a user,
  active or not, so they can no longer rewrite the revisions or erase the audit trail of an existing
  account. The guard is the new step `authn.requireAbsentUser`, which reads `params.id` and is
  `atomicSafe`, and refuses an id that is not a UUID with 400 `VALIDATION`, so the routes cannot be
  aimed at a username or a step name. An id in UUID form that names no user passes, whatever else it
  identifies; a project that exposes `revisions.reassignAuthor` or
  `audit.anonymize` on a route of its own should run it first. Each successful run raises `user.revisionsReassignRetried` or
  `user.auditAnonymizeRetried`, which `examples/minimal` records through an `auditUsers` pipeline, so
  the log shows who ran the repair without naming the deleted user. Both routes now end in `events.relay`, so their responses carry `_events`.
- `audit.anonymize` refuses an id that is not a UUID with 400 `VALIDATION` and leaves the entries
  alone, so an id that is no user id, such as a username or a step name, can never match a param value
  of another meaning. User ids of `authn-multi` are UUIDs; a project with another auth module whose
  ids have a different form has to anonymise through its own step. It still clears the identity id and
  every param that holds the user's id, whatever the param is called.
- `persistence@1`'s `findMany` has three overloads (`withTotal: false` answers a page without `total`).
  A custom `Persistence` provider or a wrapper that assigns `findMany` as an arrow function without
  parameter types no longer compiles, since the parameters are typed from all three overloads at once
  (TS2322). A wrapper that does not pass `withTotal` on types its parameters explicitly
  (`<T extends Document>(collection: string, filter: Filter, options?: FindOptions)`); one that does
  declares the three overloads the contract lists and implements them in one function, as
  `persistence/sqlite` does. A test double can use `vi.spyOn(persistence, "findMany")` instead. Callers
  are unaffected.
- `media-default` removes metadata from JPEG, PNG, WebP and GIF files before it stores them: EXIF
  with the GPS position, XMP, IPTC, comments, text chunks, embedded thumbnails and trailing data, so a
  published original no longer reveals where and with what a photo was taken. Pixels, colour
  profiles and animation are copied byte for byte, and the EXIF orientation stays as the only tag.
  Second pictures go with the metadata: an Ultra HDR photo loses its gain map and a motion photo its
  video, and both are stored as plain SDR images. The stored file, its `size` and its checksum are
  those of the stripped bytes. A JPEG, PNG, WebP or GIF is recognised by its bytes, whatever type the
  upload declares. New option
  `stripImageMetadata` (default `true`; `false` restores the earlier behaviour of storing uploads as
  sent, so a consumer that relies on the copyright or credit fields of an original sets it). Files
  uploaded earlier keep their metadata, and uploading a file again to the place where it is stored
  still answers the existing item, with the option on or off. While the option is on, a file that
  differs only in its metadata is answered as the existing item as well, provided the stored file
  has no metadata; a file with other metadata at the same place is a conflict when the stored item
  keeps its metadata or the option is off. `MediaItem` (`/impl`) gains `sourceChecksum` (the
  sha256 of the bytes sent when they differ from the stored ones, otherwise `null`), which a
  hand-built implementation or test double must set. AVIF, HEIC, TIFF and other image types
  are stored as sent and keep their metadata.
- `authz-roles`: **a caller kept to a field grant sorts a list only by a field it receives.** For a
  pipeline ending with `authz.fields:<resource>?shape=list`, a request whose `sort` names a field the
  caller's grant does not name whole (a member the grant names only in part, a hidden field, a name that is
  no member such as `constructor`) answers `400 VALIDATION` instead of ordering by it, because the order of a
  list shows what the grant withholds. `id`, `createdAt` and `updatedAt` stay sortable for every caller,
  also where the answer leaves the two timestamps out, so `?sort=-updatedAt` keeps working on public lists.
  A caller whose roles have no field grant for the resource sorts by anything.
- `authz-roles`: **`anonymous` takes only read permissions.** An entry that is not `<name>.read`
  (`"*"`, `"pages.*"`, `"pages.write"`, `"media.list"`) fails boot with
  `anonymous may hold only read permissions such as "pages.read"` and the path of the entry. Grant a
  wildcard or a write to a role instead.
- **A query parameter that names a member of a step's body schema answers `400 VALIDATION`.** The payload
  merges the query with the body, but a step's `input` schema only checked the body, so `?roles=admin&roles=admin`
  gave `authn.updateUser` (with an empty body) or `authn.createUser` (next to the credentials) roles its schema never
  saw, and `POST /admin/migrations/apply?dry=true`
  applied the migrations for real because `dry` is a body flag. The runner now refuses such a parameter before the
  step runs (`details.problems` names it) unless the step lists the same name in `describe().query`;
  `content.create`, `content.set`, `content.update` and `content.validate` do for `locale`, which stays valid in the
  query. A parameter the body schema does not describe is still ignored; the four content steps
  leave such a key (`?_=1`) out of the document. A custom step whose `input` and query use
  the same name declares it in `query`; `migrations.apply` reads `dry` from `ctx.body`.
- `sanitize-svg`: **an attribute holding a `url()` that does not point to a `#fragment` of the same file
  is removed** (`fill="url(http://…)"`, `filter`, `mask`, `clip-path`, `marker-*`, a `url()` with quotes or
  spaces, a `data:` or protocol-relative target), together with any attribute other than `font-family` whose value
  quotes a string outside a `url(#…)`, calls `image-set()`, `-webkit-image-set()`, `cross-fade()`, `element()`,
  `image()` or `src()`, or uses a CSS escape.
  `fill="url(#gradient)"` and every other attribute are unchanged. `style` and `<style>` stay removed.
- `validate-jsonschema`: **the HTML sanitizer gives every link whose `target` is not `_self` (in any
  case) `rel="noopener noreferrer"` and removes `opener`** (`target="_BLANK" rel="opener"` and
  `target="win1"` were left open), keeps other `rel` tokens such as `nofollow`, and drops an `href` or `src`
  starting with `//` or a backslash pair. `data:` stays allowed only in `img[src]`; a scheme is read as a browser
  reads it, so `java<tab>script:` is refused.

### Added

- `kestrel upgrade` checks the stricter request and permission rules of 6.0.0 (the manual steps are in
  `docs/upgrading.md` § Rule reference):
  - `authz/anonymous-read-only` (error, manual) names every entry of `authz-roles`' `anonymous` that is not a
    `<name>.read` permission, the entries boot now refuses.
  - `pipelines/query-body-member` (warning, manual) names a step of the project's own modules whose function reads
    a member of its `input` schema from the query (`ctx.query`, or a `query` taken from the context) without declaring
    it in `describe().query`, and every undeclared `input` member of a step on a `GET` or `HEAD` route, where the
    query is the only place a member can come from. An info finding names an HTTP pipeline running
    `migrations.apply`, whose `dry` is a body flag. A step built by `stepFactory` is checked per argument.
  - `runtime/sort-field-grant` (info) names each HTTP pipeline ending a list with `authz.fields:<resource>?shape=list`,
    where `sort` is now restricted to the fields the caller's grant names, and each running `content.list`, where a
    name that is no field answers 400.
  - `runtime/user-cleanup-guard` (warning, manual) names an HTTP route running `audit.anonymize` or
    `revisions.reassignAuthor` without `authn.requireAbsentUser` before it.
- `contracts`: `helpers/html-allowlist` holds the one allowlist for HTML shown to visitors: the lists
  `HTML_ALLOWED_TAGS`, `HTML_ALLOWED_ATTRIBUTES`, `HTML_ALLOWED_SCHEMES`, `HTML_IMG_SCHEMES`, the pattern
  `HTML_ID_PATTERN`, `isAllowedHtmlUrl(tag, attribute, value)` and `normalizeHtmlAttributes(tag, attributes)`,
  which applies the link and id rules above to one element. The file has no imports, so server-rendered pages and
  browsers can apply the same rules as `validate-jsonschema`, which builds its `HTML_ALLOWLIST` from it.
- **5.x media are converted, not discarded.** New helper `helpers/shape-migrations` in
  `kestrel-contracts` runs a module's storage-shape migrations in dependency order and by the release
  that introduced them, verifies each and then records the module's storage version in the
  collection `kestrel_storage_versions`. A run that stops halfway is finished by running it again; a
  second run writes nothing; data newer than the release, or older than a module converts, is
  refused (`update through <major>.x first`). A cleanup migration runs only in a run that selects
  the kind `cleanup`, also after the version was recorded; an `ask` migration waits for an answer to
  each of its questions, and the run lists those still unanswered. Blobs are copied through an injected `BlobOps`
  (`copy`, `head`); `blobOpsOf` builds one from any `blobstore@1`.
  - `media-default` exports `./storage` (`storage(config)`, `migrations`), `images-default` exports
    `./storage` (`storage()`, `migrations`).
    `media-default:id-key-layout` copies each original a 5.x release stored under
    `<prefix><folder>/<filename>` to `<prefix><id>/<name>`, checks size and sha256, switches the item
    and fills in a unique `location` (a name its folder already holds becomes `<stem>-<n>.<ext>`). The
    old blob stays and its key is recorded in `media_legacy_keys`; an item whose original is missing
    is kept and reported, and its old key is recorded too. `storage(config, { sanitizeSvg })` cleans each
    5.x SVG with the given sanitizer and stores it as `<stem>.svg`, `image/svg+xml`, with `svgSanitized`
    set, `updatedAt` set to the time of the run and the same id (`svgSanitized`). A 5.x SVG the sanitizer refuses, one whose original is
    missing (unless the one `.svg` file in its `<prefix><id>/` folder that no item uses as its key is a cleaned copy an earlier run
    wrote, which the sanitizer answers unchanged), and every 5.x SVG without a sanitizer becomes `<stem>-svg.bin`, served as
    `application/octet-stream`; the run lists each one with the reason (`svgDemoted`), and uploading it
    again through `sanitize.svg` serves it as an image.
  - `images-default:variant-slots` fills in the `slot` of 5.x variant and retired rows, keeping the
    newest finished row of a slot and reporting the rows it drops.
  - Both modules take `storageMigrations: "check" | "apply"` (default `check`). `check` refuses to
    start on data in an older shape and names the migration and the command that runs it
    (`kestrel upgrade migrate --db <file> --blobs-dir <dir>`, or `kestrel update`); `apply` runs
    migrations that write no blobs. A migration that writes blobs, such as the media conversion,
    never runs at start-up.
  - `media.reconcile` and `media.reconcileDelete` gain `legacyKeys`: the recorded 5.x blobs, reported
    apart from `blobsWithoutRow` and never deleted.
  - `kestrel upgrade migrate --db <file> --blobs-dir <dir> [--root <dir>] [--plan] [--answers <file>] [--originals-gone] [--media-prefix <prefix>] [--json]`
    converts a copy of the database and of the filesystem blob store in place, offline and without
    network access: it runs the storage migrations of every module whose collections the database
    holds, from the `./storage` export of the module package the project has installed (found from the
    project or one of its direct dependencies), through the project's own `persistence-sqlite` and
    `blobstore-filesystem`. Old blobs stay where they are; a second run changes nothing; a run after an
    interruption continues where it stopped. `--plan` only detects and counts. An item whose original is
    not under `--blobs-dir` stops the run before anything is converted, with exit `2`, until
    `--answers` answers `media-default:id-key-layout:missing-original` with `keep` or `trash`; when no
    original is found at all and `--blobs-dir` holds no blob under the media key prefix, it names what
    `--blobs-dir` holds and stops whatever the answers say, unless `--originals-gone` confirms that it
    is the root of a store whose originals are all lost; the answer then applies to every item. A database SQLite cannot open for lack of space or write access next to
    it is named as such, apart from one that fails `quick_check`. The module
    configs come from `kestrel.config.ts`, or through the project's host plugin when that file does not
    load by itself; when neither loads, migrate stops with exit `2` before converting anything, unless
    `--media-prefix` names the prefix. Each 5.x SVG is cleaned with the project's own `sanitize.svg`
    step, set up offline with its module config, and keeps its id and stays an image; one the step
    refuses, whose cleaned root element is not in the SVG namespace or whose original is missing, and
    every 5.x SVG of a project without that step, is kept as a `.bin` download and named. A module registering `sanitize.svg` that cannot be set up without other
    modules, whose config does not parse, or whose config schema boot refuses (an older `sanitize-svg`),
    stops the run with exit `2` before anything is converted, and so does a store with a 5.x SVG when
    the config or a module entry does not load and no loaded entry registers `sanitize.svg`, or when
    `--root` holds no `kestrel.config.ts` and no host plugin loads the project, also
    with `--media-prefix`. A `sanitize/*` module whose `describe()` lists no `svg` step is neither
    parsed nor set up. `kestrel upgrade data` warns with `data/media-layout:config` in
    that case. It neither takes nor
    honours the instance lock, so a lock file left next to the copy does not stop it. Exit `0` when
    every module is in this release's shape, `1` when a migration is still pending or the stored data
    is older or newer than this release reads, `2` when the run could not start, an original is
    missing without an answer, no original is found without `--originals-gone`, or a migration failed. `docs/upgrading.md` § "Converting the stored media".

- `replication-sqlite` documents its replica layout as a storage format (README, "Replica layout") and
  adds three files to a generation. Teardown writes `sealed.json` (`{ lineage, lastFrame, segments, at }`)
  once the frames committed since the last sync are shipped; only the newest generation of a process that
  stopped through teardown carries one, so a newest generation of the stopped process without one shows a
  stop that may have lost frames. A start that rebuilds the missing database lists the replica again, for
  up to five seconds, while the newest generation's listing lacks a WAL segment its seal names, or a newer
  generation named by its time alone shows `origin.json` without a snapshot, and refuses to start when it
  still does. A tool that places a database into the replica writes the snapshot and then `origin.json`; a
  start that rebuilds the missing database from such a generation reports the restore through
  `replication.checkRestored`, so `delivery.checkBuild` renders every output again. It rebuilds the file
  into `<file>.rebuilding` and renames it into place only after the `<file>.restored-at` sidecar records
  the restore, so a start that stops in between leaves the rebuild to the next one. Once a pipeline run
  through that step, or through `backup.checkRestored`, which reads the same report, ended without
  failure, the first successful sync or teardown seal after it writes `applied.json` naming the generation
  and the `nonce` of `origin.json`, and without such a step in any pipeline the first successful sync or
  seal does; until then every generation the process starts carries a copy of `origin.json`, written ahead
  of its snapshot, so a start that stops earlier leaves the restore reported to the next one. A start that
  restores a generation whose listing shows `applied.json` does not report the restore again; one whose
  listing does not show it yet reports it once more. Whether a generation carries `sealed.json` or
  `origin.json` is read from the blobstore, not from a listing, since teardown writes the last segment and
  the seal one after the other and a listing that shows new keys late hides both; `applied.json`, which
  the module writes itself, is never read. `./impl` exports `listReplica()`, `listSealedReplica()`,
  `markerKey()`, `readOrigin()`, `readOriginNonce()`, `unplacedNewerGenerations()` and the types
  `GenerationMarker`, `Seal`, `Origin`, `Applied`, `PlacedRestore`, `ReplicaListing` and
  `SealedListingOptions`; `restoreFromBlobs()` takes an optional fifth argument `listed`, the points of a
  listing already made, instead of listing again; `ReplicationOptions` gains `logger`, `listedBefore`,
  `placedRestore` and `onAcknowledged`.
- `replication-sqlite` notices another process writing to the same replica: a snapshot or WAL segment it
  did not write, outside a generation placed with `origin.json`, that the listing the start restored
  from (or else the first sync's listing) did not show, logs a warning and makes `health()` answer
  `{ ok: true, note }` until the process restarts. Health stays ok, so that a readiness probe does not
  restart the process into the other process's data.
- `audit-persistence` has the step `audit.recordActor`: like `audit.record` it persists an event, but
  only with the event, its time, the caller and the client address, leaving out the params and the id
  that name whom the event was about.
- New package `@michaelthielemann/kestrel-ops`: verified backups and restore for an instance with
  `replication-sqlite` and S3-compatible storage. A backup takes the database from the replica, copies
  every original the media rows reference and the delivery prefix into write-once objects
  (server-side, guarded by the listed ETag) and is verified from the backup location: hash, full
  `integrity_check`, row counts, entry counts and delivery keys against the manifest, an entry and
  object for every referenced original, and a hashed sample. A restore stops the app, reports what it discards, including access it would bring back
  (which needs the explicit answer `access-changes`), takes a `pre-restore` backup, copies originals
  back without deleting any, sets the delivery prefix to the backup's, ends every login session and
  promotes the database as the newest replica generation under a plain time name from the store's
  clock, with `origin.json` next to it, and reports `applied` once the runtime writes `applied.json` into that
  generation with the same nonce, which it waits for up to `update.syncWindowSeconds` (default 120 s) after the
  app is ready; when none appears in that time it reports `unconfirmed` with exit 0 and a warning naming the key
  to look for and the app's log to check, and for a runtime before 6, which writes no `applied.json`, it reports
  `unconfirmed` at once with a warning that the app does not render its output again. The seal, origin and acknowledgement files use the formats
  `replication-sqlite` defines; listings, server-side copies into the backup location and the store's
  clock go through the admin client of `kestrel-blobstore-s3`. Neither a backup nor a restore holds or writes the instance-lock file
  next to the database. Also `status`, `backup list|verify|prune` with retention per
  kind, `restore --to local`, a `local` target, credentials from environment variables or commands
  that never reach any output (lines for a person are masked; the documents the tool stores and its `--json`
  output hold no credential value, except a plain value, the start command or the health check endpoint of the recorded configuration when it holds a credential shorter than 16 characters neither as a token of its own (neither preceded nor followed by a letter, a digit, `_` or `-`, nor by a run of `.` and `/` with such a character beyond it) nor as the user or password of a URL, and mask only their free-text fields `message`, `error`, `failure`, `detail`
  and `problems`, wherever a credential occurs there, so a credential that is part of a fixed text, such as the access key `kestrel`, leaves every schema, key and name in them intact; in terminal lines, questions and messages, the questions and their ids, command names, flags, environment names and ids the tool writes itself stay as written when a credential equals one of their words, while a credential in an answer to a question, an error of the store, an answer of the platform, the output of a command or a table, user or host name read from the data is masked, and one of 16 characters or more everywhere), a
  journal and lock trace in the backup location, a clock measurement and a protection probe of `status` whose
  probe object a key without delete rights leaves behind with a warning instead of failing (`backup prune` removes probes older than an hour where
  its credentials may delete them and leaves the others with a warning, still pruning the backups that are due;
  `docs/operations.md` lists the permissions per prefix), and `writeBundle()`
  for a self-contained runner in a deploy artifact that carries the target adapters it needs.
- `kestrel-h3`'s `createKestrelHandler` takes a `logger` and writes one `http` line per request
  with the fields of the core server's line (`runId`, `requestId`, `method`, `path`, `pipeline`,
  `status`, `ms`, `ip`). A request refused before its pipeline (unknown route, dot segment, body too
  large, unreadable body, unsupported content type, body cut off by a closed connection or the
  request timeout) gets a line too, with a `reason` and, for a body too large or cut off, the
  `declaredBytes`. A line holds no body, no cookie, no query string and no header value except a
  valid `X-Request-Id`, the declared `Content-Length` and the client address derived under the peer
  policy. A handler that throws writes a line with status 500 and answers with that line's
  `X-Kestrel-Run-Id` and the echoed `X-Request-Id`.
- The core server's `http` log line also covers requests answered without running a pipeline:
  unknown route (404), dot segment, unreadable body (400), client refused by `http.allow` (403),
  body too large (413, with `declaredBytes`), unsupported content type (415), a CORS preflight (204)
  and a failing handler (500), each with a `reason`. The line of a 500 carries the run id of the
  response. A body the client stops sending is logged as `body not received: connection closed`
  (400), one ended by `http.timeouts.requestMs` as `body not received: request timeout` with the
  408 Node answers. In both HTTP paths `path` is the URL path alone, also for an absolute-form
  request target, so neither its host nor its userinfo reaches the line.
- `bodyRefusal(err, req, requestId)` maps an error from `readRequestBody` or `parseRequestBody` to
  the answer and log reason both HTTP paths use; `httpLogLine(entry)` builds the fields of the
  `http` line.
- With `corsOrigin` set, the core server allows the `X-Request-Id` request header and exposes
  `X-Kestrel-Run-Id`, `X-Request-Id` and `Retry-After` to the browser; a preflight answer carries an
  `X-Kestrel-Run-Id`.
- `kestrel check`, `kestrel explain` and `kestrel manifest` inspect a project without starting it,
  in a sandboxed scratch copy, through the project's own core. `check` lists every load issue, boot
  problem, warning and not-checked item with module and cause (`--json`, `--fail-on`) and is meant
  as a CI gate. `explain <pipeline>` / `explain --event <name>` shows steps, atomic groups, emitted
  events, the relay, listeners and their delivery (direct, or queue with lane and relay), as text,
  `--json` or `--mermaid`. `manifest` prints `describe()` of the checked project.
- `kestrel upgrade`'s new info rule `runtime/single-process` names every `persistence-sqlite`,
  `replication-sqlite` and `backup-blobstore` entry that takes the instance lock on its database file,
  once per entry, and stays quiet for a database that takes no lock (in-memory or temporary, in any
  spelling the lock itself accepts) or `allowConcurrentProcesses: true`.
  `types/breaking-signatures` names `MediaItem.sourceChecksum`.
- `@michaelthielemann/kestrel-upgrade` gains the subpaths `./hosts` (`scanHosts`,
  `loadHostPlugins`, `selectHostPlugin`), `./project` (`loadBackendProject`, which takes the
  project core's loaders as an optional third argument) and `./scratch` (`createScratchCopy`,
  `removeScratchCopy`); `./sandbox` also exports `mergeSandboxEntries`. `./plugin` adds
  `UpgradePlugin.hostChecks`, `KestrelPluginHost`, `HostProblem`, `KestrelPluginFactory`,
  `RunUpgradeCliOptions.hosts`, `PLUGIN_API_MIN`, and the engine's `parseArgs`/`stringFlag`.
- A `step-argument`, `describe-threw` or `step-not-function` problem of a pipeline step also names
  the module that registered the step in `BootProblem.module`, next to `pipeline` and `step`.
- `checkBoot()`'s result carries `manifest`, the checked engine's `describe()` output, taken before
  teardown and present also when problems were found.
- `media/default`'s `media.list` accepts a `type` query (`image`, `video` or `other`), matched against
  each item's content type with the contracts package's `mediaTypeMatches` (`other` is neither
  `image/*` nor `video/*`). `image`/`video` filter at the store; `other` cannot be expressed as a
  store filter, so it scans every ready item in scope instead, in batches of 500, before paging and
  counting in memory, the same way an unindexable text search already does.
- A `kestrel.config` module entry accepts `defaults: { from, values }`: values a host supplies on the
  consumer's behalf. Boot merges `config` over them (plain objects key by key, everything else
  replaced whole) before parsing, and an invalid result names the defaults' source.
  `ConfigVariable` gains an optional `source`: a path only the defaults carry reports
  `status: "default"` with `source` set to `from`, and a path `config` sets stays `set`. The insights
  manifest schema lists `source`. `ConfigDefaults` and `effectiveModuleConfig()` are exported.
  `kestrel-upgrade` rules read the merged config of each entry.
- `StepDescription.narrows` (`NarrowsDeclaration`: the answer's `shape` and, per audience label, the
  member paths it keeps) declares a step that only removes members of `result`; boot accepts it as
  the declaration of the `result` write; under `validateOutput` the answer after it must be a
  member-wise subset of the answer it received. The insights
  manifest schema describes it.
- `authz-roles`' `./impl` exports `fieldSet`, `answersOf`, `anonymousPipelines` and
  `fieldGrantProblems`.
- The OpenAPI extension `x-kestrel-answers` on a 200 maps each audience label to its component, or
  for a file operation to the response headers the audience receives.
- `kestrel-upgrade` rules `pipelines/field-step`, `authz/field-grant-unknown`,
  `responses/anonymous-fields` and `responses/thrown-error-text`; `pipelines/media-serve` creates its
  serve pipelines ending with `authz.fields:mediaFile?shape=file`.
- `references-default`: a target can be `{ media: true }`, the ready files of the `media@1` provider
  (`optional: [media@1]`; setup fails naming the target when no module provides it). A file counts as
  existing exactly while `media@1` reports it as ready. `examples/minimal` uses it for its `media`
  target instead of `{ collection: "media_items" }`; `{ collection }` stays for a consumer's own
  collections and must not name another module's.
- `@michaelthielemann/kestrel-contracts/mediaType`: `parseMediaType`, `mediaTypeEssence` and
  `canonicalMediaType` (a declared content type that is exactly one media type, as its lower-cased
  `type/subtype` and a `text/*` type's charset, else `null`), `publicFormOf` (the `Content-Type` and
  extension a stored type is published with), `mediaTypeMatches` and `mediaTypeAllowed` (the
  `allowedTypes`/`deniedTypes` pattern rule: `*` and `*/*` match every type, `type/*` a top-level type,
  `type/*+suffix` every subtype of a top-level type that ends in `+suffix` (`*/*+suffix` of every
  top-level type), any other pattern one type, case and parameters ignored) and `EXTENSION_BY_TYPE`, shared by
  `media-default`, `images-default` and any client that checks a type before uploading.
- `@michaelthielemann/kestrel-contracts/media`: the `media@1` contract (`MediaFiles`: `file`, `files`,
  `load`, `scan`, `count`), read access to the ready files a media provider stores. Only a ready file is
  ever visible — all its bytes stored, its removal not begun — and readiness is the provider's alone.
  `scan` and `count` take a `MediaFilter` (`types`, `excludeTypes` as `allowedTypes`-style patterns,
  `createdSince`); `scan` pages with a cursor that resumes in another process and stays exact when
  files come and go between pages. Its suite `media.contract.test` (`mediaContractTests`), which
  also pins that no answer comes from a cache kept across calls, and the in-memory fake
  `testing/fakeMedia` (`createFakeMedia`, with `addPending`/`markReady` for a file not ready yet) come
  with it.
- `@michaelthielemann/kestrel-contracts/persistence.owned`: `ownedPersistence(db, owner, collections)`,
  a `persistence@1` view that reaches only the named collections and throws a wiring error naming the
  owner for any other, before the store is asked.
- `@michaelthielemann/kestrel-contracts/content-locale`: `satisfiesFilter`, `publishedLocale` and
  `narrowListTranslations` — the shared rule behind the two entries above, for any module that
  builds a public view on top of `content@1`. `satisfiesFilter` decides membership through
  `content.list` itself, so a `Condition` entry (`{ in: [...] }`, `{ ne: ... }`, …) is evaluated
  with the store's own semantics instead of being reimplemented, and never turns into a false
  negative or a thrown error at request time — including when `filter` names a field the type does
  not declare (an internal link to a type outside the filter's model, such as a settings singleton
  with no `status` field, is simply unserved: `resolveLinks` marks it broken, the same as before),
  and when `id` is missing on a multi type, which is `false` rather than "does any document pass".
  `narrowListTranslations` chunks its `in` list at 500 ids, so a page larger than that sends several
  bounded queries per locale instead of one unbounded one. `publishedLocale` reads with `content@1`'s
  own `fallback: true` once more at the default locale too when `fallback` is requested there, so
  `_locales` (the per-field origin map) still comes back the same as a direct `content@1` read would.
- `core`: `resolveResultSchema` (`@michaelthielemann/kestrel/schema`) reports every shape a
  pipeline's `result` can end in: the folded `output`, then each step's distinct `terminalOutput`,
  as one `anyOf`; `kestrel-openapi` publishes a route's 200 through it.
- `insights`: the manifest schema describes `terminalOutput` and `atomicSafe` (the latter was
  missed when `atomicSafe` was introduced). Its schema-valued step-description members are now open
  objects (`{ type: "object", additionalProperties: true }`) instead of a bare `{ type: "object" }`,
  so generated types read them as `{ [key: string]: unknown }`.
- `authz-roles`: the factory step `authz.validateRoles:<path>` reads an array of role names at
  `payload.<path>` and rejects it with 400 `VALIDATION` (unknown names in `details.unknown`) unless
  every entry is a configured role name; an absent value passes. It writes nothing and needs no
  attached instance. `examples/minimal`'s `createUser` and `updateUser` pipelines now run
  `authz.validateRoles:roles` right after `authz.require:users.manage`, so a role name typo no
  longer creates or updates a user silently. A pipeline that omits the step still boots and works
  unchanged — it simply does not validate role names.
- A step may now declare a trailing `?` in `reads`, not only in `writes`: an optional read does not
  require the key to be available at boot, either from an earlier step or from the trigger. Boot
  still rejects a pipeline where a *later* step writes that key, since the read would then always
  see nothing — the same `checkDataflow`/`KestrelBootError` mechanism as an undeclared or
  unsatisfied read, naming the pipeline, the reading step, the writing step and the key.
  `revisions.record` declares `revisionParent?` and `revisions.reportRestore` declares
  `restoreReport?`, closing a gap where both read a context key no `describe()` named.
- `core`: `boot()` returns non-fatal conditions as `kestrel.warnings: BootWarning[]`, in addition to
  logging them through `logger.warn`. `BootWarning` is a discriminated union on `code`; a future
  minor release may add further codes, so code reading `kestrel.warnings` must handle one it does
  not recognize. Two codes ship: `unemitted-event`, for an event trigger whose event no pipeline
  emits via `events.emit` and no module declares in `emits`; and `unwritten-optional-read`, for an
  optional read (`"key?"`) whose key no registered step writes and no trigger provides — almost
  always a typo in the key — naming the pipeline, the step and the key.
- `authn-multi`: the factory step `authn.verifyUser:<path>` looks up the user id at `payload.<path>`
  — a plain path, no fallback between locations — rejects an unknown or inactive one (404
  `NOT_FOUND` / 400 `VALIDATION`), and writes the canonical `{ id, name }` to a new context key,
  `verifiedUser`; a given name, if any, is never trusted. Absent or `null` writes `null`. It
  verifies a user reference generically: `authn.verifyUser:reassignTo` reads `payload.reassignTo`,
  `authn.verifyUser:result.reassignTo` reads `payload.result.reassignTo` (an event hand-over
  shape), and its `input` schema follows the path. It does not check the caller, so an HTTP
  pipeline needs its own `authn.requireUser` and `authz.require` in front of it.
- `Deps` gains `bootStartedAt?: number`, the epoch ms `boot()` captured at its very start, before
  any module's `setup()` ran, and shared by every module's `setup()` call in this boot. Optional,
  so a `Deps` built outside `boot()` still type-checks. `replication-sqlite` and `backup-blobstore`
  declare `before: [persistence@1]` and use this field to judge whether their database or backed-up
  file was created during the current boot (see "Changed" below).
- New package `@michaelthielemann/kestrel-events-direct`: inline event delivery, split out of
  `events-inmemory`. Requires `events@1`, provides the event trigger hook and `events.emit`.
- `@michaelthielemann/kestrel-contracts` gains `defineStepSet`/`stepSets`
  (`contracts/stepSet.ts`): a declared step set names a role (e.g. `events.delivery`), the step
  prefix it governs and the exact steps every provider of that role registers. `AUTHN_STEPS` and
  the new `EVENT_DELIVERY_STEPS` (`events.emit`, `events.relay`, `events.readDeliveryStatus`) are
  collected in `STEP_SETS`. The generated
  README step tables and the new `docs/step-portability.md` mark every step as portable (a set
  member), beside (under a governed prefix but not a member) or none.
- `@michaelthielemann/kestrel-contracts` gains `EventIdentity`, `EventEnvelope`,
  `withEventIdentity` and the shared `eventDeliveryStepTests` suite (`events.envelope.ts`,
  `events.steps.contract.test.ts`), so `events-direct` and `events-queue` produce and verify the
  same `events.emit` envelope from one implementation.
- `core`: new `boot({ validateOutput })` (default off) and `testing/runPipeline` (always on)
  validate `ctx.result` after every step that writes it against the pipeline's output schema
  folded up to that point (`@michaelthielemann/kestrel/schema`'s new `resolveOutputSchema`,
  subpath-only), failing with the step name and the JSON path on a mismatch. A step whose write is
  declared optional (`result?`) and left `ctx.result` unchanged is skipped. `validateOutput`
  defaults to off, so production pays nothing for it unless a deployment opts in.
- `authz-roles`: two new steps. `authz.describePipelineAccess` writes `result.pipelineAccess`, one
  entry per booted pipeline: `granted` when the caller passes every `authz.require:<perm>` step of
  that pipeline, `denied` when it fails one, `unknown` when the pipeline has none. The decision is
  the one `authz.require` makes, including the `anonymous` grants when the context has no identity,
  so a client can hide what it may not run without a copy of the role table; the answer lists every
  booted pipeline, so the step belongs behind `authn.requireUser`. `authz.listRoles` writes
  `result.roles`, the configured role names in config order; it performs no check of its own and is
  meant to sit behind an `authz.require:<perm>` step, so only callers who may already manage the
  instance learn the role table. `examples/minimal` has a `listRoles` pipeline (`GET /roles`, behind
  `authz.require:users.manage`). `./impl` also exports `requiredPermissions` and `PipelineVerdict`.
- `core`: a module can declare a synchronous `health(instance)` hook, with no I/O, that reads its
  own state instead of the outcome of a call: `{ ok: true, note? }` or
  `{ ok: false, reason, restartRequired }`. `kestrel.health()` aggregates every declaring module
  into `{ ok, restartRequired, modules }`, reachable on the booted `Kestrel` and through
  `Introspection` in `attach()`. A hook that throws lists its module as
  `{ ok: false, reason: "health() threw", restartRequired: false }` and logs the error once per
  module; `kestrel.health()` itself never throws. `persistence-sqlite` reports the store unusable, with
  `restartRequired: true`, once a rollback has failed and left a transaction open, a group's or the
  one `createMany` runs for its own transaction outside a group; contention is never reported. A `createMany` whose `ROLLBACK`
  fails answers that unusable state's `Err(TRANSIENT)` itself, or rethrows the wiring error it
  rolled back for. Every call, group, `checkpoint()` and `snapshot()` already waiting for its turn
  when a rollback fails answers the same `TRANSIENT` instead of running on the connection.
  `replication-sqlite` reports a prepared restore as `{ ok: true, note }`, since the instance
  keeps serving until a host restarts it to apply the restore.
- `images-default`: `images.attach` also adds `variantCounts: { done, pending, error, failed }` to a
  media item or list, tallying the effective sizes owned by `images-default`'s own eligibility rule
  (an image, not SVG, not GIF) and size list: a size with no row yet, or a `done` row whose spec is
  outdated, counts as `pending`; a row for a size nobody declares any more is ignored. All zero for a
  non-eligible item, the same as an empty `variants[]`. Declared `required` in `attach`'s
  `extendsItems`, next to `variants`.
- Every event delivery module registers `events.readDeliveryStatus`, answering `{ dead, scope,
  since, lastDeadAt }`: the deliveries the module gave up on. `events/queue` counts its dead-letter
  rows across every process (`scope: "store"`); `events/direct` counts the failed deliveries of the
  process that answers, since it started (`scope: "process"`). `EVENT_DELIVERY_STEPS` lists it next
  to `events.emit` and `events.relay`. A failed delivery never makes `health()` report the instance
  unhealthy.
- `core`: `checkBoot(input, { setup })` (root export) runs every check `boot()` runs and returns
  every problem as data instead of throwing at the first one: `errors: BootProblem[]` (`errors[0]`
  is what `boot()` throws), `warnings: BootWarning[]`, and `notChecked` for a module or pipeline a
  problem it depends on made impossible to check safely. `setup` has no default —
  `setup()`/`attach()`/`teardown()` reach whatever storage the selected modules' config names — and
  is `"none"` (no module code beyond `configSchema`), `"all"`, or `{ only: [...] }` naming the config
  `use` entries allowed to run. `KestrelBootError` gains a `readonly code: BootErrorCode`; codes are
  covered by semver from 6.0.0, `reason` and every message text are not. Per-item loaders
  (`loadModule`, `pipelineFiles`, `loadPipelineFile`) let a caller load a project file by file and
  keep going after one failure.
- A new package, `@michaelthielemann/kestrel-upgrade` (bin `kestrel-upgrade`, commands `check`,
  `fix`, `data`), finds the 5.8 -> 6.0 breaks a project meets, previews a mechanical fix for the
  ones it can edit, asks about the ones a person must decide, offers switching event delivery to
  the queue where the project can support it, and reads a database copy for the checks only stored
  data answers. `fix` shows a unified diff per file and asks `y`/`n`/`d` before writing; without a
  terminal, `--write` needs `--yes` or is refused. Questions are answered over a real
  `node:readline` prompt, from `--answers <file>`, or from `--yes`'s defaults — a question with no
  safe default stays open regardless, and an answer that does not match a closed set of choices is
  rejected rather than passed through. It never installs, commits, pushes or reaches the network;
  see `docs/upgrading.md`. It exports a sandbox helper (`@michaelthielemann/kestrel-upgrade/sandbox`)
  that composes with `checkBoot()` for a CI gate, and a plugin API
  (`@michaelthielemann/kestrel-upgrade/plugin`) a host CLI registers its own project loader and
  rules through instead of shipping a second copy of the engine.
- `kestrel-upgrade`'s plugin API: `UpgradePlugin.load(root, scratch, cache)` returns `LoadResult`
  (`{ project?, issues }`), the same shape the built-in loader has, so a partial load failure surfaces
  as a `load/failed` finding instead of losing the rest of the project; `cache` is one `Map` shared by
  every `load()` call within a single `check`/`fix` invocation, so an expensive prepare step runs once
  per invocation, not once per re-ask round or edit preview. `UpgradePlugin.rules` merges into the
  built-in rules; an id colliding with a built-in one is a load error naming both, and that rule is
  dropped from the merge. `UpgradePlugin.sandbox` adds sandbox config rewrites keyed by a module-list
  entry's full `use` string, in any package scope or as a local path; a key the built-in table
  already rewrites is a load error naming the plugin and the key, and the built-in rewrite stays in
  force; a key that matches no module-list entry is a `sandbox/unmatched-entry` warning naming it.
  `sandboxBootInput`'s `entries` option takes the same keys and throws on a colliding one; its
  result's `unmatched` lists the keys that matched nothing.
  `PLUGIN_API_VERSION` (`1`) names the plugin API version, covering every type `./plugin` exports
  (`UpgradePlugin`, `LoadResult`, `LoadedProject`, `SwitchEditsResult`, `Rule` and its `needs`
  values, the rule contexts, `Finding`/`Edit` and the rest); a later addition to any of them is
  optional and raises it, and it never resets across majors. `createRuleContext(project,
  overrides?)` builds a `RuleContext` with defaults for a plugin's own rule tests.
  `locateSteps`/`locateModelFields` locate a pipeline's step array or a content
  type's fields object literal directly, for a project layout the built-in search does not recognize —
  additive, not a replacement: an empty result (or `undefined` from `locateModelFields`) falls back to
  the exact built-in search for that target, so a locator only answers for the layouts it actually
  recognizes. `dataModel?(root)` supplies the typed content model
  (`DataContentModel`/`DataContentType`/`DataContentField`) the `data` command's underscore-field
  counter needs for a project layout where it cannot be read from a `content-default` module's config;
  `check`/`fix` also derives `LoadedProject.contentModel` from it when `load()` did not set the field
  directly, and `DataContentModel.file` (falling back to `LoadedProject.configFile`) is where a
  verified-zero-count rename is spliced in. `switchEdits?(ctx, relayPipelines)` supplies
  `offer/event-queue`'s switch (edits as the all-or-nothing parts `combineEditParts` takes, plus
  deployment markers) for a project layout where events-direct is not a `kestrel.config.ts` module-list
  entry; the built-in rule always runs its own gates first (an open event-payload or emits finding, the
  serverless markers) and only asks the hook for the edits and any extra markers, adding them to its own
  rather than replacing them. Once the switch's edits are known (built-in or a plugin's), one boot
  preview of that full set is the sole authority on whether the switch actually happened — with or
  without a plugin: the offer blocks unless the booted module list shows events-queue and not
  events-direct, naming the plugin's own `switchEdits` when one supplied it. A literal
  `"...events-direct"` string, in any quote style and found by walking the parsed AST so a comment or a
  partial match never counts, decides nothing on its own; it only improves the blocker's message, naming
  the file and site to edit, so a module list built by a helper function or an imported constant is
  checked exactly the same way. `verifyEdits(edits, { pipelines })` is the
  diffed, higher-level form of the lower-level `previewBoot`: it folds a boot-preview error diff together
  with whether every named pipeline was actually checked, so a rule cannot mistake an unchecked pipeline
  for a verified one; a preview never applies an edit whose target lies outside its own scratch copy,
  even through a symlink (a package inside the copy's own linked `node_modules`, say), refusing and
  reporting a `preview/edit-refused` finding naming the path and the reason instead of a path escaping
  back onto the real project — a package a switch's own edits add but that is not installed yet stays on
  its own existing "install it" line, never this finding, since the preview genuinely reloaded. A hook
  that throws (`dataModel`, so far) surfaces as a `plugin/hook-failed` error finding naming the plugin
  and the hook, in `check`/`fix` and in `data`, instead of being silently swallowed. `AskFix.closedChoices:
  true` marks a question's `choices` as the complete, exhaustive answer set; only then is an answer
  validated against it, rejected rather than passed through when it does not match — a rejected
  `--answers` value exits `fix` with 2, naming the id and the value, on every `fix` run, `--write` or
  not, the same as an unknown id; a rejected TTY answer is asked again — a question whose `choices` are
  only a default or example is never validated, since the rule parses the raw answer itself.
  `pipelines/verified-user`'s path question is one such closed set: choosing "other" or "split
  manually" now goes manual (pick the path by hand) instead of re-asking the same question forever.
  `LoadedProject.pipelineFiles`
  is a list of `{ file, pipelines }`, more than one name per entry for a layout keeping several
  pipelines in one file, so a rule that walks every pipeline file reports at most once per file. A
  plugin's own `load()` (a config import, a prepare step) runs unconditionally, before any consent
  question — `--run-setup` only ever gates a module's own `setup()`. `--data-report`'s parsed content
  lands in the separate `LoadedProject.dataReport`, so a plugin's own `load()`-stored `data` survives a
  `data`-report run. The edit, verify and all-or-nothing combine primitives (`applyEdits`,
  `verifiesAfterEdit`, `combineEditParts`), the AST reading primitives a locator is written with,
  `insertPipelineStep`, `insertStepAfterEmitOutsideGroup` (and `emitStepIsLocatable`),
  `renameContentField`, `replaceModuleListEntry`, `insertTriggers`/`insertTrigger`,
  `createPipelineFile`/`newPipelineFileContent` and `swapPipelineSteps` are published from a
  `@michaelthielemann/kestrel-upgrade/codemods` export, so a plugin's own rule or locator never needs a
  second copy of this engine's edit machinery.
- `kestrel-upgrade` gains rules for the `media`/`images`/`delivery-static`/`authz-roles` change:
  `modules/delivery-media` auto-migrates `delivery-static`'s removed `media` option to `publicCopy` on
  `media-default`/`images-default` and a `reservedPaths` entry on `delivery-static`, falling back to
  manual when `reservedPaths` already has entries it cannot safely merge into;
  `modules/media-public-path` auto-fixes (warning) `images-default`'s `publicPath` not matching
  `media-default`'s; `pipelines/media-serve` scaffolds `serveMediaFile.ts`/`serveImageVariant.ts` and
  their HTTP triggers (auto) when the project has a pipelines directory to create them in, and reports
  (manual) an `authz-roles` `anonymous` list missing `media.read` for a `publicCopy` that needs it;
  `runtime/authz-anonymous-floor` reports (no fix) that a signed-in caller now also holds whatever
  `authz-roles`'s `anonymous` list grants; `imports/removed-export` reports (manual) custom code
  importing `rewriteMedia`, `MediaMatch`, `MediaConfig` or `contentTypeByExtension` from
  `kestrel-delivery-static/impl`, or calling the removed `migrateKeys`; `pipelines/media-repair`
  scaffolds `repairPublicMedia.ts`/`syncPublicMedia.ts` and their admin/cron triggers (auto) when
  `publicCopy` is set and neither `media.syncPublic` nor `images.syncPublic` runs anywhere;
  `pipelines/images-resume-cron` reports (manual) images-default configured without a cron-triggered
  `images.resume`; `pipelines/media-delete-order` auto-swaps `images.remove`/`images.removeMany` run
  before the `media.remove`/`media.removeFolder` they depend on, and reports (info) a
  `media.removeFolder` missing `events.emit:media.deleted` afterwards; `runtime/anonymous-media-list`
  reports (info) an anonymous `media.read` grant while `anonymousList` stays at its `"ids"` default;
  `responses/binary-cache-control` reports (info) a local module mentioning `cache-control` near a
  binary step result; `pipelines/images-plan` reports (manual) a pipeline calling `images.plan`
  directly, since the right replacement depends on delivery mode and lane adoption;
  `modules/images-media-option` removes (auto) `images-default`'s removed `media` option, an error for
  `media_items` and a warning for another collection whose owner must provide `media@1` now;
  `modules/references-media-target` turns (auto, warning) a `references-default` target on
  `media_items` into `{ media: true }` when `media-default` is configured, and reports (info) a target on
  any other collection; `events/images-variants-changed` reports (info) a pipeline on `media.updated`
  that does not also listen to `images.variantsChanged`.
  `types/breaking-signatures` and `responses/breaking-step-shapes` are extended for `Media`/`Images`'s own shape
  changes and the `media.*`/`images.*` steps affected. Three `data` command checks:
  `data/media-layout` (error) runs the detection of the storage migrations `media-default` and
  `images-default` export under `./storage` and names the pending migration and
  `kestrel upgrade migrate`, for data their `setup()` now refuses (a warning when the installed
  release has no `./storage` export); `data/site-media-leftovers` (warning, manual) names the entries still sitting
  under the 5.x delivery-static media export directory other than the `<id>/` directories of stored
  items, where `media.syncPublic` writes its public copies; `data/blobstore-tmp-suffix` (info) lists stored
  filesystem-blobstore keys already ending in the suffix 6.0.0 reserves for its own atomic writes. An
  edit can also create a brand-new file (a `create` edit, refused if the path already exists, or if a
  second edit races to create the same one) — how `pipelines/media-serve` and `pipelines/media-repair`
  scaffold their pipeline files. See `docs/upgrading.md`.

- `events-queue` coalesces: an event whose data carries a string `coalesceKey` is queued at most
  once per subscribed pipeline and key while an earlier row of that key has not started; a claim,
  by the worker, a lane's own loop or the relay, clears the key so a fresh event with the same key
  can be enqueued again once that row is running. A key found on some other, non-pending row (for
  example one a pre-6.0 process claimed without knowing the column) is cleared and the row written,
  instead of the event being silently dropped. When a row fails, only the newest pending row of its
  key is kept and the others are marked `done` (superseded) instead of being retried or
  dead-lettered, so repeated requests for the same work during an outage do not pile up retries and
  dead letters. Rows keep their key in a new `originKey` column, which no claim clears.
- `events-queue` runs named lanes: `lanes: { "<lane>": ["<pipeline>", …] }` gives each lane its own
  worker loop; a lane naming a pipeline the booted manifest does not know, or one no event trigger
  runs, fails boot at `attach()`, naming the lane and the pipeline. Each lane's loop claims and
  runs one row at a time, retrying at once rather than waiting `pollMs` when it loses a claim race
  to another process; a claim that instead fails outright (a persistence error) is logged and waits
  `pollMs`, never spinning. A due row of one lane never
  waits for a row of another lane or of the main loop (the implicit lane for every pipeline `lanes`
  does not name), and the relay never claims a lane row. Each lane's claim also reclaims that
  lane's own expired locks, so a crashed process's row is retried by its own lane without waiting
  for the main loop. The main loop re-scans, at most every 30 seconds in every process and again at
  once in the process that served it right after `events.retryDead`, for a lane it does not know of
  still holding a row, and starts that lane's loop; a lane found this way keeps its loop across that
  process's own later `stopWorker`/`startWorker` pairs too, so a lane dropped from the config (or a
  retried dead row of one) never strands its rows.
  `events.readQueueStatus` reports every lane this process currently knows of — configured, or
  found holding a row — with `pending`, `running` and `oldestPendingAt` under `lanes`.
- `events-queue` delays a pipeline's rows: `delayMs: { "<pipeline>": <ms> }` writes the rows of that
  pipeline, at `enqueue` and at fan-out, with `availableAt` that many milliseconds later. With
  `coalesceKey` this is a fixed window: an event with the same key joins the pending row without
  moving it, and the row runs once when the window ends. A delayed pipeline is never relayed and is
  reported `queued`. `attach()` rejects an entry naming an unknown pipeline or one no event trigger
  runs, and a delayed pipeline that an array `relayPipelines` also names. The README states that
  coalescing keeps the first event's payload.
- **Published outputs are refreshed when what they show changes.** `delivery-static` records, per
  output and locale, what its render read — the paths `site.resolveLinks` answered, and every read
  the renderer made through this instance in the same process — and `delivery.markDependents:<type>`
  marks every published output that read a changed document, a list the store now puts the document
  in, or a link whose path or published state changed; outputs whose dependencies are unknown are
  marked by every change, drafts never. Marked outputs are rendered at once and never inside the
  marking request: with `dependencies.render: "events"` as one `delivery.outputStale` job per output
  through `events@1` (`delivery.republishOutput`, coalesced by the queue), with `"background"`
  (default) by the module's own loop in the process that marked them. Renders time out after
  `dependencies.renderTimeoutSeconds`; a failed re-render keeps the previous output and is retried
  after `dependencies.backoffSeconds`, up to `dependencies.maxAttempts`. Every change and every
  removal of a path's files is numbered by a sequence in `delivery_state` and recorded in
  `delivery_changes` (the last 10 000 are kept); a render, in any process, that read something a
  change numbered after its start touched, or that wrote a path whose files were removed meanwhile,
  marks its output again once it has committed. No clock is compared.
  `delivery.markAll:<type>`
  marks every output of a type, `delivery.checkBuild` marks everything once per new `payload.build`
  and stores the build only after marking succeeded, `delivery.resumeStale` releases expired claims,
  removes tombstones and orphaned dependency sets and re-raises marks left behind,
  `delivery.retryStale` retries failed re-renders, and `delivery.readStaleStatus` answers
  `{ stale, failed, rendering, unknown, oldestStaleAt, abandoned }`. `readStatus` rows and `_delivery`
  gain `stale`, `staleSince`, `staleFailed`, `staleError` and `dependencies`. With `"events"`, boot
  fails unless triggers run `delivery.republishOutput` on `delivery.outputStale` and
  `delivery.exportIndexes` on `delivery.indexesStale` (plus `delivery.exportLlmsFull` on
  `delivery.llmsStale` with `llms.full`), and under `events-direct`.
- `delivery-static` writes `sitemap.xml` and `robots.txt` next to `llms.txt`.
  `delivery.exportIndexes` writes sitemap.xml, robots.txt and llms.txt from the database alone;
  `delivery.exportLlmsFull` writes llms-full.txt from the stored HTML. Both list every output that
  serves a file — `live`, or `error` with a path, so a renderer outage empties nothing — re-checked
  against its published document (read in batches of up to 50 documents per type and locale, with a turn
  of the event loop between two reads, so an export over a large site does not hold up requests and
  saves), without `noindex` pages, one entry per URL (the `live` row first),
  sorted by URL; while published documents exist but none has a rendered output, sitemap.xml and
  llms.txt are left as they are and robots.txt is still written. sitemap.xml has absolute `<loc>`s,
  `<lastmod>` from the document's `updatedAt` for `live` outputs, and `hreflang` alternates with
  `x-default` across a document's locales; while no page is listed there is no sitemap.xml, since
  the sitemaps.org schema needs at least one `<url>`. robots.txt takes `robots.policy` (`allow` or `disallow`;
  unset: `allow` under `NODE_ENV=production`, otherwise `disallow`, with a boot warning),
  `robots.extra` lines and a `Sitemap:` line when a sitemap.xml is written. With `sitemap: false` or
  without `siteUrl` there is no sitemap, one that still holds what an earlier export wrote is removed
  and one of the site's own stays; without `siteUrl` boot warns. Without `llms.full` an llms-full.txt
  is removed only while it holds what an export wrote. Unchanged files are not written again within a process.
  llms-full.txt is encoded, hashed and assembled in pieces of a few hundred kilobytes with a turn of the event loop
  between two pieces, so a file of many megabytes does not hold up requests and saves either.
  The result gains `_indexes: { entries }` or `_llmsFull: { entries }`, and
  `delivery.readStaleStatus` answers `exports: { indexes, llmsFull }` with each export's last `at`,
  `entries`, `error` and `skipped` (no list written because no output is rendered yet).
  `robots: false` leaves robots.txt to the site; a `siteUrl` with a base path warns at boot, since
  crawlers read robots.txt only at the host's root. `normalizeSiteUrl` and `pageUrl` from the dependency-free subpath
  `kestrel-delivery-static/site-url` give the URL form the sitemap uses, for a canonical link that
  must match it, also in page code that runs in the browser.
- `delivery.requestIndexes` asks for those exports without running them: coalesced
  `delivery.indexesStale` (`coalesceKey: "indexes"`) and, with `llms.full`, `delivery.llmsStale`
  events with `"events"`; with `"background"`, the loop exports the index files
  `dependencies.indexesDelayMs` (default 1000) after the first request, before its next batch of
  re-renders, retries a failed export with `dependencies.backoffSeconds` without holding up the
  renders (a new request still exports after its own window), and exports llms-full.txt once no
  render is due and no index window is open, letting a due index export run between the pages it
  reads. A re-render asks for llms-full.txt every
  time and for the index files only when the output's path changed or it started or stopped serving
  a file. `delivery.resumeStale` asks for the index files on every run and for llms-full.txt while
  its last export failed.
- `delivery.checkBuild` also renders everything again after a database restore with an unchanged
  build. The new steps `replication.checkRestored` (replication-sqlite) and `backup.checkRestored`
  (backup-blobstore) add `result._databaseRestoredAt`: the start of the boot that wrote the latest
  reported restore of the file, read from the `<file>.restored-at` sidecar, which gains
  `"reported": true` for such a restore, or `null`; put the one whose `file` is the database directly
  before `delivery.checkBuild` in the boot pipeline, since a step in between that writes `result`
  drops the member. Without one before it, no later step in that pipeline may write `result`: boot
  fails with `optional-read-order` for `["delivery.checkBuild", "delivery.resumeStale"]`. No trigger
  runs that pipeline at boot; the host runs it once after `start()` with
  `kestrel.run(name, { trigger: { kind: "event", name: "boot" }, payload: { build } })`, and without
  that run nothing is detected, exported at boot or removed as orphaned. A prepared restore (`replication.prepareRestore`, `backup.restore`) and
  backup-blobstore's restore of a missing file under `restoreOnStart` are reported, so on an
  ephemeral disk with backup-blobstore every start renders everything again. Both modules write the
  sidecar atomically before the restored file is moved into place. The check handles each value once
  and stores it in `delivery_state` last, so a restore whose boot stopped before the check or whose
  marking failed is handled by the next start, and logs a warning. replication-sqlite's rebuild of a
  missing file under `restoreOnStart`, unless the generation it restores from was placed with
  `origin.json` (replication-sqlite README, "Replica layout"), and a database file copied into place by
  hand are no restore here; run `delivery.markAll` for every delivered type after one. The result gains `restored`.
  `kestrel upgrade` reports a pipeline that runs `delivery.checkBuild` without a `checkRestored` step
  directly before it, offering the step of either module only when its `file` is the
  `persistence-sqlite` file (`delivery/restore-check`).
- `delivery.resumeStale` removes, once per database that held status rows at setup, page files under
  `prefix` at paths no status row has (left behind by older versions after a failed render and a slug
  change; listed under Breaking), logging each; it waits while outputs are marked or rendering, while
  no output is `live` or a published document has no `live` output, and until `delivery.checkBuild`
  ran in the process, gives up a run during which a page started to render, removes only
  paths a run at least `claimTtlSeconds` after the first still finds unowned, checking each one again
  right before its removal, removes nothing when more paths look orphaned than status rows own, and leaves the
  root page, renderer assets, media copies, `reservedPaths` and the paths at and below a directory
  that holds a robots.txt, sitemap.xml or llms.txt (another site below `prefix`) alone. A failure of this removal is
  logged and retried on the next run without failing the recovery pass. The result gains `orphans`.
- `@michaelthielemann/kestrel/reads`: `observeReads`, `noteRead` and `unobserved`, one read scope per
  async context kept on `globalThis`; `noteRead` keeps a plain JSON copy of what it is given, and only
  while a scope is open. `content-default` notes the documents, single types and lists it
  answers, `media-default` the media items, `site-default` the resolved document or missed slug
  lookup and one path per resolved link; `redirects-default`'s lookup is not noted.
- The `site@1` contract tests check that a `kestrel:` reference held by any field, also one the model
  does not declare, resolves; a third-party `site@1` provider has to pass that case too.
- `examples/minimal` re-renders the pages that show a changed page, the settings or a media item in
  the background (`pageDependents`, `settingsDependents`, `mediaDependents`, `resumeStalePages`);
  `setSettings` writes inside an atomic group and emits `settings.updated`, and `publishPage`,
  `unpublishPage` and `settingsDependents` request `llms.txt` instead of exporting it in the request.
- `@michaelthielemann/kestrel-upgrade`'s plugin API gains `Rule.needs: "source"` and the
  `SourceRuleContext` such a rule declares itself with (`root`, `scratch`, `readFile`, `answers` — no
  loaded project, boot check or preview, both exported from the root entry alongside `Rule` and
  `RuleContext`): it runs whether or not the project itself loaded this round, so the built-in
  `deps/kestrel-range`, `deps/pre-install` and `types/breaking-signatures` — now on this path — still
  find and fix or report what never needed the project, even when a plugin's own `load()` failed or
  the installed config throws on import; the report still carries the load failure as its own finding
  alongside them, and `report.tiers.source` is `"failed"`, not `"not-run"`, when this happens.
  `fix --write` applies a source rule's edit the same as any other, and both its own "run pnpm
  install..." line and its dry-run's no-preview fallback point at running `check` again once it is
  installed. A rule's own `check()` throwing — its own bug, or a `needs: "source"` rule reaching into
  a project it was never given — becomes a `plugin/hook-failed` finding naming the rule instead of
  aborting the run for every other one. Every rule without `needs` keeps running only once the
  project loaded, exactly as before.
- `kestrel-upgrade`: `KESTREL_UPGRADE_FORCE_MAJOR=6` in the environment opens `check`/`fix`'s load and
  boot tiers against a build whose own `package.json` does not report major `6` yet — testing a build
  from this branch before it is published, say — the same way a real 6.0.0 install would. A CLI/
  environment escape hatch only: `RunUpgradeCliOptions`, `UpgradePlugin` and `Rule` gain nothing.
- `site-default` routed mode: config `routes` (per type `slugField`, `home`, `liveWhen`,
  `labelField`), `prefixPrimary` and `reservedPaths`; `{}` behaves as before. A routed type's public
  path is unique per locale across all routed types; a save that takes a held path answers `CONFLICT`
  naming path, locale and occupant, a reserved path or a leading locale code `VALIDATION` on the slug
  field. New steps `site.indexPath:<t>` (last in a routed write's atomic group), `site.announcePaths`
  (right after it), `site.resumePaths`, `site.planRebuild`/`site.applyRebuild`, `site.previewPath:<t>`
  and `site.attachPaths:<t>`; `site.resolve` answers carry `_paths`. The module raises
  `site.pathsMoved` with `{ moves: [{ type, id, locale, from, to, seq }] }` after every run that
  changed a reachable path. Routed mode needs `persistence@1` and `events@1` (now `optional` for the
  module) and stores `site_docs`, `site_paths`, `site_runs` and `site_meta`; boot fails when a
  pipeline writes a routed type without the index steps, or reads it with another `home` or
  `slugField`.
- `redirects-default` automatic redirects: `redirects.recordMoves` applies `site.pathsMoved` moves.
  An old path answers 301 to its document's current path in `redirects.lookup`, `redirects.export` and
  `redirects.render`, with no chains; the outcome does not depend on the order, repetition or replay
  of the moves, and two documents swapping paths in one run leave both paths unredirected. Editor rules
  take precedence and come first in `redirects.json`; an automatic redirect whose target an editor
  rule matches is skipped and logged, and `redirects.validate` rejects an editor rule whose target is
  an automatic redirect's source. `redirects.listAuto` and `redirects.removeAuto` (a removed automatic
  redirect stays removed when the move that created it is replayed).
- `delivery-static`: `delivery.markMoved` runs on `site.pathsMoved` and marks the moved documents'
  own outputs and every output linking to one of them at an old path; the re-render stores each at
  its new path and removes the old files. `site-default`'s `./impl` exports `createSitePaths`.
- `examples/minimal` routes its pages through `site-default`: page writes end their atomic group with
  `site.indexPath:pages` followed by `site.announcePaths`, `site.pathsMoved` feeds automatic
  redirects and re-renders, `resumePaths` runs every minute, and `rebuildPathsAfterMigrations` runs
  on `migrations.applied`. New routes `POST /admin/paths/rebuild`, `POST /admin/pages/path-preview`,
  `GET /admin/redirects/auto` and `DELETE /admin/redirects/auto/*path`; page answers carry `_paths`,
  and `pages.slug` is no longer `unique`.
- `site-default` subpages: `routes.<t>.parentField` (a non-localized `ref` to the same type, on the
  `mountTarget` type, default `pages`) prefixes a document's path with its parent's, per locale. A
  cycle, a chain deeper than `maxDepth` (default 16), a missing parent and the home page as parent
  are field errors; deleting a page with subpages is a `CONFLICT`. Renaming or re-parenting moves every
  subpage. A save that would change more than `maxCascade` rows (documents × locales, default 1000) is
  rejected with a field error naming the key. A published subpage stays reachable under a parent that
  is not published, with the parent's slug as a segment. New step `site.readTree:<t>`;
  `site.previewPath` takes `parent` and reports `exposesParentSlug`. A routed type with a parent
  field and a `unique` slug fails setup. `examples/minimal` gains `pages.parent` and
  `GET /admin/pages/tree`.
- `site-default` mounted collections: `routes.<t>.mount: true` with `mounts: { type, field }` places a
  collection under the page the stored assignment names, or at the top level without one. New steps
  `site.indexMounts` (last in the atomic group of a write to the mounts type, followed by
  `site.announcePaths`; boot fails otherwise) and `site.route:<t>` (ends the run with
  `{ route: { type } }` for a reachable document of another routed type). The mount page cannot be
  removed while it holds a collection.
- `site.readTree` answers each document's per-locale `live` state next to its paths.
- `kestrel-upgrade fix --write` applies findings that only appear after earlier edits in the same
  run, for at most five passes; a finding already handled is not applied again. An `--answers` id no
  pass asked is ignored with a warning on stderr instead of exiting 2. With `--json`, `fix --write`
  prints the report of every pass, including findings the last pass's edits brought up.
- `kestrel-upgrade` rules `site/routed-slug-unique` (removes `unique` from a routed type's slug
  field), `site/path-wiring`, `site/path-events`, `redirects/requires-persistence` and
  `imports/redirects-impl`.
- A step can set response headers: `Context.responseHeaders` (declared in the step's `writes`) goes
  out with the HTTP response of a successful run, beneath the mandatory headers, and `RunResult`
  carries it as `headers`. `UnsupportedMediaType` is exported next to `BodyTooLarge`.
- `@michaelthielemann/kestrel-contracts/helpers/session`: `requestToken`, `sessionCookie`,
  `clearedSessionCookie`, `crossOriginRefusal` and `SESSION_COOKIE`, shared by the authn modules. The
  shared `authn@1` step suite checks the session cookie and the same-origin rule, and its fixture
  takes the module's `sessionTtlSeconds`.
- `authn/multi` records when a session's password was last checked and adds
  `authn.requireRecentAuth:<seconds>`, which answers `403 REAUTH_REQUIRED` (with
  `details.maxAgeSeconds`) when that is longer ago than the window, and `authn.confirmPassword`, which
  checks the caller's password and renews the time. `changePassword` renews it for the session that
  made the change.
- `RunEndEvent` carries `details` (for a failure), `ip` and `identityId`; the `events.emit` envelope
  carries `ip`. `audit-persistence` stores `ip` on every entry, takes the event's `id` into `params.id`,
  and records security entries on its own: `auth.failed` for a failed login or password check (with the
  attempted username), `access.denied` for a 403 and `access.rateLimited` for a 429, each with the client
  address, pipeline, step and code; denied and rate-limited entries at most once a minute per address,
  identity, pipeline and step, with `params.suppressed`. New config `securityEvents` (default `true`) and
  `failedSteps`. `authn.login` answers a failed login with `details.username`; a username or email over
  320 characters is refused with 400 at every login and at `mfa.startSetup`.
- `ratelimit-memory` buckets take a `key` — `ip` (default), `username` (the body field `field` names,
  `username` or `email`, normalized and kept as a digest; a name over 320 characters is refused with 400)
  or `identity` (the signed-in user) — an optional `maxBlockSeconds` that doubles the block after each
  further exceeded window up to that bound, and `counts: "failures"`, which counts only runs that fail
  after the check and clears the key on a success; it holds each attempt while it runs, so parallel
  requests get no more than `limit` through. An `ip` bucket counts an IPv6
  address by its /64 and an IPv4-mapped address as its IPv4 address. `clientKey` and `usernameKey` are
  exported.
- Known devices at sign-in: a `ratelimit-memory` `username` bucket takes `knownDevices`, a budget of its
  own for each device holding a valid device cookie for the account it names, counted in place of the
  account's, so a third party who blocks an account for unknown devices no longer locks its owner out.
  The new step `ratelimit.rememberDevice:<bucket>`, after the login, hands out that cookie:
  `__Host-kestrel_device`, `HttpOnly`, `Secure`, `SameSite=Strict`, bound to the exact name of the
  signed-in account (only when the body field of the bucket names it), signed with
  HMAC-SHA-256 under the new module config `deviceCookies` (`secretKey`, `previousSecretKeys`,
  `maxAgeSeconds` default 30 days, `secure`). A device that uses up its budget, a cookie for another
  account or an expired one counts against the account as before. The check leaves `knownDevice` on the
  context (a `Context` augmentation in `@michaelthielemann/kestrel-contracts/knownDevice`), and
  `mfa.check` neither counts nor applies its lock for such a request.
- `Context.responseCookies` (a `string[]`): further `set-cookie` values a step adds to a successful HTTP
  response, each sent as a header of its own after the one in `responseHeaders`. It reaches `RunResult`
  as `cookies` and `HttpResponse` as `cookies`; the core HTTP server and `kestrel-h3` send them.
- New package `@michaelthielemann/kestrel-mfa-totp` (module `mfa/totp`): a second factor for any `authn@1`
  module — time-based one-time codes (RFC 6238) with ten single-use recovery codes of 125 bits, kept as
  keyed digests, the secret sealed with AES-256-GCM under a configured key, each code accepted once, and
  the factor locked after ten wrong codes in a row, each counted before it is checked (429, for longer
  each time; `maxFailures`, `lockSeconds`). A reset answers a one-time enrollment code that setting up
  the new factor requires (`requireEnrollmentCode` extends that to accounts that never had one, once any
  account has a confirmed factor). `previousSecretKeys` keeps factors working across a key change; a
  factor no key opens answers codes as wrong instead of failing the login. Steps `mfa.check` (after
  `authn.login`; 401 `SECOND_FACTOR_REQUIRED` / `SECOND_FACTOR_SETUP_REQUIRED`, ending the session the
  login opened), `mfa.startSetup`, `mfa.reset`, `mfa.forget` and `mfa.listEnrolled`; config `issuer`,
  `secretKey`, `previousSecretKeys`, `enforce`, `recoveryCodes`, `maxFailures`, `lockSeconds`, `requireEnrollmentCode`.
  `authn-multi` adds `authn.endSessions`, and both authn modules accept a `code` in the login body for
  such a step.
- A trash for `media/default`. `media.trash` and `media.trashFolder` take items out of the library
  (list, search, folder counts, `media.get`, download, `media.serve`, export, public copy) and free
  their names, `media.restore` brings them back with the same id, key, `path`, folder and texts (as
  `<stem>-<n>.<ext>` when the name was taken meanwhile, listed in `renamed`), and `media.listTrash`
  lists them with `trashedAt` and `expiresAt`. A purge is a selection — `media.selectTrash`,
  `media.selectAllTrash` or `media.selectExpiredTrash` — followed by `media.purge`, which deletes for
  good. The steps that take `body.ids` accept 1 to 200 and answer per id with
  `{ ids, skipped: [{ id, reason }] }`; `media.trash` and `media.restore` put every id that is in the
  target state afterwards into `ids` and name the ones that already were in `unchanged`, and
  `media.trashFolder` answers `{ path, ids, unchanged }` the same way for its subtree, also once the
  folder is gone, so a repeated request reaches the steps after them again. New config `trashRetentionDays` (default 30). A trashed item
  stays ready for `media@1` until it is purged, so modules reading media through it keep what they
  derived; `media.remove` and `media.removeFolder` stay final deletes (see Breaking for the type
  changes). `media.trash`, `media.trashFolder` and `media.restore` also answer `trashVersions`, each item's
  trash version, which rises with every move into or out of the trash. A repeated purge finishes an
  item whose purge stopped halfway. `media.syncPublic` reads an item again before it removes its copy.
- `images/default` gains `images.hideMany` and `images.showMany` (on `result.ids`) and the collection
  `images_hidden`: a hidden item's variants are not served, exported, attached or copied publicly
  until it is shown again, while its rows and stored variants stay. Neither step raises
  `images.variantsChanged`. Both read `result.trashVersions` as well, so when a trash and a restore of the
  same item overlap, the move that happened last decides whether its variants are hidden. Both leave
  a request on the item before they set or lift the mark, so a hide or show whose public copies were
  not all removed or written is finished by `images.resume`. `Images` gains `hide`, `show` and
  `hidden`.
- `references/default` gains `references.dropReferenced:<target>`: it keeps the unreferenced ids in
  `result.ids` and adds each referenced one to `result.skipped` as `{ id, reason: "referenced" }`, so a
  purge leaves files a page still uses in the trash and reports them.
- `kestrel upgrade`'s `pipelines/media-delete-order` also checks that `media.purge` runs before
  `images.removeMany`.
- `examples/minimal` wires the trash: `GET /media/trash`, `POST /media/trash`,
  `POST /media/trash/folders/*path`, `POST /media/trash/restore`, `POST /media/trash/purge`,
  `POST /media/trash/empty` and a nightly `purgeExpiredMedia`; `media.trashed` and `media.restored`
  mark the pages that show a medium. `DELETE /media/:id` stays a final delete.
- `images/default`: **focus and crop.** New step `images.setFraming` (`params.id`, payload
  `{ focus?, crops? }`) replaces an item's framing: one focus rectangle and optional manual crops
  keyed by reduced aspect ratio (`"16:9"`), normalised to 0..1 on the original after its EXIF
  orientation, stored in the new collection `images_framing`. It answers `VALIDATION` for an invalid
  framing and `NOT_FOUND` for an item that is unknown, not ready, without variants or hidden. Only
  `cover` sizes are cut by it: from the manual crop of their ratio, else the largest rectangle of the
  ratio centred on the focus, else from the centre as without a framing; `inside` sizes never render
  again because of it. A size whose cut changes is planned again at the same path with its new
  dimensions (never enlarged), and the old variant is served until the new render is there; then the
  item raises `images.variantsChanged`, as it does at once when the focus changes. Placing,
  rendering and writing the public copies of one item run under a lease on the item in the new
  collection `images_items`, held by one process at a time: a call that finds the item held by
  another process stores what it was asked to (a framing, for instance), leaves a request and
  returns, and the holder places and renders the item again before it lets go, so the rows end on
  the stored framing and `?v=` changes only once new bytes are at the path. A request left after the holder let go
  is served by `images.resume` once `staleAfterMs` has passed, except that `images.showMany` takes
  the item itself then and writes its public copies. An `images.setFraming` that fails after it
  stored the framing, also because it could not leave its request, places and renders the item in
  the background; `images.resume` takes over a lease whose holder stopped once it
  has run out and serves a request left open. `variantCounts` counts a row rendered with another
  crop than the stored framing gives its size as `pending`.
  `images.attach` adds `focus` and `framing: { focus, crops, width, height, ratios: [{ key, sizes,
  manual, fits, crop }] }` to each item, `width` and `height` being the original's oriented
  dimensions. Ratio keys are exact, so sizes with nearly the same ratio get separate
  keys. A framing survives trash and restore and is deleted with the item's variants;
  `images_variants` gains `crop`, `renderedCrop`, `renders`, `originalWidth` and `originalHeight`. The new subpath
  `@michaelthielemann/kestrel-images-default/framing` imports nothing and exports the crop rules this
  module renders with (`ratioKey`, `centredCrop`, `cropForRatio`, `effectiveCrop`, `focusFits`,
  `parseFraming`, `formatCrop`, `parseCrop`), so an editor in the browser previews
  exactly the server's cut.
- `examples/minimal` wires `PUT /media/:id/framing` to `setMediaFraming` (`images.setFraming`, then
  `images.generate`, answering the item as `GET /media/:id` does, behind `media.write`) and grants
  `focus` to anonymous media reads; `kestrel upgrade` proposes `focus` in the anonymous media grant
  when `images.attach` runs.
- `images/default`: every entry of `variants[]` that `images.attach` lists carries `crop`, the part
  of the oriented original that the bytes at its `path` show, as `{ left, top, width, height }` in
  the form of `framing.ratios[].crop`, or `null` for the whole image (an `inside` size), the centred
  cut of the size's ratio, or a path without a finished render. It is the crop of the last finished
  render at the path, not the planned one. Two `done` entries with the same
  aspect ratio and an equal `crop` show the same picture, up to cuts that differ by a few pixels
  across the smaller one since the ratio test compares rounded dimensions, so a `srcset` combines
  only such entries.
  A cut whose edges each lie within one pixel of the centred cut counts as the centre:
  `cropForRatio` and `effectiveCrop` return `null` for it, it renders as the centred cut, and
  `framing.ratios[].crop` and `variants[].crop` list it as `null`, while `framing.ratios[].manual`
  still says whether a manual crop is stored. `images.syncPublic` gives a variant path a new `?v=`
  when it rewrites a public copy of another byte size, and renders a variant again whose key holds
  bytes of another size than its row records, as after a database restore. `examples/minimal` grants `variants[].crop`
  to anonymous media reads, and `kestrel upgrade` proposes it in the anonymous media grant when
  `images.attach` runs.
- `replication-sqlite`: `./wal` exports `walChecksum`, `walHeaderChecksum`, `FrameScanner` and the
  `WalChecksum` type; `createReplicationSqlite` takes an optional fourth argument,
  `ReplicationOptions` (`checkIntervalMs`, how often the WAL is compared with `checkpointBytes`
  between syncs).
- `replication-sqlite`: `ReplicationOptions` of `./impl` gains `copyBackBytes`, how many bytes of WAL frames
  not yet copied back into the database file a checkpoint leaves to a worker thread before it copies back
  the rest on the event loop's thread; 8 MiB by default. 0 leaves any such frames to a worker thread,
  `Infinity` none; a negative value or `NaN` makes `createReplicationSqlite` throw a `RangeError`.
- `blobstore-s3` has an `./admin` entry, `createS3Admin(config)`, for what `blobstore@1` does not
  offer. `listDetailed(prefix)` returns key, size, ETag (without quotes) and the server's
  modification time in milliseconds. `head(key)` returns the same for one key, or `Ok(null)`; a bucket
  that does not exist throws. `copy(from, to, { ifMatch? })` copies on the server with
  `MetadataDirective: "COPY"`, then reads the destination until it reports the source's size and the
  ETag the copy returned (an overwritten destination can look stale for a moment) and answers
  `VERIFY_FAILED` otherwise. With `ifMatch` it answers `PRECONDITION_FAILED` when the source no longer
  has that ETag. A store that enforces `x-amz-copy-source-if-match` writes nothing then, and its 412 is final;
  for a store that ignores the header or answers 501 or 400, the copy is made without the header, the
  ETag is compared before and after it, and a destination written from a changed source is removed
  again (`sourceCheck: "compare"` skips the header and suits a store that refuses every conditional
  request). Where the expected, the source's and the copy's ETag are plain content hashes, the ETag the
  copy reports is compared too, which catches an overwrite that reads of the source did not show yet. `details.reason`
  and `details.destinationRemoved` say what happened, and a `TRANSIENT` after the destination was
  written removes it and reports `destinationWritten` and `destinationRemoved`. Copying an object onto
  itself throws. A source above 5 GiB answers `PAYLOAD_TOO_LARGE`. `listDetailed` throws when a store
  reports a truncated page without a continuation token or repeats a token.
  `serverTime()` writes a probe object, lists until it shows and returns its `LastModified` with the
  skew against the local clock, because not every store sends a usable `Date` header; a probe it cannot
  delete afterwards does not fail the measurement, `leftover` names it.
  `probeCapabilities()` tests on scratch keys whether the store refuses a stale `If-None-Match: *`
  write, a stale `If-Match` write and a stale copy-source ETag and accepts the matching condition; a
  condition counts as supported only when both were seen, an ignored or rejected header or a store that
  refuses every conditional request reports `supported: false`. Every method answers `Result`:
  `TRANSIENT` after the SDK's retries, anything else, such as `AccessDenied`, throws. `blobstore@1` is
  unchanged.
- `blobstore-s3` takes `requestChecksumCalculation` (`WHEN_SUPPORTED` or `WHEN_REQUIRED`) in its
  config and passes it to the SDK. `WHEN_REQUIRED` stops the SDK from adding a checksum trailer to
  uploads, which some S3-compatible stores reject or ignore without verifying. Unset keeps the SDK
  default.
- `pnpm test:s3` runs every `packages/*/minio.test.ts` against the MinIO container, not only the one
  in `blobstore-s3`.
- `persistence@1`: `findMany` takes `withTotal` (type `FindManyOptions`, beside `FindOptions`). With
  `withTotal: false` the page has no `total` and the provider runs no count (`PageWithoutTotal`); the
  default and `true` count as before, so callers are unaffected. A caller that passes a
  boolean it only knows at run time gets `total?: number`. A custom `Persistence` provider or a
  wrapper that forwards `findMany` takes the new options and leaves `total` out when `withTotal` is
  `false`; `ownedPersistence` and `fakePersistence` do, and the contract suite checks it.
  `delivery/static`'s prefix scan passes `withTotal: false`.
- An atomic group that ran past `scopeTimeoutMs` answers `TRANSIENT` (503) with
  `details: { reason: "scope-timeout", pipeline }` in `persistence/sqlite` and in `fakePersistence`, so
  a client can tell it from the answer for a call that gave up waiting for the connection, which has
  no `reason`.
- A module may declare `quiesce(instance)`. `stop()` calls it first, synchronously, once, in reverse
  boot order, before the in-flight runs drain; a module stops starting work of its own there and
  lets started work finish. A hook that throws is logged and the shutdown goes on.
- `events-queue` quiesces at the start of `stop()`: the main loop, every lane and `events.relay`
  claim no further row, fan out nothing and scan for no lane, so no listener pipeline starts while
  the instance drains. A row already running finishes. Rows the main loop claimed in its batch but
  had not started go back to `pending`, unlocked, with their `attempts` and `coalesceKey` as before;
  a row whose `coalesceKey` a newer pending row took meanwhile goes back without it, and both rows
  are delivered.
  Everything left pending is delivered after the next start, or by another process on the same
  store. `emit` keeps writing rows meanwhile.
- `kestrel.config` takes `stepLog`: `"all"` (the default) writes one `step` log line per step,
  `"errors"` only for a step whose outcome is not `ok`, `"off"` none. Run observers, such as the ones
  of insights and audit, are unaffected in every mode, and the error lines for a thrown step or a
  failure with a cause are written as before. `runPipeline` from `@michaelthielemann/kestrel/runner`
  takes the same `stepLog` option.
- `kestrel status`, `kestrel backup`, `kestrel restore` and `kestrel update` run the matching commands of
  `@michaelthielemann/kestrel-ops` on the environments of `kestrel.environments.json`. The CLI does not
  depend on kestrel-ops and loads it only when one of them runs, from the project first, then from next to
  the CLI; without it they print how to install it and exit 2, and the other commands, `upgrade` included,
  never load kestrel-ops. `update` answers 2 while the installed kestrel-ops brings no update assistant,
  and 3 when a hard failure after the stop was rolled back automatically. `kestrel --help` lists the four commands; `kestrel update --help`
  lists `prepare`, `accept`, `rollback`, `status`, `resume`, `abort` and `cleanup`; `update prepare`, `bundle`,
  `deploy`, `verify` and `resume` pass the facts the project's host plugin returns from `ops()` to kestrel-ops, and
  the other `update` commands load no host plugin.
- The update assistant of `@michaelthielemann/kestrel-ops` (`runUpdate` from `./run`, `kestrel update`, and
  `node .kestrel-ops/run.mjs deploy` in a deploy job) moves a deployed environment with one instance to a new
  release. `update prepare` checks the environment read-only, plans the update on a copy of the newest replica
  generation (storage migrations of the release's module packages, the pending content migrations the host
  facts list in `contentMigrations`, their questions; the module packages also when a dependency of the project,
  such as a preset package, brings them along), rehearses the migrations on that copy without writing to
  the app's store, content migrations through a local start of the release, checks that no referenced original
  went missing, and writes a receipt with the version change and the plan hash into the backup location. `deploy` refuses a version change or a pending storage
  migration without a matching receipt, more than one instance, an active deployment and any earlier deploy run of
  the environment that is still open with exit 1 before anything changes, and with exit 2 a target that cannot
  check the release's readiness, a release that cannot clean the stored SVGs, which prepare refuses as well, a release
  configuration the target cannot apply (`UpdateTarget.checkReleaseConfiguration`, optional; prepare checks it
  without resolving the sources), and pending content migrations without `update.localBoot`; stages the release while the old one serves (a staging failure never stops the app); records
  the app's configuration, secret values only as salted fingerprints (also a plain value that contains one of the
  tool's credentials of 16 or more characters, or a shorter one as a token of its own, neither preceded nor followed
  by a letter, a digit, `_` or `-`, nor by a run of `.` and `/` with such a character beyond it, or as a URL's user
  or password; every other plain value, such as `kestrel-media`, `kestrel.example.net` or
  `https://kestrel.example.net/kestrel` for the access key `kestrel`, verbatim, so a rollback restores it, while
  `minioadmin.`, `s3://minioadmin` and `s3://kestrel` are fingerprints; a start command or health check endpoint
  that holds such a credential ends the deploy with exit 2 before it records anything, since a rollback restores
  both verbatim); stops the app and waits for the seal, except
  when the running versions name a runtime before 6, which writes none, or, with the running versions unknown, the
  stored data the pending storage migrations convert was written by a release before 6 (told by the modules' storage
  version rows and the oldest pending migration's `introducedIn`, not by `convertsFrom` alone); takes
  a verified cutover backup that records the running versions, pinned until `update cleanup` for a change of the
  major, unknown running versions or a pending storage migration, so no migration starts without one; migrates a copy
  of its database; promotes it, swaps the code and starts the release as one step; and verifies it with three
  outcomes, waiting up to `update.syncWindowSeconds` for the `applied.json` the release writes at its first sync
  and reading the instance and the crash events again once its waits ended: passed, failed (an automatic
  rollback to the cutover state, exit 3, or exit 1 when no previous release was left to start) or unverifiable (403, no
  connection, or a check that cannot read the store or the platform: the run halts with exit 1). Only after a
  passed verification are the older releases of the app deleted, the replaced one's code saved into the backup
  location first where the platform hands it out; a failed save does not keep it. When deleting them fails or is
  interrupted, the deploy ends with exit 1 because they can still start, `update resume` or `update accept`
  deletes them, and the gate of a later deploy refuses until they are. The saved code of earlier deploy runs that
  are closed and hold no pin is deleted then as well; a deploy whose credentials may not delete in the backup
  location leaves it with one warning naming its keys and still ends verified with exit 0, `update status` lists it
  (`savedCode`), and `backup prune` removes it once it is a day old (`savedCode` in its document). A
  hard failure after the stop and before the cutover backup is written starts the previous release again on the
  unchanged replica. A rollback promotes the cutover database again before any old release starts, copies back
  originals, replaces the delivery prefix and lists it again, restores the recorded configuration verbatim, starts
  the previous release and proves through `applied.json` or a marker row in its first snapshot (table
  `kestrel_ops_provenance`), within `update.syncWindowSeconds`, that it restored the cutover state; it reports the
  derived keys that differ from the
  cutover backup and releases the pin on it. Every rollback waits for the seal of the release it stops, the run's
  target versions once the new release started, whatever installation the target reports. `update rollback`, and
  `update abort` of a run whose new release started, stop the app first and take a verified safety backup of the
  stopped state; after `accept`, or once the
  stopped state holds what the new release wrote since its start, they show what would be lost and need the
  environment's name, and without it start the release again. A halted run whose verification fails again after
  its release wrote is held instead of rolled back automatically, and so is a deploy that `update resume` continues
  after a start an earlier process began; `update resume` of a run whose failed verification is recorded before its
  rollback began stops the app, asks when the release wrote and takes the safety backup as well; `update resume`
  of a rollback that already started the previous release on the promoted cutover state does not promote it again
  while the app runs that release, but waits for its readiness and verifies it again, and refuses with exit 1 and
  the release left running when that still fails; with the app stopped, and in `update rollback` and `update abort`
  of such a run, the stopped replica is compared with the generation that rollback promoted, and what the previous
  release wrote since is shown and needs the environment's name before a safety backup and the next promotion; the saved code
  of the release before a major change stays until `update cleanup`, so such a run rolls back across the major
  also after a later verified deploy, which then reads rolled back, while an unpinned superseded run is refused. The migration of the cutover copy downloads the cutover database again on every run, so a kill inside
  a content migration that is not idempotent is resumed from the same state; it refuses a migration the plan does
  not name, writes blobs to the app's store only as server-side copies or new keys and never over, or instead of,
  an existing key, cleans stored SVGs with the release's sanitize package, and applies content migrations through
  `update.localBoot`, a start of the release on the copy with exactly its configured environment and the host's
  `localBootEnv`, never a variable of the tool's own environment, and a build identity of its own. `update
  status` reads every update run of the environment from the backup location, so a deploy job's run shows on any
  machine, with the hosts it ran on, its state, the next command and the time and downtime of each step;
  `accept`, `rollback`, `resume`, `abort` and `cleanup` work on the newest deploy run that changed something (a
  later deploy the gate refused does not hide it) or the one `--run` names;
  `resume` refuses with exit 2 to continue a deploy from a process with another release than the run's (its
  versions or the content migrations of its host facts) and refuses a cutover plan that differs from the gate's.
  Every command but `status` takes the lock; `--json` prints `kestrel-ops/update-<command>@1`. The running
  versions are those the newest verified deploy put there, else those the target reports, else, in a deploy, the
  `versions.from` of the receipt its gate matched; a target's report never counts when it read the packages
  installed in the project the command runs from or inside a release directory of its own (`TargetFacts.packagesFrom`
  names the directory a target read them from), so `prepare` with the new release installed records them as
  unknown instead of as the new release's. With the running versions unknown, `prepare` warns that the deploy's stop
  will wait the whole `update.sealTimeoutSeconds` for a seal and names how to make the running runtime known,
  unless the stored data tells a release before 6.
  `kestrel.environments.json` takes an optional `update` block (`release.dir`, `localBoot`, the waits and
  `cleanupAfterDays`). `update bundle` writes `.kestrel-ops/` with the release's versions, the host facts, every
  target manifest the environments name and the module packages whose storage migrations a deploy runs;
  `run.mjs` hands `deploy`, `verify` and `update …` to `runUpdate`. `docs/operations.md` describes the flow.
- `kestrel-target-cloudfoundry` implements the update target of `kestrel-ops`: a preflight that reports
  instances, an active deployment, the health check type and whether `readyUrl` lets it check readiness, staging of the release while the app runs, reading
  and restoring the app's configuration, checking the release's manifest and its `vars` sources without changing the
  app, applying the release's manifest and making the staged droplet current
  while the app is stopped, a readiness probe with three outcomes, crash events, and listing, saving and deleting
  droplets and revisions. A droplet download that fails is tried three times before it is reported as failed; only
  a droplet of a container image counts as one whose bits the platform does not hand out.
- New package `@michaelthielemann/kestrel-target-cloudfoundry`: a `kestrel-ops` target for one app in a
  Cloud Foundry space, through the `cf` CLI. It reads state and instances through the v3 API and recognises
  a stopped app only with no instance in any state but `DOWN`. `status`, `backup create` (live or frozen)
  and `restore` into the environment end with exit 1 before anything is stopped or started while the app is scaled to
  more than one instance or to 0 instances, started or stopped, or while a deployment, such as a rolling
  push, is active; `backup list`, `verify`, `prune` and `restore --to local` never read the target. It acts
  only while cf targets the configured org and space and never names another app, so a static web server
  next to it in the same manifest is never touched; stop, start and the droplet change go to the app's guid
  through the v3 API, and `cf apply-manifest` and `cf logs` run only after `cf target` and the app's guid
  were read again. A stop waits until no instance shuts down any more, as a Cloud Controller with the
  `STOPPING` instance state reports it; when it sees no instance shut down, it waits `stopGraceSeconds`
  (default 15) after the stop request, covering the shutdown in which the replica is sealed. A stop, a start
  and the readiness wait repeat failed status reads, also a `cf curl` that ran out of time or ended by a
  signal, until their timeout; a stop whose request failed goes on once the app reads stopped, a failed stop
  says that the app may stay stopped, and a start whose request failed counts as done once the app reads
  started. A backup records the app's guid, droplet (null only when the app has none), newest revision and
  the names, never the values, of its environment variables, next to the installed versions of the
  packages the `package.json` in `dir` declares and the runtime packages they bring; without that file,
  none. `applyManifest()` reads the manifest as YAML 1.1 with merge keys, with dates and clock times kept as
  strings and integers kept digit for digit, as cf does, and applies only its version and the app's
  resolved entry through `cf apply-manifest --vars-file`, with the values in a 0600 file removed
  afterwards, also on failure, on exit and on SIGINT, SIGTERM or SIGHUP; no value is passed on a command
  line and `cf set-env` is never used. A placeholder without a source or with a dot, or an entry that
  scales the web process to another count than 1, ends with exit 2 before cf runs. cf runs with colored and
  trace output switched off.

- `redirects-default`: a rejected redirect rule carries a stable reason, so a client can show its own message.
  The `400` of `redirects.validate` (`PUT /redirects`) keeps its message, status and `code`, and its `details`
  become `{ row, field, reason, path? }`: `field` is `from`, `to` or `status`, `path` is the reserved prefix for
  `reserved-path` (for instance `/admin`) and the target for `automatic-redirect-loop`. `reason` is one of
  `blank`, `too-long`, `scheme-or-host`, `query-or-fragment`, `control-characters`, `backslash`,
  `dot-segments`, `adjacent-double-wildcards`, `too-many-wildcards`, `reserved-path` (all `from`);
  `blank`, `control-characters`, `backslash`, `protocol-relative`, `unsupported-scheme`, `invalid-url`,
  `embedded-credentials`, `placeholder-in-host`, `placeholder-out-of-range`, `placeholder-syntax`,
  `automatic-redirect-loop` (all `to`); `invalid-status` (`status`). A list that is not a list (`not-a-list`)
  or holds more than 1000 rules (`too-many-rules`) is rejected without `row` and `field`. Duplicate rules are
  not rejected. `redirects.export` and `POST /admin/publish-all/pages` report `redirects.skippedRules` next to
  `redirects.skipped`: the same rows, in the same order, as `{ row, field?, reason, path? }`, where each row
  beyond the 1000-rule limit is `{ row, reason: "too-many-rules" }`. The types `RedirectRuleReason`,
  `RedirectRuleField` and `RedirectRuleDetails`, the list `REDIRECT_RULE_REASONS` of every reason and the class
  `RedirectRuleError` are exported from `@michaelthielemann/kestrel-redirects-default/impl`. The `reason` of a
  `skippedRules` entry is declared as an enumeration of these values and `row` is required, in the manifest and
  in the OpenAPI description. A stored row whose `status` is neither text nor a number is skipped as
  `invalid-status` instead of making the list unreadable.

### Changed

- `contracts`: the testing fake `fakePersistence` compares two strings without converting them to
  buffers unless one holds a surrogate, so filters and sorts over a few hundred rows run several times
  faster. The order stays the UTF-8 byte order that SQLite's binary collation uses.
- `kestrel-h3` answers a request body it could not read (closed connection, request timeout, other read
  error) itself with 400 or 408 and an `http` line, instead of rethrowing to the host's error handler,
  as the core server does.
- `media-default`: `media.list` without `limit` answers at most `defaultLimit` items (new config keys
  `maxLimit`, default 200, and `defaultLimit`, default `maxLimit`) with the full `total`, instead of the
  whole library; a `limit` above `maxLimit` answers 400, and a list by `ids` reads at most `maxLimit` of
  them (200 before).
- `content-default`: `content.list:<t>` without `limit` answers at most `defaultLimit` items (new config
  key, default `maxLimit`, 200 unless configured) instead of every match; `total` still counts every
  match. A client that relied on one unbounded page reads further pages with `offset`. `content@1`'s own
  `list()` is unchanged.
- `validate-jsonschema`: the HTML sanitizer keeps an element's `id` only when it starts with an ASCII
  letter and holds at most 64 ASCII letters, digits, `-` and `_`; any other `id` is dropped and the
  element kept. Stored content keeps such an id until its next save through `validate.sanitize`.
- `delivery-static`: a type's `home` is optional and has no default; without it the render passes no
  `home` to `site@1`, whose own rule applies (`site-default`: `"home"` for an unrouted type, the route's
  `home`, possibly none, for a routed one). A config that relied on the `"home"` default with a
  `site@1` provider using another default must set `home` explicitly.
- `site-default`: a routed type's rules take the route's `home` even when the route has none; the
  `"home"` default applies only to unrouted types.
- `delivery-static`: an output that is published but has no public path records the error
  `no public path` instead of `no <slugField>`.
- `core`: module code that throws while `boot()` registers or resolves steps is a `KestrelBootError`
  and, in `checkBoot()`, an entry in `errors`. A module's `steps()` that throws is `steps-threw` (a
  new `BootErrorCode`) and its `describe()` `describe-threw`, both naming the module; `checkBoot()`
  lists a pipeline using one of that module's steps in `notChecked`. A step factory that throws for
  a pipeline's argument is `step-argument`, and a factory step's `describe()` that throws for it
  `describe-threw`, unless either throws a `KestrelBootError` of its own, whose code is kept; both
  name the pipeline, the step and the module. `kestrel.steps.resolve()` throws only
  `KestrelBootError`. `content-default` refuses `content.get`/`content.list` combining a fixed
  filter with `fallback=true` with a `KestrelBootError` (`step-argument`).
- `media-default`: `media.reconcile` and `media.reconcileDelete` count a key as orphaned only when it
  has the module's own shape, `<prefix><id>/<name>`, and no item has that id, instead of every key
  under `prefix` without a row except a hard-coded `media-variants/`. `images-default`'s variants
  survive a deleting reconcile with its `prefix` nested under this module's (`media/variants/` under
  `media/`) or equal to it; a file directly under `prefix`, deeper than `<id>/<name>`, or under the id
  of an existing item is no longer reported.
- `media-default` provides `media@1`; `Media` extends `MediaFiles`. A delete ends the item's
  readiness before it removes any byte (`MediaStatus` gains `removing`): `media.serve` and
  `media.download` answer 404 during a delete instead of failing. A delete that stopped midway leaves
  the item invisible, its name free and its folder without it; every start of the module finishes
  such items, with or without `publicCopy`, and so does whatever meets one first (repeating the
  delete, an upload, rename or move to its name, a folder rename or delete, `media.update` of its id,
  `media.syncPublic`). `images-default` removes, when attached, the rows and private variants of every
  item `media@1` no longer reports as ready. Every reader of the module — `media.get`, `media.list`,
  `media.serve`, `media.download`, `media.syncPublic`, `media.export:<dir>` and `media@1` — asks one
  readiness rule, so `media.syncPublic` no longer treats an unknown status as ready and
  `media.export:<dir>` copies ready items only.
- `delivery-static` writes each status row with a version check, so a render that finishes after a
  newer write, an unpublish or a path change removes the files it wrote instead of keeping them, and
  marks its output again whenever that output is still served; an output live at a path whose files
  were just removed is marked again too. `delivery.unpublish`
  leaves a short-lived `deleted` row per locale, also for a locale that was never rendered, which
  `delivery.resumeStale` removes after `dependencies.claimTtlSeconds`; `readStatus`, `_delivery` and
  `llms.txt` never show it. A failed render keeps a previous `error` row's path, so its last live
  file is still tracked. New status rows get the id `<type>/<docId>/<locale>`; older rows keep theirs
  and gain `version: 0` at setup.
- `replication-sqlite`: `setup()` no longer silently skips restoring the database when the file
  already exists. When `restoreOnStart` is set and the file was not just restored from a pending
  marker or automatic restore in this same `setup()` call, `setup()` now checks whether the file
  was created during the current boot while the replica holds a restore point (judged against
  `Deps.bootStartedAt`, with a local fallback where the file system reports no birth time: whether
  any table holds a row) and fails naming the file and its `-wal`/`-shm` siblings if so, telling the operator to
  move them aside and start again — the shape of a misordered module list that would otherwise
  start from an empty database. A file just restored by `backup-blobstore` configured on the same
  file is recognized through a small sidecar file, `<file>.restored-at`, and skipped without either
  module naming the other. A birth time is treated as unavailable, not as a false alarm, both when
  the file system reports none and when it reports one identical to the change time (the signature
  of a file system that fakes birth time from change time). The blobstore is asked whether a
  restore point exists only for a file that already looks fresh (or whose birth time is
  unavailable); an old file is never checked against the blobstore at all, and a blobstore failure
  only fails the boot for a file that already looked fresh. Every other skip is now logged with its
  reason, where previously it was silent.
- `backup-blobstore`: `setup()` gets the same check as `replication-sqlite` — including the shared
  `<file>.restored-at` sidecar and the "move aside" wording — minus the row-count fallback, since
  the backed-up file is not necessarily SQLite; an unavailable birth time is only logged, not failed.
- `replication-sqlite`: teardown ships the frames committed since the last sync and then seals the
  generation. It no longer checkpoints, takes a due snapshot or prunes, so the time between a stop
  signal and the kill goes to the frames. A process that never synced and committed nothing writes
  nothing at teardown; one that never synced but committed takes the first snapshot at teardown, and that
  runs the passive checkpoint every snapshot runs before it reads.
- `replication-sqlite` names a new generation after the newest one the replica lists, one millisecond
  later where its own clock is behind, so a generation placed by a process whose clock runs ahead never
  sorts after this process's data. The snapshot's restore point keeps the time it was taken, so a restore
  to a point in time still finds it.
- `replication-sqlite`: the first sync after the first snapshot of a process writes a WAL segment even when
  nothing was committed since that snapshot, one holding the WAL header alone (one write per start), so the
  replica shows that the sync runs on an idle site. The segment counts towards `segments` of `sealed.json`
  like any other; applying it changes nothing, so a restore, also through `kestrel-ops` or by an earlier
  release, rebuilds the same database byte for byte. The verification of a `kestrel-ops` deploy, which needs a
  segment or a later snapshot of the release's own generation, therefore passes for a release on which nothing
  is written.
- A `reassignTo` value in `authn.verifyUser`'s request body or event hand-over no longer requires a
  `name` alongside `id`, and also accepts a bare user id string.
- `authn-single` and `authn-multi` share one behavioural test suite for the five steps both
  register (`login`, `identifyUser`, `requireUser`, `loadIdentity`, `logout`), also run against a
  new in-memory `authn@1` fake, so the three stay in lockstep.
- `revisions.read`/`restore`/`label` are now pinned to reject a revision id that belongs to another
  document or collection, and `images.serve`/`images.read` to never return another media item's
  variant for a matching size name.
- `persistence-sqlite`, `site-default`: `createOne`/`findOne`/`updateOne` now declare
  `output: { type: "object" }`; `site.resolveLinks` restates the `_links` field as its own
  `extendsOutput`, alongside `site.resolve`'s existing `output`.
- `openapi`: the fold that derives a pipeline's response schema from its steps' `describe().output`
  moved into `@michaelthielemann/kestrel/schema` (`resolveOutputSchema`, subpath-only); the
  generated OpenAPI document is unchanged except for one route's `required` array order (the
  `resolvePage` route in `examples/minimal`, now folded through a merge instead of passed through
  unchanged — same fields, alphabetical order).
- Every object schema in a step's `output`, `extendsOutput` or `extendsItems` now declares
  `required`, listing exactly the properties the step always returns. Responses are unchanged — the
  underlying data was always there — but the generated OpenAPI document now describes them
  precisely: a consumer's generated types stop marking an always-present field as optional (media
  item lists, folder listings, delivery, replication and link/reference reports, among others).
- `authn/single` and `authn/multi` check a password on the thread pool instead of blocking the event
  loop, and a login for an unknown or deactivated username derives a key against a throwaway hash of
  the same parameters, so it takes as long as one with a wrong password. Both packages export
  `verifyPasswordAsync`; `verifyPassword` is unchanged.
- `images-default`: `variants[].path` of a variant rendered again at a path that held bytes before
  (after a re-crop, a reset to the centre, a changed size or format, a repair by `images.resume`, or
  a size registered again after a prune) ends in `?v=<token>`. The token is a short hash of the row
  and a count raised once new bytes are at the path or its public copy (a render marked `done`
  after its bytes are at the path, a failed attempt whose bytes could not be taken back, or
  `images.syncPublic` rewriting a public copy of another byte size) and when `images.syncPublic`
  sets a variant pending again whose key holds bytes of another size than its row records, so it changes only then and
  never comes back for that path, also when a crop is set back to an earlier one or the framing is
  reset. The query appears from a row's second finished
  render on, or once `images.syncPublic` rewrote its public copy of another byte size; a row placed at a path that held bytes before starts its count at one, and a format
  change keeps the count, one more when it moves the row to a path that held bytes before, so only
  a row's first render, at a path that never held other bytes, keeps the plain path. Such a render
  raises `images.variantsChanged` for the item, so
  the pages that show it are published again with the new URL. The path, its public copy,
  `images.serve` and `images.export:<dir>` are unchanged, so a check that matches exported URLs to
  files strips the query.
- `images-default`: a request to generate an item while a render of it runs waits for that render and
  renders once more, instead of sharing the running render, which may have read the rows before the
  request. `images.resume` also places and renders items whose lease ran out, items with a request
  left open, items with a row of a declared size that already had a render at its path and was left
  `pending` for longer than `staleAfterMs`, items with a row left `planned` for longer than
  `staleAfterMs`, items with a row left in `error` for longer than `staleAfterMs`, items with a row
  of a declared size planned with another spec than the size now has and untouched for longer than
  `staleAfterMs` while no sync job runs (a size changed again while a sync job ran past the item),
  and items created in the last 24 hours without rows, taking one item from each of these in turn up to 200 per pass,
  and moves the rows it tried behind the others. A row that never had a render is left to the render
  queued for it; once that render has run and left a row in `error`, or ran out of time before the
  item's later sizes, `images.resume` renders the item again. A render that runs out of time on a
  size's last attempt goes on with the item's later sizes. A render whose public copy cannot be written, or
  whose check after writing it fails, puts the earlier bytes back at the private path and the public
  copy, so both paths keep the bytes they had under the row's current `?v=`. `close()` waits for an `images.resume` or a sync
  start under way, and neither starts the sync job again once it has begun; `images.resume` then
  answers `CONFLICT`. `images.remove` leaves a request on the item before its first delete, so one
  that fails partway after `media.remove` is finished by `images.resume`, which removes the rows,
  private variants and public copies of an item `media@1` no longer reports as ready. When leaving
  that request fails, `images.remove` still deletes everything and answers that error only when a
  delete fails too.
- `images-default` requires `sharp` ^0.35.5 (was ^0.35.4), which fixes a published advisory.
- `sanitize-svg` and `validate-jsonschema` require `sanitize-html` ^2.18.1 (was ^2.17.0), which fixes
  published advisories in its sanitizing. It declares Node.js >=22.12.0 and no longer depends on
  `deepmerge`.
- `kestrel-contracts` declares the optional peer `vitest` as `>=4` (was `>=3`); the shipped
  `*.contract.test.ts` files are exercised against vitest 4 only.
- `authn.updateUser` and `authn.deactivateUser` are `atomicSafe` like `authn.deleteUser`, and the
  example pipelines run all three inside an atomic group. The last-admin guard reads the other
  admins and then writes, so without a group two admins removing each other's permission at the same
  time could both succeed; with one the second request answers `LAST_ADMIN`. Pipelines of your own
  need the same `{ atomic: ["authn.deactivateUser"] }` entry.
- `examples/nginx-njs`: the base image is pinned by digest on the nginx 1.30 stable series, and the
  handler never redirects the paths in `RESERVED_PATHS` (default `/admin,/api,/media`), whatever the
  rule list holds.
- `persistence/sqlite` keeps up to 256 prepared statements per connection (least recently used first
  out) instead of preparing every call's SQL again, and binds `LIMIT` and `OFFSET` as parameters so
  pages of different sizes share one statement. A `findMany` whose page holds every match no longer
  runs a second `COUNT(*)`.
- Docs: the pipelines guide, the `events-queue` and `delivery-static` READMEs and the pages API table now describe how to answer a save before its page is rendered (a lane of its own for `publishPage`), what that decouples and what it does not. The API table no longer says the `publishPage` run always happens after the response.
- `audit-persistence`: a step of `failedSteps` that only asks for the next part of a sign-in after a correct
  password records `auth.secondFactorRequested` instead of `auth.failed`, with the same params (`pipeline`,
  `step`, `code`, `username` when the step reported one). That covers `SECOND_FACTOR_REQUIRED`,
  `SECOND_FACTOR_SETUP_REQUIRED` and an `ENROLLMENT_CODE_REQUIRED` for a request without an enrollment code, so a
  sign-in with a second factor leaves no `auth.failed` entry. A wrong code and a wrong enrollment code remain
  `auth.failed`.
- `mfa-totp`: the 403 `ENROLLMENT_CODE_REQUIRED` of `mfa.startSetup` carries `details.enrollmentCodeGiven`,
  `false` when the body held no enrollment code and `true` when it held a wrong one.

### Fixed

- `replication-sqlite`: a snapshot no longer stops the process. The snapshot that starts a generation (the
  first sync of a process, `replication.snapshot`, the periodic snapshot after `snapshotSeconds` and the
  first snapshot at teardown) read the database file and the whole WAL synchronously, held the WAL twice
  in memory and copied the image on every commit that changed the database size, so at a database of about
  100 MB the event loop stood still for seconds and the process grew by several times the database's size.
  The snapshot is now read asynchronously in chunks of 1 MiB into one buffer of the database's size, and
  only the frames that are not yet copied back into the database file are applied, under the module's read
  transaction as before; when the WAL file is `checkpointBytes` or larger, a worker thread copies the frames
  that read transaction sees back into the database file first, so the checkpoint the snapshot runs on the
  event loop's thread has next to nothing left to copy. A checkpoint that finds 8 MiB or more of frames not
  yet copied back, as after a snapshot that took a while to read and upload while other connections
  committed, takes its read transaction again at the end of the WAL and leaves those frames to a worker
  thread as well, before it copies back the rest on the event loop's thread. The worker takes the checkpoint
  lock before the event loop runs again, so the checkpoint SQLite runs by itself after a commit on the event
  loop's thread leaves the copy to it. The image is byte for byte the
  one written before, so the replica format is unchanged: earlier releases restore what this one writes,
  and the other way round. When a snapshot upload fails, its key is removed again, and while that removal
  fails, every later sync, snapshot, checkpoint and seal tries it again first and fails with `TRANSIENT`
  before it uploads anything, also before the first generation, so a restore never picks a generation whose
  process went on shipping frames into the one before it or uploaded a later snapshot.
- `replication-sqlite`: a restore applies the WAL segments into one image that grows in place, instead of
  copying the image at every commit that changes the database size, so restoring a generation of a growing
  database takes time in proportion to its segments. `applySegment` of `./wal` therefore writes into the
  image it is given while that has room, also when a segment shrinks the database or grows it within that
  room, and the image it returns can be a view on a larger buffer whose `buffer` holds bytes after the
  database's end; to keep the image given, pass a copy of it.
- `replication-sqlite`: the WAL grew without bound until the first generation of a process existed, because
  the module's read transaction kept SQLite from starting the WAL over, and the first snapshot then had to
  read it whole. The module now takes its read transaction when the first snapshot starts reading, so until
  then the checkpoints SQLite runs after a commit keep the WAL as short as without replication, also while
  write transactions stay open across awaits; for a writer that turned those off, the once-per-second check
  runs a passive checkpoint as well, and a restarting one, which holds the write lock while it copies, when
  the WAL still holds `checkpointBytes` of frames after it. A WAL of `checkpointBytes` or more that a
  process left behind when it ended without closing the database is copied back on a worker thread when
  the module opens the file, and `setup()` returns once that is done, before `persistence-sqlite` opens the
  file; `settled()` of the `Replication` interface of `./impl` resolves then. A seal before the
  first generation takes the first snapshot whenever another connection committed since the module opened
  the file, also when the WAL was truncated since.
- `replication-sqlite`: `stop()` no longer waits for a periodic snapshot, a checkpoint or a prune that a
  running sync has still to do. The module now declares `quiesce`: from the start of `stop()` a sync ships
  its frames but skips the checkpoint, the periodic snapshot and the prune, a periodic snapshot or
  `replication.snapshot` that is still listing the replica or reading ends without uploading anything (the
  latter answers `TRANSIENT`), so teardown ships the last frames into the generation before it and seals
  it, and a prune that is still listing the replica or removing a generation ends there. A checkpoint that
  is already running, between syncs or in a sync, ships the frames it has read and ends without copying
  anything back on the event loop's thread. The first snapshot of a process without a generation completes
  before teardown seals it. `quiesce()` of the `Replication` interface of `./impl` begins that stop.
- `blobstore-s3`: `put` hashes the body for the request signature itself, in slices of 1 MiB with the event
  loop running between them, and hands the SDK the hash; the SDK hashed it in one piece, which held the
  event loop for about 40 ms per 100 MB, and for about 140 ms on a CPU without SHA instructions. The
  request is the same.
- `site-default`: the `maxCascade` limit counts every language row of the page being saved, so a save is refused or accepted
  the same way whatever the clock reads. Before, a row of the saved page whose only change was its timestamp counted only
  when the clock had advanced since the page was last saved.
- `kestrel upgrade data` loads the module configs through the project's host plugin when
  `kestrel.config.ts` does not load by itself, the way `migrate` does, and loads the project once for
  all its checks, so `data/redirect-reserved-paths`, `data/site-media-leftovers`,
  `data/blobstore-tmp-suffix`, the underscore-field count and `data/translation-slug` also run in a project
  whose config imports what only the host resolves. A path the host plugin resolves inside its scratch copy
  of the project, such as a blobstore-filesystem root under the host's data directory, is read at the same
  place in the project. When the configs load neither way, `data/config-load-failed` is an error, with or
  without a host plugin, and names the cause and each check that did not run with the modules whose config
  it reads, instead of those checks reporting nothing.
- `kestrel upgrade data` reports `data/blobstore-scan-incomplete` when the blobstore-filesystem root does
  not exist (info, naming the resolved path), when it or the delivery-static media export directory cannot
  be read (warning, naming the cause), and when directories below the root could not be scanned (info, with
  their count), instead of `data/site-media-leftovers` and `data/blobstore-tmp-suffix` reporting nothing.
- `content/default` looks up type names, fields in a filter, a sort and written data by their own name, so
  `?sort=constructor` and `toString` answer `400` (unknown sort field) and a written field named like an
  `Object.prototype` member is reported as an unknown field instead of passing the check.
- The `sanitize-svg`, `media-default` and `images-default` READMEs recommend serving SVG with
  `Content-Security-Policy: default-src 'none'; sandbox`, which is what the Node origin sends.
- `images/default`: `images.prune` raises `images.variantsChanged` for every item it took a size
  from, also when a later write of the run fails, and `images.syncPublic` deletes the private render
  a retired path still holds after such a failure while it writes the original over its public copy.
- `insights`: a pipeline's `lastAt` and a recent failure's `at` are the whole-millisecond wall clock
  reading at the end of the run. They were the start time plus the measured duration, a fraction of a
  millisecond that could lie ahead of `Date.now()` and of the `generatedAt` of the same answer.
- `openapi`: a request body leaves out every property that a step with a closed `input`
  (`additionalProperties: false`) does not list, and every `required` entry among them, since that
  step answers `400` for it. `PUT /media/:id/framing` in `examples/minimal` documents only `focus`
  and `crops`.
- `describe()`, `kestrel describe` and the manifest overflowed the stack for a module config field
  whose schema refers to itself, through `z.lazy()` such as zod 4's `z.json()`, or as an object
  whose field is that object again behind a `z.lazy()` or a getter; the recursive reference now
  appears as an empty schema `{}`, and the variables stop at the first repeated object.
- `media-default`: `media.list` with a `q` containing `_` found no item, because the wildcard was
  dropped from the store's prefilter (`my_file` searched for `myfile`); a `q` with `_` or `%` now
  finds exactly the names that contain it. `q` also ignores case now (`Photo` finds `photo.jpg`); it
  was case-sensitive. `media.listTrash` searches the same way.
- `references-default`: a bare id inside a `json` field — a block's image or relation field such as
  `"a1b2"` or `["a1b2", "c3d4"]` — was never indexed, so `references.guard` let a media file or page
  be deleted while a block still used it. The new optional `schemas` config maps `"<type>.<field>"`
  to a JSON Schema (a path relative to the project root, or inline); strings at positions marked
  `"x-kestrel-ref": "<target>"` are indexed with `via: "body"`, including nested blocks and
  repeaters. `watch: true` re-reads a changed schema file. The index rebuilds itself at boot whenever
  targets, `ref`/`json` fields, locales or the walked part of a schema change (a hash kept in the new
  collection `references_meta`); the first boot after upgrading rebuilds once, and a failed rebuild
  fails the boot. `references.rebuild` stays for repairs.
- `validate-jsonschema`: `validate.sanitize` picks a `oneOf`/`anyOf` branch whose `type` is a list of
  names, follows `$ref` chains and keeps keywords written next to a `$ref`, so `format: "html"` there
  is sanitized. `@michaelthielemann/kestrel-contracts/helpers/json-schema` holds the schema resolution
  both walkers share.
- Config secrets are redacted everywhere a config value is emitted: a variable's `value` and
  `default` and the `default` of the config JSON Schema, which are JSON snapshots. Redaction reaches
  object fields, record values, array and tuple elements, and every member of a union or
  intersection. A value behind a `transform`, `preprocess` or `pipe` that contains anything secret
  is redacted whole. The JSON Schema leaves out the default of a credential-like key.
- An `invalid config` boot error reports a secret path by its validation code only and an enum
  mismatch by the expected values only; other messages have credential URLs redacted.
- `replication-sqlite`: where the file system reports no birth time, the restore-on-start skip check
  judged an existing database by whether it held any table, so a database whose schema another
  module had just created during this boot, with no rows in it, passed as real data and the restore
  over an intact replica was skipped silently. The check now looks at whether any table holds a
  row: an empty schema with a restore point in the replica fails the boot like any other fresh file.
- `delivery-static`: unpublish, a slug or locale change and the tombstone sweep derived the blob keys to remove
  from the format name (`html`, `pdf`, …) instead of the renderer's own `extension`, so a renderer whose extension
  differs from its format name left its files behind; `delivery.exportLlms`'s `llms-full.txt` made the same
  assumption reading a page's stored HTML back, so it silently skipped that page's body. Each status row now
  records the key its own `live` or `error` output wrote per format and every removal deletes exactly those, never
  re-derived, only ever within the path being cleaned up: a re-render that stops writing a key at the same path
  removes that key too, without recording a path change or marking its own output stale over its own cleanup, and a
  path or key another live or error output still owns is never touched. A row written before this change, or whose
  recorded keys no longer lie under its own path (an older process having moved it without knowing about them),
  derives its keys once, the same way removal always did, and remembers the result for the next removal. A render
  that wrote some of its keys before a later write, or its whole first write, failed no longer leaves those orphaned:
  they are removed the same way a losing render's files are. Recording a row's freshly derived keys now also
  compares the path they were derived for, so a render that lands back on a row's own recorded path right after an
  older process moved it can no longer overwrite that render's own, correct write with the stale derivation; the
  `llms-full.txt` read falls back the same way, deriving the page's key afresh when the recorded one does not lie
  under the page's own path. A transient failure checking ownership of a failed render's abandoned path is logged
  like every other cleanup here, not returned as the step's own result, since the status write it follows already
  succeeded.
- `authz-roles`: a caller whose role claim is `constructor`, `toString`, `valueOf`,
  `hasOwnProperty`, `__proto__` or another `Object.prototype` key no longer trips an inherited,
  non-array value and a 500; role lookups go through a `Map`, not a plain object index, in both
  `authz.can`/`authz.require` and `authz.describePipelineAccess`.
- `events-queue`: an instance with no event trigger anywhere in the manifest now installs an empty
  delivery table at `setup()` instead of leaving delivery uninstalled, so `events.emit` drops the
  event instead of writing a row with no pipeline that nothing could ever fan out or process.
- `kestrel-upgrade`: a scratch copy that failed partway through (copying a file, symlinking
  `node_modules`) leaked its own temp directory — it was already tracked for signal-based cleanup, but
  nothing removed it on a normal, non-signal failure. `createScratchCopy` now removes and untracks its
  own partial copy before rethrowing.
- `kestrel-upgrade`: `check`/`fix` remapped every finding's and edit's `file` from the scratch copy back
  to the project root unconditionally, corrupting a path that was never inside the scratch copy to
  begin with — `DataContentModel.file` (always a project-root path, since `dataModel(root)` only ever
  receives the real root) and a path reached through a symlinked `node_modules` package resolving
  outside it. For a project root that is not a sibling of the scratch dir at the same depth, the
  corrupted path made `verifyAndApply` find nothing to read, downgrading an otherwise-verified
  `model/underscore-field` rename to manual. Only a path that resolves (following symlinks) to inside
  the scratch dir is remapped now; every other path reaches the report unchanged.
- `kestrel-upgrade`: `offer/event-queue`'s unverified prompt named
  `@michaelthielemann/kestrel-events-queue may not be installed` for every non-boot-tier failure, even
  when the boot preview ran and succeeded but left one or more relay pipelines in `notChecked` (a
  module's own config breaking their check, say). It now names each such pipeline and its own
  `notChecked` reason instead, falling back to the install guidance only when the preview did not run
  at all.
- `kestrel-upgrade`: `fix` verified only that each finding's own edit still parsed after applying,
  never checking `applyEdits`'s `conflicted` result — two rules whose edits genuinely overlap, without
  one containing the other, could both report `auto` while only the earlier-processed one was actually
  written, the other silently dropped. A conflicted edit not absorbed by a wider, containing accepted
  edit (the intentional case, where one rule replaces a value inside a construct another rule replaces
  or deletes whole) now rejects the whole finding, downgrading it to manual and naming the rule it
  conflicts with instead of writing a partial result.
- `kestrel-upgrade`: a plugin's `detect()` throwing surfaces as a `load/failed` finding naming the
  plugin, and the `data` command's `kestrel.config.ts` existing but failing to load surfaces as
  `data/config-load-failed`; a project with no `kestrel.config.ts` at the given root is unaffected. A
  detected plugin with no `dataModel` hook whose own config needs its aliases to load reports
  `data/config-load-failed` as a warning naming the plugin, not an error implying the config itself is
  broken. `steps/undeclared-required`'s `"all"` answer for a step this cannot locate this way (a
  factory step, say) reports why, naming the step, instead of repeating the same question with no
  explanation.
- `kestrel-upgrade`: every finding's `docs` field is now an absolute URL into `docs/upgrading.md` on
  GitHub instead of a path relative to the repository; the installed package ships no `docs/` for a
  relative path to resolve against.
- `kestrel-upgrade`: every module-list edit (event delivery, `modules/delivery-media`,
  `modules/references-media-target`, `modules/media-public-path`, a field-grant write, the queue
  switch) fell back to manual for a config that writes `const modules = [...]` (or `export const
  modules = [...]`) and references it by `modules: modules` or the shorthand `modules`, instead of an
  inline `modules: [...]` literal. The module-list array is now resolved through that declaration too,
  found anywhere in the same file.
- `kestrel-upgrade`: `modules/delivery-media` carried the old `delivery-static` `media.publicPath`
  value forward into the new `reservedPaths`/`publicPath` verbatim, even when that value's first path
  segment was `api` or `admin` — a path many projects reserve for their own API or admin UI — producing
  a config that passes every check tier but a real boot then refuses. It now falls back to manual
  instead, naming the conflict, since it cannot see where a given project actually mounts either one.
- `kestrel-upgrade`: `localModuleFiles()` counted a project's own module by file extension alone, so a
  module resolved into `node_modules` (a nested package-manager store included) counted as the
  project's own too — `responses/binary-cache-control`, `steps/ctx-done-terminal-output` and
  `responses/thrown-error-text` could flag an installed package's own published code. All three now
  exclude anything reached through a `node_modules` segment, or outside the project root.
- `kestrel-upgrade`: `pipelines/images-plan` fired for a pipeline calling `images.plan` directly even
  when it was already correctly split into a plan-only pipeline and a separate one, triggered on
  `images.planned`, doing the generating half — the very shape its own suggestion recommends. It now
  stays quiet for that shape and still fires for an unsplit or incomplete one.
- `kestrel-upgrade`: `fix --write` printed nothing at all once every proposed edit failed to verify (or
  every write was declined, or no open finding had an edit to offer), instead of saying so; it now
  always reports what happened, naming the rejected finding and its own reason when that is why.
- `kestrel-upgrade`: without a plugin registered, a `kestrel.config.ts` that fails to load always
  suggested "fix the file so it loads", even for a project whose config only loads through a dependency
  that ships its own upgrade command. That dependency is now detected generically — its own
  `package.json` declares a `bin` and depends on `@michaelthielemann/kestrel-upgrade` itself — and the
  suggestion names its command instead; a plugin already registered keeps the generic suggestion.
- The h3 adapter enforces `maxBodyBytes` while reading, like the core server: a `Content-Length`
  over the limit answers 413 before any byte of the body is read, and a body without one stops being
  read once it passes the limit, instead of being buffered whole before the check. The core server
  also answers 413 to an oversized `Content-Length` up front. Both use the new export
  `readRequestBody`.
- `kestrel upgrade`: the scratch copy of a git project applies the same secret, database and size filters
  as the copy of a project without git. A tracked `.env*` file, database file or file over 10 MB no longer lands in the
  temporary directory, a file name with non-ASCII characters is copied, and a file that git lists but
  the working tree no longer has no longer stops the run.
- `persistence/sqlite` and `fakePersistence` look fields up by their own name, so a sort or filter on a
  name `Object.prototype` defines (`constructor`, `toString`) is an unknown field like any other.
  `persistence/sqlite` no longer reads a filter value whose only key is such a name as an operator; it is
  an equality value. `createOne` and `createMany` store `null` for an omitted field named like an
  `Object.prototype` member instead of reading the inherited value (a boolean field became `true`, a
  string or json field failed the insert).
- `blobstore-filesystem`: `list(prefix)` reads only the part of the directory tree that can hold keys with that
  prefix, instead of walking and stating every file of the store and filtering afterwards. Its cost follows the
  number of matching keys rather than the size of the whole store, which shortens every caller that lists a narrow
  prefix, such as the replica listing in `replication-sqlite` on a store with many objects. The result and its
  order are unchanged. A broken symlink or an unreadable directory outside that part of the tree no longer makes
  the listing fail.
- `site-default`: `site.previewPath` (`POST /admin/pages/path-preview`) answers `reason: null` for a free, valid
  path. `reason` names only a problem of the path itself: invalid, taken, or a page above without a slug in the
  locale. For a page not saved yet, and for a stored page whose saved status is not published in the locale, it
  answered `"not published in this locale"`, although the status the caller is editing may be published.
  `reachable` keeps its meaning: `true` only for a free, valid path of a stored page that is live in the locale.
- `ratelimit-memory`: with a bucket that has `knownDevices`, the boot reports no `unwritten-optional-read` warning
  (in `kestrel.warnings` and `kestrel check`) for the `knownDevice` that `mfa.check` reads; `ratelimit.check` on
  that bucket writes it. Without such a bucket the warning stays, since nothing writes `knownDevice` then.
- `images-default`: `images.plan` and `images.generate` accept an event envelope whose `id` is `null`. An upload
  of several files in one request raises `media.uploaded` with `id: null` and the new items in `ids`; both steps
  refused that envelope with `VALIDATION` (`$.id expected string, got null`), so with direct delivery the upload
  answered with an error in `_events` and no variants were rendered, and with `events-queue` the delivery went to
  the dead-letter and the items were placed and rendered only by the next `images.resume`. The same applies to
  `images.planned` raised after such an upload.
- `images-default`: `images.retryFailed` (`POST /admin/images/retry-failed`) leaves the sizes of an original that
  cannot be decoded `failed` with `cannot decode` and `attempts: 0`, and does not count them in `variants` and
  `media`. It set them back to `pending`, so they failed every attempt again, with an error about the content
  type or the width instead of `cannot decode`, until they were `failed` once more after `maxAttempts`.
- `delivery-static`: a render that fails in `delivery.publish`, on save or in `delivery.publishAll` (a renderer
  error, a timeout, a reserved path, a blob write the store refuses), is retried like a failed re-render instead
  of staying in `state: "error"` unmarked, retried by nothing and missing from the stale counts. Its output is
  marked with the failure as its first attempt: the status row and `_delivery` report `stale: true` and the cause
  in `staleError`, `delivery.readStaleStatus` counts it under `stale` and, after `dependencies.maxAttempts` failed
  attempts, under `failed`, where `delivery.retryStale` picks it up. With `dependencies.render: "background"` the
  loop renders it again after the first `dependencies.backoffSeconds`; with `"events"`, `delivery.resumeStale`
  raises its job once that backoff has passed, as for any mark it finds due. An output that already carried a
  mark keeps it, with its attempts, and an output without a public path is not marked.

## 5.8.2 – 2026-09-27

### Fixed

- `replication-sqlite`: the replica could miss transactions. A sync uploaded the new WAL frames and
  then checkpointed; frames committed while the upload was running were copied into the database
  file and cut from the WAL without being shipped. Depending on whether later transactions rewrote
  the same pages, a restore to a point after that sync either failed `quick_check` or succeeded with
  those transactions missing. The local database was never affected. A checkpoint now holds the
  database write lock on a second connection while it reads the remaining committed frames and runs
  `wal_checkpoint(PASSIVE)`, and ships those frames right after, so no writer in any thread or
  process can commit in between. The first sync after the restart that applies this update starts a
  new generation. Restore points in generations written by earlier versions may lack transactions;
  restore from a generation started by this version where possible.
- `replication-sqlite`: `replication.sync` read the whole WAL file into memory on every run and
  blocked the event loop for the read. It now reads from where the last run stopped, asynchronously
  in 1 MiB chunks, ships segments of about 4 MiB, and ships only frames whose salts and checksum
  continue the WAL's checksum chain.
- `replication-sqlite`: the WAL grew with everything written between two syncs. The module now
  checks the WAL every second and ships and checkpoints once it holds `checkpointBytes` of frames.
  The WAL file is reused from its start instead of being truncated to zero bytes, and the module
  opens a second connection to the database for the checkpoint lock.
- `replication-sqlite`: `replication.sync` runs never overlap. A call made before the running one
  has started reading returns its result; a later call runs once more after it, so the sync at
  teardown still ships every frame committed before shutdown.

## 5.8.1 – 2026-09-22

### Fixed

- `replication-sqlite`: every restore of a generation with at least one WAL segment produced a
  database that failed with `database disk image is malformed`. The snapshot was written with
  `VACUUM INTO`, which renumbers pages, while the segments carry WAL frames addressed by the live
  file's page numbers. The snapshot is now the main database file with the committed WAL frames
  applied on top, so it shares the page layout of the frames shipped after it. A restore now opens
  the rebuilt file and runs `PRAGMA quick_check` before handing it over; a failure is
  `Err(TRANSIENT)` naming the generation and the point restored, and leaves no file behind.
  Replicas written by earlier versions cannot be restored: purge the prefix so the next
  `replication.sync` starts a fresh generation.

## 5.8.0 – 2026-09-20

### Added

- Deleting a user now decides what happens to what they wrote. `authn.deleteUser` takes an optional
  `reassignTo` (an existing, active user, not the deleted one; 400/404 otherwise, and the user stays),
  answers `{ ok: true, reassignTo: { id, name } | null }` and travels in the `user.deleted` payload
  when the event is emitted with `?with=result`.
- New step `revisions.reassignAuthor` in `revisions-default`: it rewrites the author of every
  revision of one user, either to another user or, without a target, to the anonymous author
  `{ id: null, name: null }`; content, snapshots, count and order stay untouched. The capability sits
  on the module instance, not in `revisions@1` — that contract is published and therefore frozen, so
  it grows the way `authn/multi` offers user administration beside `authn@1`.
- New steps `audit.anonymize` (clears `identityId` and every param naming one user; the event and its
  time stay, and an entry is never moved to another user) and `audit.prune` with the new config key
  `retentionDays` in `audit-persistence`.
- `examples/minimal` wires both: two pipelines on the event `user.deleted`
  (`reassignRevisionAuthor`, `anonymizeAuditUser`), the admin routes
  `POST /admin/users/:id/revisions/reassign` and `POST /admin/users/:id/audit/anonymize` to re-run a
  failed one (both steps are idempotent), a nightly `pruneAudit` cron and `retentionDays: 365`.
  `docs/api.md` gained a "Personal data" section listing what is stored where and how it disappears.

### Changed

- `content-default`: the README now states how a consumer-defined field type reaches the backend —
  declared as the `content/default` type it is stored as, its value shape enforced by a `validate@1`
  provider through `validate.check:<type>.<field>` before `content.create/update/set`, which answers
  `VALIDATION` (400) with `details.fields` naming the field, localized fields included. The module
  keeps its closed field type set; no config or contract change was needed. Tests cover the boot of
  such a resolved model, the rejection of a model that still names the custom type, and valid,
  invalid, localized, absent and `null` values.
- Engines: every package (and the root workspace) now requires Node `>=22.18.0`, the true
  minimum — `.ts` config and pipeline files are loaded through Node's type stripping, which is
  unflagged only from 22.18 onward; `node:sqlite` alone only needed 22.13.
- `revisions@1` `record`: a `save` whose snapshot and status are identical (deep, key-order-independent)
  to the current head's is no longer recorded; the call succeeds and returns the head's summary
  instead. A `restore` is always recorded, and so is the first save after one, since its parent is
  not the head. A skipped (oversized) snapshot never counts as identical, on either side. Both
  `revisions-default` and `testing/fakeRevisions` implement this, and the contract test suite covers
  it.

### Fixed

- `examples/minimal` now documents and tests its bootstrap `admin` password (`kestrel-demo`,
  the same demo password `examples/embedded` documents) instead of shipping an undocumented
  scrypt hash nobody could log in with.

## 5.7.0 – 2026-09-19

### Added

- New contract `revisions@1` (`@michaelthielemann/kestrel-contracts/revisions`) with a contract test
  suite and the in-memory `testing/fakeRevisions` for other packages' tests: an append-only history
  per collection, document and locale. `record` appends a full snapshot and moves the head and
  answers `NOT_FOUND` for a `parentId` outside that history, `list`
  pages it newest first without snapshots and names the head, `read` adds the snapshot, `label`
  names a revision, `prune` applies retention and `remove` drops a document's or one locale's
  history. Importing the contract puts `revisionParent` on the context: the revision the next
  `record` of that run branches from, and `restoreReport` (`RestoreReport`): what a restore of that
  run had to leave out.
- New module `revisions/default` (`@michaelthielemann/kestrel-revisions-default`) providing
  `revisions@1` on `persistence@1`, with `content@1` optional for the default locale. Branching
  follows from `parentId` alone: a save's parent is the head, a save made by a restore is the
  restored revision, which forks the line there — switching branches is restoring that branch's tip
  and saving again. Deliberately no merge. Steps `revisions.record:<collection>` (after
  `content.create`/`content.update`, reads the saved document from the result),
  `revisions.restore:<collection>` (puts the snapshot into `body` and `payload` so the existing
  update chain validates, sanitizes, saves, indexes and publishes it), `revisions.list`,
  `revisions.read`, `revisions.label`, `revisions.prune` (cron), `revisions.remove` and
  `revisions.removeTranslation`.
- `revisions/default` survives a content model that moved on since a snapshot was taken.
  `revisions.restore:<collection>` reads the current field set from the optional `content@1`
  dependency's `model()` and leaves snapshot fields the model no longer has out of the body instead
  of failing the write; fields the model gained after the snapshot stay at their current value. The
  new step `revisions.reportRestore` adds the outcome to the finished result as
  `restore: { revisionId, dropped, missing }`, and `revisions.read` returns the same analysis next to
  the snapshot, so a UI can warn before a restore rather than after. Without `content@1`, or for a
  collection the model does not describe, the snapshot goes over unchanged as before and no report is
  written. Nested structures stay the validator's business: a restored body that fails
  `validate.check:<c>.body` still answers 400 with the validator's own details, and a removed block
  type is a case for a content migration, not for restore.
- `revisions/default` retention: `keep` (50) newest per document and locale plus every revision that
  was ever live (`statusField`/`liveStatuses`), every labelled one, the head, every branch tip and
  every branch point; survivors are re-parented onto their nearest surviving ancestor, so a
  `parentId` chain never breaks. `pruneOnWrite` (true) prunes the written group on every save, the
  `revisions.prune` step does the whole store. A snapshot beyond `maxSnapshotBytes` (1 MiB) is
  recorded as `skipped: true` with a `warn` log line and no content — the save never fails for it,
  only restoring such a revision does (409).
- `examples/minimal`: `GET /admin/pages/:id/revisions`, `GET …/:revisionId`,
  `POST …/:revisionId/restore`, `PATCH …/:revisionId` (label) and a nightly `pruneRevisions` cron;
  listing and reading need `pages.manage`, restoring and labelling `pages.write`. `createPage` and
  `updatePage` record right after the content step, `deletePage` and `deletePageTranslation` drop
  the history with the document or the translation. Restoring emits `page.restored`.

## 5.6.0 – 2026-09-19

### Added

- `images/default`: config `renderTimeoutMs` (default 30000). A render that does not return within
  it is given up on and counts as a normal failed attempt with the error text `render timed out
  after <n>ms`. Previously a hung-but-alive render kept its entry in the in-flight map for good:
  the attempt was never counted, the variant never reached `failed`, and the sync job stopped at
  that image. sharp offers no way to abort a render, so the timed-out render is left to settle in
  the background and its result is dropped rather than written over the recorded failure.
- `images/default`: step `images.retryFailed` (`POST /admin/images/retry-failed` in
  `examples/minimal`, behind `images.manage`). It sets every variant that gave up after
  `maxAttempts` back to `pending` with `attempts: 0` — all of them, or one media item's via
  `params.id`/`payload.id` — and then does the work: one item is regenerated right away
  (`job: null`), all of them start a sync job at the first media item, because a paused job's
  cursor may already have passed the affected ones. Answers `{ variants, media, job }`, `404` for
  an unknown id. Until now only redefining a size or deleting the media item lifted the quarantine.
- `images/default`: `images.readStatus` additionally reports `failed: { variants, recent }` — the
  number of variants that gave up across all sizes (the per-size counts only cover declared sizes)
  and the twenty most recent ones with `mediaId`, `size`, `attempts`, `error` and `updatedAt`, so
  an admin UI can show why they failed. Additive; the per-size `variants` counts are unchanged.

- `core`: every `ConfigVariable` in the manifest (`kestrel.describe()`, `insights.readManifest`)
  carries `value` — the effective value, i.e. what the config sets, otherwise the default, `null`
  when `status` is `missing` — and `redacted`. The value is a JSON snapshot: functions, class
  instances and Buffers become type labels, a `Date` its ISO string, strings beyond 200 characters,
  arrays beyond 20 items and objects beyond 20 keys are truncated with a marker, and nesting deeper
  than five levels or a cycle reads `"[object]"` / `"[circular]"`. Both fields are additive; the
  contract stays `insights@1`.
- `core`: a redacted variable reports `value: null`, `redacted: true` and no `default`. Redaction
  follows the schema (`.describe("secret")`, which now also emits `writeOnly: true` into the
  generated JSON Schema, plus `format: "password"` and `x-secret: true` for a hand-written one), the
  key name (`password`, `secret`, `token`, `credential`, `authorization`, `passphrase`, `salt`,
  `dsn`, connection strings, and `key`/`keys` qualified by `api`, `access`, `private`, `signing`, …;
  a bare `key` stays visible, and numbers and booleans are never redacted by name), a value that is
  a URL carrying `user:password@`, and any redacted ancestor. The same net runs inside a shown
  value, where a nested credential key reads `"[redacted]"`.
- `insights`: `insights.readManifest` declares `value` and `redacted` on a config variable in its
  output schema. The route stays admin-only — the example pipelines guard it with
  `authn.requireUser` and `authz.require:insights.read`.
- `scripts/workspace.test.ts`: walks every package's config schema and fails when a key that reads
  like a credential is not marked secret in the schema.

## 5.5.0 – 2026-09-19

### Breaking

- `examples/minimal`: `DELETE /users/:id` deletes the user for good instead of deactivating them;
  deactivating moved to `POST /users/:id/deactivate`, the counterpart of `POST /users/:id/activate`.
  A consumer that wired `DELETE` to `deactivateUser` keeps its own mapping — the routes live in
  `kestrel.config.ts`, not in the module.

### Added

- `authn-multi`: the steps `authn.updateUser` (`params.id`, body `{ username?, roles? }`, answers the
  user) and `authn.deleteUser` (`params.id`, answers `{ ok: true }`), plus the methods `updateUser`
  and `deleteUser` on the module's `AuthnMulti` interface. A username stays unique (409 `CONFLICT`),
  roles are free non-empty strings, a role change and a deactivation end that user's sessions, a
  delete removes their sessions with them, and nobody can delete themselves (400).
- `authn-multi`: the config `adminPermission` (default `users.manage`) and an optional `authz@1`
  dependency guard the last admin: deactivating, deleting or taking the permission away from the
  last active user who holds it answers 409 `LAST_ADMIN`. Without an authz module nobody is known
  to be an admin and the guard stays silent.
- `examples/minimal`: the pipelines `updateUser` (`PATCH /users/:id`, emits `user.updated`) and
  `deleteUser` (`DELETE /users/:id`, emits `user.deleted`).
- `core`: `RunEndEvent` carries `message` for a run that ended with a status of 400 or above —
  the text the caller received, truncated at 500 characters and never a stack. An unexpected
  `throw` contributes `"<pipeline>/<step>: unexpected <ErrorName>"` only; its own text and stack
  stay in the log.
- `insights`: `stats().recentFailures` is a ring buffer of the last failed runs, newest first,
  with `{ at, runId, pipeline, trigger: { kind, name }, status, ms, code?, step?, message? }`. Its
  size is the new module config `recentFailures` (default 50, `0` turns it off). `insights@1`
  gains the field on `Stats` and the step `insights.readStats` declares it in its output schema.

## 5.4.0 – 2026-09-18

### Breaking

- `core`: the runner checks every successful step against its `describe().writes`, in every
  environment. A changed top-level context key that is not the root of a declared path, or a
  declared path without `?` that is missing afterwards, ends the run as 500 `INTERNAL`
  (`step "<name>" writes "<key>" without declaring it` / `step "<name>" declares writes "<path>"
  but did not write it (declare "<path>?" for a conditional write)`) with the stack in the log and
  `step` in the error body. Module authors mark conditional writes with `?`. Shipped fixes:
  `validate.sanitize` and `validate.sanitizeHtml` (`payload.<field>?`), `redirects.lookup`
  (`result?`), `images.attach` (`result.variants?`).
- `core`: a factory step's `describe(arg)` is called once at registration with the placeholder
  argument `<arg>`; a throw is a `KestrelBootError` naming step and cause instead of a manifest
  entry with `description: null`. `StepManifest.description` is never `null` any more
  (`kestrel.describe()`, `insights.readManifest`).
- `core` (testing): stand-in steps in `testing/runPipeline` register with `writes: ["result?"]`;
  a stand-in that seeds another context key declares it through the new `writes` option.
- `media-default`: `media_items.key` is declared `unique`. Two concurrent uploads of the same
  filename into the same folder end as one item and one `CONFLICT` (409, `details: { collection:
  "media_items", field: "key" }`) instead of two rows over one blob. Migration: existing rows with
  duplicate keys make `ensureCollection` throw at boot naming the key; find them beforehand with
  `SELECT "key", COUNT(*) AS n FROM "media_items" WHERE "key" IS NOT NULL GROUP BY "key" HAVING n > 1;`
  and delete or re-key the surplus rows.
- `media-default`: uploading the same folder, filename and bytes again answers 200 with the item
  that is already stored instead of 409; `media.upload` then ends the pipeline itself, so a
  following `events.emit:media.uploaded` does not run, and for several files in one request `ids`
  lists only the newly stored items. `Media.upload()` on `…/impl` returns `Result<{ item, created }>`.
- `core`: `ConfigVariable.required` is true only when neither the variable nor any ancestor is
  optional or defaulted; the generated config tables and `examples/minimal/manifest.json` change
  accordingly.

### Added

- `core`: modules may declare `emits: readonly string[]` for events they emit from a contract
  method instead of an `events.emit` step; the manifest lists it as `ModuleManifest.emits`.
  `migrations-default` declares `emits: ["migrations.applied"]`. Boot logs a warning (no abort)
  for an event trigger whose event no pipeline emits via `events.emit:<name>` and no module
  declares in `emits`.
- `events-queue` (new package `@michaelthielemann/kestrel-events-queue`, module `events/queue`,
  provides `events@1`, requires `persistence@1`, config all optional: `pollMs` 500, `batch` 20,
  `maxAttempts` 5, `backoffSeconds` `[5, 30, 120, 600]`, `lockTtlSeconds` 300, `retentionDays`
  7): `emit` persists the event in `events_queue` and returns, an in-process worker runs the
  listener pipelines afterwards with retry, backoff and dead-letter; expired locks are reclaimed
  after `lockTtlSeconds`. Steps `events.emit:<name>` (fails 503 `TRANSIENT` when the row cannot
  be written), `events.readQueueStatus`, `events.listDead` (`?limit`), `events.retryDead:all`,
  `events.retryDead:one` (`params.id`), `events.purgeDone`. Alternative to `events-inmemory`,
  never both; delivery is at least once, listener pipelines must be idempotent. The `events@1`
  contract test does not apply to it (it asserts synchronous delivery).
- `media-default`: step `media.listFolderItems`. `media.folderItems` stays registered as a
  deprecated alias with the same behaviour and goes away in the next major version;
  `examples/minimal` uses the new name.
- docs: `pnpm docs:generate` and `docs:check` also write and verify the package table in the
  root `README.md` from every `packages/*/package.json`.
- `core`: `ConfigVariable.status: "set" | "default" | "missing"` (type `ConfigStatus`) next to the
  unchanged boolean `set`; `default` reports the effective default, including one a defaulted
  ancestor supplies. `insights.readManifest`'s schema requires `status`.
- `media-default`: the README documents the three key families (`media/<folder>/<file>` originals,
  `media-variants/<id>/<size>.webp` variants from `images/default`, `site/media/<folder>/<file>.<size>.webp`
  copies published by `delivery-static`) and the idempotent upload.

### Fixed

- `openapi`: the CLI only tolerates a missing `package.json` (`ENOENT`); any other read error
  throws.
- `images-default`: the `whenIdle()` test hook keeps no module-level state.
- `replication-sqlite`: the teardown log says that pending WAL frames stay in the local WAL and
  ship on the next sync.
- core test suite: `describe.scan` fails a `module.ts` it cannot parse instead of skipping it,
  lists the three step-less modules explicitly, and follows helper chains of any depth to
  `ctx.payload`.
- `media-default`: `media.remove` deletes the blob only when no other row points at that key.
- `insights`/`core`: the manifest no longer shows the child of an optional or defaulted config
  object as required and not set.

### Changed

- Lint: `@typescript-eslint/no-unsafe-type-assertion` is an error in every package (tests
  included), so a narrowing `as T` on an `unknown` value can no longer bypass `boundaryCast`. The
  405 assertions across the workspace became typed generics, type guards, narrowing through
  existing checks or `boundaryCast<T>(value, boundary)` at a genuine untyped source (sqlite rows,
  S3 responses, JSON, ajv output, host objects); `core` shares one `isRecord` guard. No
  consumer-visible behaviour change: no new throws on reachable paths, no changed messages or
  return values.

## 5.3.0 – 2026-09-11

- `core`: `kestrel.describe()` answers the static manifest of the booted instance — modules
  with `use`, package version, contracts, config schema (JSON Schema derived from the Zod
  schema) and config variables (path, type, required, default, secret, set; never a value),
  steps with owner, factory flag and description, pipelines with resolved steps, triggers.
  `kestrel.observe(observer)` registers a `RunObserver` (`runStart`, `runEnd`, `stepStart`,
  `stepEnd` with duration, status and outcome) the runner feeds independently of the logger.
  New module lifecycle hook `attach(instance, { describe, observe })`, called once at the end
  of boot; a returned function runs on `stop()`. Config fields holding credentials are marked
  `.describe("secret")` (`authn-multi`, `authn-single`, `blobstore-s3`) so the manifest shows no
  default for them. The core's version in the manifest comes from a `VERSION` constant, so an
  embedded (bundled) instance reports the released number.
- `contracts`: `insights@1` (`manifest()`, `stats()`).
- `insights-default` (new package `@michaelthielemann/kestrel-insights`, config `{}`): provides
  `insights@1`; steps `insights.readManifest` and `insights.readStats` (count, failed = every
  non-ok outcome, errors = 5xx, nearest-rank p50/p95 ms over the last 1000 samples per pipeline
  and per step spec, active runs, uptime, event-triggered runs per event name; `ratelimit`
  stays `[]`). `examples/minimal` wires `GET /admin/insights/manifest` and
  `GET /admin/insights/stats` behind `authz.require:insights.read`.
- `content-default`: step `content.describeModel` answers the parsed model (`locales`,
  `defaultLocale`, `types`); `examples/minimal` serves it as `GET /admin/content/model` to every
  logged-in user.
- `pnpm docs:generate` writes a generated section (config variables, steps, the example's
  pipelines) between `kestrel-docs` markers into every module README and
  `examples/minimal/manifest.json`; `pnpm docs:check` fails CI on drift.
- `images-default`: sharp `^0.35.4` (libvips and libheif advisories).

## 5.2.0 – 2026-09-09

### Breaking

- `core`: `describe().input` and `describe().query` are enforced in production. Before every
  step the runner validates `ctx.body` against `input` and the declared query parameters against
  `query` (on a coerced copy: `"10"` → 10, `"true"` → true, one value → array where declared;
  undeclared query parameters are ignored); a mismatch answers `VALIDATION` 400 with `step` and
  `details.problems` instead of reaching the step (before: dev-only, 500 `INTERNAL`; never in
  production). Body schemas of the shipped modules are closed (`additionalProperties: false`)
  unless a step deliberately takes open objects, so unknown body fields are now rejected.
  `boot({ dev })` and `RunOptions.validateInput` are gone. The `Context` gains `body` and `query`
  (the HTTP body and query separately; `payload` stays their merge); `ContextInput` takes both.
  Module authors: every step that reads `ctx.payload` must declare `input`/`query` — a static
  test in the core's suite fails otherwise — and `testing/runPipeline` runs real steps with
  `modules: [{ module, instance }]`.
- `core`: the package exports a curated list of subpaths instead of `./*`: `.`, `./cast`,
  `./catalogue`, `./context`, `./dataflow`, `./defineConfig`, `./defineContract`,
  `./defineModule`, `./definePipeline`, `./errors`, `./load`, `./logger`, `./result`, `./runner`,
  `./schema`, `./testing/runPipeline`. No longer importable: `./boot` (use `boot` from the root),
  `./cli`, `./registry`, `./sort`, `./triggers/*` and every test file. ESLint now also guards
  `core` (no contract, module or host framework), `contracts` (only the core) and `h3` (no contract
  or module).

- `events@1`: a handler receives a shallowly frozen copy of the emitted data, so one handler can
  no longer change what the next one sees; assigning to it throws inside the handler. Rule 3
  (submodules emit no events) now names its one exception, `migrations.applied`, and the reason.
## 5.1.0 – 2026-09-08

- **breaking** `blobstore@1` is a byte store: `put(key, data, { contentType? })` takes the bytes and
  an optional content-type hint (stored as object metadata by `blobstore-s3`, ignored by
  `blobstore-filesystem`), `get` returns `Uint8Array | null`, `list` returns `{ key, size }`; the
  `Blob` type is gone. The module owning an object knows its type: media from `media_items`,
  images from the variant row's format, delivery from the file extension. `blobstore-filesystem`
  writes no `.meta.json` sidecars any more; the ones earlier versions left under its root are
  ignored by `list` and can be deleted once with `find <root> -name '*.meta.json' -delete`; keys
  ending in `.meta.json` stay rejected.
- `replication-sqlite`: `replication.snapshot` and `replication.prepareRestore` called before the
  first sync of a process no longer ship WAL segments into a `gen/null/` generation (the frames are
  covered by the snapshot the call takes); `replication.listPoints`, retention and restore ignore
  objects under a generation that is not a timestamp, so stray `gen/null/` segments written by
  earlier versions are invisible — delete them from the blobstore by hand.
## 5.0.3 – 2026-09-07

- `core`: `http.proxyHops` (default 1) and `http.trustedHeader`. With `trustProxy` the client address
  is now the `X-Forwarded-For` entry counted `proxyHops` from the right (the end proxies append to)
  instead of the spoofable left end, and a chain shorter than `proxyHops` yields no address; a
  `trustedHeader` names the client outright and a missing header yields no address. Without an
  address `http.allow` refuses the request and `ctx.ip` is absent. `clientIp(req, options)` takes an
  options object (the boolean form still works).
- `h3`: new handler options `proxyHops` and `trustedHeader` next to `trustProxy`;
  `createKestrelHandler` now derives `ctx.ip` through the core's `clientIp()` with the same
  precedence (trusted header, then the `X-Forwarded-For` entry `proxyHops` from the right, then
  the socket peer) instead of h3's left-most `X-Forwarded-For` entry. Behind a proxy that appends
  to the chain, `ratelimit.check` therefore buckets per real client again.
- `ratelimit-memory`: a request without a derivable client address is counted in one shared key
  `"unknown"` per bucket (documented; the behaviour itself is unchanged).

## 5.0.2 – 2026-09-07

5.0.1 was tagged but never published to npm; this release carries both changes.

- `core`: `http.allow` — a list of IPv4/IPv6 addresses or CIDR ranges the standalone HTTP server
  answers at all; every other client gets `403 forbidden` before routing (health and CORS preflight
  included). Empty or absent keeps the server open; the peer address is the socket's, or the first
  `X-Forwarded-For` entry with `http.trustProxy`; IPv4-mapped IPv6 peers are checked as IPv4. An
  entry that is neither an address nor a CIDR range is a boot error naming the entry.
- `validate-jsonschema`: a `schemas` entry may be the JSON Schema object itself instead of a file
  path, so a bundled build needs no schema files on disk. Inline schemas compile, sanitize and
  report exactly like file schemas; `watch` applies to files only.

## 5.0.0 – 2026-09-07

5.0.0 is a rewrite that replaces the 4.x line of `@michaelthielemann/kestrel` with
a new package set (`@michaelthielemann/kestrel*`, one version for all). There is no upgrade path
from 4.x; the model, config and API are new.

- `persistence@1`: a schema field may be declared as `{ type, unique: true }` (plain field types
  stay valid). `persistence-sqlite` backs it with a `UNIQUE INDEX` per field, so two concurrent
  writes with the same value can no longer both succeed; the second answers `CONFLICT` with
  `details: { collection, field }` (`createOne`, `createMany`, `updateOne`, `updateMany`).
  `ensureCollection` throws when existing rows already share a value, naming collection, field,
  value and count. `fakePersistence` mirrors both. `content-default` declares every `unique` model
  field per locale column and reports the constraint as the same field validation error as its
  pre-check; `authn-multi` declares `username` unique.
- **breaking** `core`: expected failures are values. New `@michaelthielemann/kestrel/result` exports
  `Result<T, E>` (`Ok`/`Err`) with `ok`, `err`, `isOk`, `isErr`, `match`, `unwrapOr`. A step is now
  `(ctx: Context) => Promise<Result<Context, KestrelError>>`: success is `return ok(ctx)` or
  `return ok({ ...ctx, result })`, failure is `return ctx.fail(...)`. A `throw` from a step is a bug
  and becomes a 500 `INTERNAL` as before.
- **breaking** `core`: one error model in `@michaelthielemann/kestrel/errors`.
  `KestrelError { code, status, message, retryable, details?, cause? }`, the core code list
  (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `FORBIDDEN`, `UNAUTHENTICATED`, `RATE_LIMITED`,
  `DANGLING_REF`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED`, `TRANSIENT`, `INTERNAL`), the single
  code → status table `STATUS_OF`, and the builders `failure(code, message, options?)` /
  `customFailure(code, status, message, options?)` (for codes a contract declares itself) plus the
  guard `isKestrelError`. `TRANSIENT` and `RATE_LIMITED` are the retryable codes.
- **breaking** `core`: `ctx.fail(status, message, details?)` becomes
  `ctx.fail(code, message, details?)` — the status comes from `STATUS_OF`, there is no status
  parameter. `ctx.fail(error)` passes a contract's `KestrelError` through unchanged
  (`if (isErr(r)) return ctx.fail(r.error)`). Both return an `Err` instead of throwing; `ctx.done`
  returns an `Ok` instead of throwing.
- **breaking** `core`: `PipelineFailure` and `PipelineDone` are removed. Nothing carries a failure
  as an exception any more, so the runner's only `catch` is the bug handler. A step returning
  anything but a `Result<Context>` is a 500 `INTERNAL` naming the step.
- **breaking** `core`: `RunResult` and the HTTP error body gain `code` and `retryable`; a failure
  reports `{ status, error, code, retryable, step, details? }`. A `KestrelError.cause` is logged,
  never serialized into the response. `StepLog.outcome` changes from `fail(<status>)` to
  `fail(<code>)`.
- **breaking** `core`: the HTTP error body is now `{ error, code, retryable, runId, step?, details? }`
  — `code` and `retryable` are always present. `buildResponse` sets a `Retry-After` header on a
  retryable 429 or 503, from `details.retryAfterSeconds` when it is a positive integer, else `1`.
  `errorResponse(status, error, requestId?)` (edge errors raised before a pipeline runs: unknown
  route, oversized or unparsable body) now assigns a fixed `code` by status
  (400 → `VALIDATION`, 404 → `NOT_FOUND`, 413 → `PAYLOAD_TOO_LARGE`, 500 → `INTERNAL`) and
  `retryable: false`.
- **breaking** `openapi`: the generated `Error` schema gains `code: { type: "string" }` and
  `retryable: { type: "boolean" }`, and `required` becomes `["error", "code", "retryable", "runId"]`
  to match the runtime error body. Every operation now defaults a `503` response alongside the
  existing `500` (any step can fail with `TRANSIENT`), and a `429` or `503` response documents a
  `Retry-After` header. `examples/minimal/openapi.json` is regenerated: it now documents the per-code statuses
  declared by the modules (`409` on `POST /pages` and `POST /users`, `413`/`415` on
  `POST /media`).
- **breaking** `core`: `describe()` is mandatory for every module that registers steps.
  `defineModule` requires a `describe` next to `steps` and `StepDescriptions<T>` demands an entry
  for every step key (a description function for a `stepFactory`, a plain object otherwise);
  `StepRegistry.register` refuses a step without a description, and `ResolvedStep.description` is
  no longer optional.
- **breaking** `core`: `StepDescription.summary` is required and every step declares
  `reads: ContextPath[]` and `writes: ContextPath[]` (either may be `[]`). A path is a context key
  optionally followed by dotted sub-keys (`^[a-zA-Z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)*\??$`); the
  trailing `?` marks a conditional write and is rejected in `reads`. `register` validates the
  grammar and names module and step in the `KestrelBootError`.
- **breaking** `core`: `boot()` checks the dataflow of every pipeline. Starting from the context keys
  a trigger fills (`payload`, `headers`, `files`, `ip`, `params`, plus the route params every http
  trigger of that pipeline binds), each step's `reads` must be covered by an earlier step's `writes`;
  an optional write (`identity?`) never satisfies a read, a write of `result` covers `result.<key>`
  and vice versa, and a plain `result` write replaces earlier `result.<key>` writes. A `params.<name>`
  read is rejected in a cron-only pipeline and in one whose http routes do not bind that param, and
  accepted under an event trigger (the envelope's params are opaque). `payload.*` reads are never
  checked. A violation is a `KestrelBootError` naming the pipeline, the step, the path and the earlier
  writes. New export `checkDataflow` from `@michaelthielemann/kestrel/dataflow`.
- **breaking** `contracts`: every async contract method returns `Promise<Result<T, E>>` instead of
  resolving with the value or rejecting. Absence stays inside the `Ok` (`Result<T | null, E>`);
  `throw` is reserved for wiring bugs (unknown collection/field/type/format, invalid key,
  `create` on a single type, `set` on a multi type, `id` in a persistence schema). Sync methods
  (`model`, `validate`, `pathOf`, `formats`, `targets`, `check`, `on`) are unchanged, and
  `validate@1` and `events@1` are unchanged as a whole.
- **breaking** `contracts`: each contract declares its error union — `PersistenceError`
  (`CONFLICT | NOT_FOUND | TRANSIENT`), `BlobstoreError` (`NOT_FOUND | TRANSIENT`), `ContentError`
  (`VALIDATION | NOT_FOUND | CONFLICT | TRANSIENT`), `AuthnError` / `AuthzError` / `SiteError`
  (`TRANSIENT`), `RendererError` (`TRANSIENT | RENDER_FAILED`), `MigrationsError`
  (`CONFLICT | TRANSIENT | MIGRATION_FAILED`). The two contract-specific codes come with the
  factories `renderFailed(message, cause?)` and
  `migrationFailed(message, { migration, document, locale?, problems? })`, both status 500; an
  implementation may return fewer codes than its union, never more. New
  `@michaelthielemann/kestrel-contracts/errors` re-exports `KestrelError`, `CoreCode`, `failure`,
  `customFailure`, `Result`, `ok`, `err`, `isErr` so a contract file needs one import path.
- **breaking** `contracts`: status changes carried by the new codes — a duplicate persistence id is
  `CONFLICT` (409) instead of a thrown 500, `updateOne` on a missing id is `NOT_FOUND` (404)
  instead of a throw, `blobstore.move` from a missing key is `NOT_FOUND`, and `content.get` /
  `content.list` with an unknown locale is `VALIDATION` (400) instead of a thrown 500.
- **breaking** `contracts`: the contract test suites assert failures as `Err` values. New
  `@michaelthielemann/kestrel-contracts/testing/result` exports `expectOk(result)` and
  `expectErr(result, code)`; `rejects.toThrow` is left only for the wiring bugs listed above.
  `createFakePersistence()` returns `Result`s and gains `failNext("TRANSIENT" | "CONFLICT")`, which
  makes the next call answer `Err` without touching the store, so a module test can pin that a step
  propagates a transient contract failure.
- **breaking** `persistence/sqlite`: the ten `persistence@1` methods return a `Result`. A single
  `run()` helper wraps every `node:sqlite` call: `SQLITE_BUSY`/`SQLITE_LOCKED` after the
  `busy_timeout` (primary result code 5 or 6, masked out of the extended `errcode`) becomes
  `Err(TRANSIENT)` — 503, retryable, `details.retryAfterSeconds: 1` — instead of a thrown 500, and
  `UNIQUE constraint failed` becomes `Err(CONFLICT)` (409), so `createOne` with an id that already
  exists reports a conflict instead of a generic `Error`. `updateOne` on a missing id is
  `Err(NOT_FOUND)` (404) instead of a throw, `deleteOne` on one stays `Ok`. Everything else — unknown
  collection, unknown field, `id` in a schema, a non-string for a string column — still throws.
  `createMany` keeps `BEGIN`/`COMMIT`/`ROLLBACK` around the loop and returns the first `Err`.
  Pragmas and `busyTimeoutMs` are unchanged.
- **breaking** `persistence/sqlite`: the seven steps return `Result` and carry a `describe()` entry
  with `summary`, `reads` and `writes`. `persistence.updateOne:<c>` and `persistence.deleteOne:<c>`
  answer `VALIDATION` for a missing `params.id`, `persistence.findOne:<c>` answers `NOT_FOUND`, and
  every step passes a contract failure through unchanged, so a locked database is a retryable 503.
  `persistence.checkpoint` and `persistence.snapshot:<file>` map a busy database to `TRANSIENT`
  too; the three maintenance calls on the module instance (`checkpoint`, `snapshot`, `close`) keep
  their synchronous, non-contract shape.
- **breaking** `blobstore-filesystem`: `put`/`get`/`remove`/`move`/`list` return `Result` per
  `blobstore@1`. `EBUSY`, `EAGAIN`, `EMFILE` and `ENFILE` from the underlying filesystem call become
  `Err(TRANSIENT)` instead of a thrown error; `ENOENT` on `get`/`remove` stays inside the `Ok`
  (`null` / `void`), and on `move` (source missing) is `Err(NOT_FOUND)`. Any other filesystem error,
  and an invalid or root-escaping key, still throws — those are bugs, not expected failures.
- **breaking** `blobstore-s3`: implements `blobstore@1`'s `Result` signatures. `move` from a missing
  source is `Err(NOT_FOUND)` instead of a throw. Once the SDK's own `maxAttempts` are spent,
  `put`/`get`/`remove`/`move`/`list` answer `Err(TRANSIENT)` for `$metadata.httpStatusCode` ≥ 500 or
  429, `$retryable`, an error `name` of `TimeoutError`/`NetworkingError`/`AbortError`, or a Node
  `code` of `ECONNRESET`/`ECONNREFUSED`/`ETIMEDOUT`/`EPIPE`/`EAI_AGAIN`; everything else (an invalid
  key, `AccessDenied`, a misconfigured bucket) still throws.
- **breaking** `renderer-plain`: `render` now returns `Result<RenderOutput, RendererError>` per the `renderer@1`
  contract; the module never returns `Err`, an unknown format still throws (wiring).
- **breaking** `validate-jsonschema`: `validate.check:<type>.<field>` returns `ctx.fail("VALIDATION",
  message, details)` instead of `ctx.fail(400, message)`; `details.problems` carries the same
  `{ path, message }[]` the error message text is built from, and each problem at the field's root
  (`path: "/"`) is duplicated into `details.fields` as `{ field, message }` so a client can map it
  like a `content@1` field error. `validate.sanitize`/`validate.sanitizeHtml`/`validate.check`
  declare `reads`/`writes` in `describe()`. `validate@1` itself is unchanged (still sync).
- **breaking** `events-inmemory`: the `events.emit` step returns `ok(ctx)` and gets a `describe()` entry. A failing
  handler pipeline run is logged with its `code` and `retryable` alongside the existing `status` and
  `error`.
- **breaking** `content/default`: the nine `content@1` methods return a `Result`. The three error
  classes exported from `./impl` — `ContentValidationError`, `ContentQueryError` and
  `ContentTranslationError` — are deleted. A field-level failure is `Err(VALIDATION)` carrying the
  unchanged message text (`pages: slug must be unique, "home" exists`) and
  `details.fields: FieldError[]`; an unknown `locale` option on `get`/`list`/`create`/`set`/`update`
  is `Err(VALIDATION)` (400) instead of a thrown 500 and an unknown `sort` field is `Err(VALIDATION)`
  too; `update` of a missing id and `removeTranslation` of a missing document or translation are
  `Err(NOT_FOUND)`, removing the last translation is `Err(CONFLICT)` (409, as before), and a
  persistence id collision on `create` is `Err(CONFLICT)`. Wiring bugs still throw: unknown type,
  `get` of a multi type without an id, `create` on a single type, `set` on a multi type, a filter on
  an unknown field, and a model the type check rejects; a failing `ensureCollection` during setup is
  a boot error.
- **breaking** `content/default`: the eight steps return `Result` and every one has a `describe()`
  entry with `summary`, `reads` and `writes` — `content.get:<t>` reads `params.id` only for a multi
  type, `content.update:<t>`, `content.remove:<t>` and `content.removeTranslation:<t>` read
  `params.id`, and every step but `content.validate:<t>` writes `result`. `ctx.fail(400, …)` becomes
  `ctx.fail("VALIDATION", …)` and the contract's failures are passed through unchanged, so a busy
  database is a retryable 503 on every step. `content.update:<t>` no longer pre-reads the document
  with `content.get` (the contract answers `NOT_FOUND` itself), which saves one read per update.
- **breaking** `authn-single`: `login`/`resolve`/`logout` implement `authn@1`'s `Result` signatures
  (never `Err` in practice — the module holds sessions in memory only, but the type matches the
  contract). `authn.login` and `authn.requireUser` answer `ctx.fail("UNAUTHENTICATED", ...)` (401)
  instead of `ctx.fail(401, ...)`. `authn.loadIdentity` and `authn.logout` declare
  `reads: ["identity"]` / `reads: ["token"]`, so boot's dataflow check requires a pipeline to run
  `authn.requireUser` first, and they keep answering `ctx.fail("UNAUTHENTICATED", ...)` (401) when
  identity or token is missing anyway — the same behaviour as `authn/multi`. Every step gets a
  `describe()` entry with `reads`/`writes`.
- **breaking** `authn/multi`: `login`/`resolve`/`logout` return `Result` per `authn@1` (wrong
  credentials are `Ok(null)`, never an `Err`); a `CONFLICT` from a random session-token collision on
  `login` is a bug and is rethrown as an `Error` instead of surfacing to the caller.
  `createUser`/`listUsers`/`getUser`/`setPassword`/`changePassword`/`setActive`/`cleanupSessions`
  also return `Result` and gain `VALIDATION`/`CONFLICT`/`NOT_FOUND`/`TRANSIENT`; `AuthnRejected` and
  `AuthnNotFound` are deleted. A duplicate username is `Err(CONFLICT)` (409) instead of a 400 — a
  breaking status change. `ensureCollection`/bootstrap failures during `setup()` are boot errors.
- **breaking** `authn/multi`: the thirteen steps return `Result` and every one has a `describe()`
  entry with `summary`, `reads` and `writes`; the `rejecting(ctx, status, fn)` helper is deleted, so
  every failure code is now decided in `impl.ts` instead of being flattened to one status per step.
  `authn.getUser`/`setPassword`/`deactivateUser`/`activateUser` read `params.id` — boot's dataflow
  check now proves every route binds it, so the old defensive "missing id" branch is a thrown bug
  path in those four steps instead of a response code (`authn.deactivateUser` keeps its own
  "cannot deactivate yourself" as `VALIDATION`). `authn.setPassword` no longer double-reports a
  missing password as part of a combined "id and password" message. Every contract-backed step
  passes a `TRANSIENT` persistence failure through unchanged, so a busy database is a retryable 503.
- **breaking** `authz-roles`: `can` implements `authz@1`'s `Result<boolean, AuthzError>` signature
  (always `Ok` — the module is config-only). `authz.require:<permission>` answers
  `ctx.fail("UNAUTHENTICATED", ...)` (401, no identity and `canAnonymous` denies it) or
  `ctx.fail("FORBIDDEN", ...)` (403, identity lacks the permission) instead of bare-status
  `ctx.fail`; `describe()` gains `reads: []`/`writes: []` (the peek at `identity` is optional
  consumption, not a declared read).
- **breaking** `ratelimit-memory`: `ratelimit.check:<bucket>` fails `Err(RATE_LIMITED)` (429) instead
  of `ctx.fail(429, …)`; `details.retryAfterSeconds` feeds the `Retry-After` header. `ratelimit.sweep`
  returns `ok({ ...ctx, result })`. Both steps get a `describe()` `reads`/`writes` entry.
- **breaking** `sanitize-svg`: `sanitize.svg` fails `Err(PAYLOAD_TOO_LARGE)` (413, was 400) for an
  oversize file and `Err(VALIDATION)` (400) for malformed markup instead of a bare `ctx.fail(400,
  …)`; on success it returns `ok({ ...ctx, files })`. `describe()` gains `reads: ["files"]` /
  `writes: ["files"]` and an `errors` map keyed by the new statuses.
- **breaking** `audit-persistence`: `Audit.record` returns `Result<void, PersistenceError>` instead
  of resolving silently; the `audit.record` step passes a persistence failure through
  (`ctx.fail(r.error)`), so a locked database now answers a retryable 503 instead of throwing
  through the pipeline as an unhandled rejection. New mandatory `describe()` entry
  (`reads: ["payload"]`, `writes: []`) — the module previously had none.
- **breaking** `site/default`: `resolve` and `resolveLinks` implement `site@1`'s `Result` signatures
  (`SiteError = KestrelError<"TRANSIENT">`); `resolve` answers `Ok(null)` for an unresolvable path
  (unchanged), and both propagate a `content@1` `TRANSIENT` failure — any other `content@1` code
  reaching them would be a bug and throws instead. `pathOf` stays synchronous. The two steps declare
  `describe().reads`/`writes` (`site.resolve:<t>` reads `params.path`, `site.resolveLinks:<t>` reads
  and writes `result`) and `site.resolve:<t>` answers `ctx.fail("NOT_FOUND", …)` instead of the old
  `ctx.fail(404, …)`; `site.resolveLinks:<t>` no longer tolerates a missing `result` (the dataflow
  check now guarantees an earlier step wrote it) and throws if one reaches it anyway.
- **breaking** `media/default`: every asynchronous method of the `Media` instance exported from
  `./impl` returns a `Result`, and the helpers `parseProvenance`, `safeFolder` and `checkPlainText`
  (renamed from `assertPlainText`) do the same. The error classes `MediaRejected` and `MediaConflict`
  are deleted: an invalid folder, provenance, locale or text is `Err(VALIDATION)`, a disallowed
  content type `Err(UNSUPPORTED)`, a file over `maxBytes` `Err(PAYLOAD_TOO_LARGE)`, a taken filename,
  a folder that already exists, a folder moved into itself and a non-empty folder without
  `recursive` are `Err(CONFLICT)`; every blobstore and persistence failure is passed through
  unchanged, so a busy database is a retryable 503 on every step. The message texts are unchanged.
  `migrateKeys` still never fails as a whole: an item whose blob or row operation fails is counted as
  `skipped` and logged. A failing `ensureCollection` or status backfill during `setup()` is a boot
  error, as is a failing `migrateKeys`.
- **breaking** `media/default`: `media.upload` answers `415 UNSUPPORTED` for a disallowed content
  type and `413 PAYLOAD_TOO_LARGE` for a file over `maxBytes` (both 400 before), and a taken filename
  is `409 CONFLICT` via the error model instead of the deleted `mapping()` helper. In a multi-file
  request the per-file entries in `errors` gain `code` next to `status`; a `TRANSIENT` blobstore or
  database failure is no longer a per-file entry (and no longer a thrown 500) but fails the whole
  request with 503.
- **breaking** `media/default`: the fourteen steps return `Result` and every one has a `describe()`
  entry with `summary`, `reads` and `writes` — `media.get`, `media.update`, `media.download` and
  `media.remove` read `params.id`, `media.renameFolder`, `media.folderItems` and `media.removeFolder`
  read `params.path`, `media.upload` reads `files`, and all fourteen write `result`.
  `ctx.fail(400/404/409, …)` becomes `ctx.fail("VALIDATION"/"NOT_FOUND"/"CONFLICT", …)`. An unknown
  `?locale=` on `media.list` is now a 400 even when the result would have been empty.
- **breaking** `references-default`: the seven `References` methods (`missing`, `index`, `unindex`,
  `referrers`, `scan`, `report`, `rebuild`) return a `Result`; only an unknown type or target still
  throws. `references.check:<type>` fails `Err(DANGLING_REF)` (400) instead of `ctx.fail(400, …)`,
  carrying `details.fields: FieldError[]` and `details.refs: [{ field, to, id }]`; the message text
  is unchanged. `references.guard:<target>` and `references.guardAll:<target>` fail `Err(CONFLICT)`
  (409, as before) with the referrer list in `details` (`referrers` / `referenced`); the message
  text the admin parses into a referrer list is unchanged. `references.index:<type>` declares
  `reads: ["result.id"]` in `describe()` instead of falling back to `params.id` and answering a
  bare 500 when neither is set — the boot dataflow check now proves every pipeline supplies it, and
  a missing id at runtime throws (a wiring bug, not an expected failure). `references.guardAll:<target>`
  gets the same treatment for `reads: ["result.ids"]`. Every step passes a contract failure through
  unchanged, so a busy database is a retryable 503 on every step. Every step gets a `describe()`
  entry with `summary`, `reads` and `writes`, including `references.index:<type>` and
  `references.unindex:<type>`, which previously had none.
- **breaking** `links-default`: the five `Links` methods (`extract`, `unextract`, `check`, `report`,
  `rebuild`) return a `Result`; only an unknown type still throws. A probed URL's own
  `ok`/`status`/`error` stays data on the index row, never a step failure — only a persistence
  failure while reading or writing the index fails a step. `links.extract:<type>` declares
  `reads: ["result.id"]` in `describe()` instead of falling back to `params.id` and answering a
  bare 500 when neither is set — the boot dataflow check now proves every pipeline supplies it, and
  a missing id at runtime throws (a wiring bug). `links.unextract:<type>` keeps its `ctx.fail(400,
  "missing id")` check as `Err(VALIDATION)`. Every step passes a contract failure through unchanged,
  so a busy database is a retryable 503 on every step; `describe()` gains `reads`/`writes` on every
  step.
- **breaking** `images/default`: every asynchronous method of the `Images` instance exported from
  `./impl` returns a `Result` (only `sizes()` and `publicPath()` stay plain, they read in-process
  state). The error classes `SizesRejected`, `SizesConflict` (`./sizes`) and `ImagesBusy` (`./impl`)
  are deleted: an empty or malformed registry, a prune name that is still declared or has no
  variants are `Err(VALIDATION)`, a registered size colliding with a config size and a start while a
  fresh job runs or the instance is shutting down are `Err(CONFLICT)`, and every persistence or
  blobstore failure is passed through unchanged, so a busy database is a retryable 503 on every
  step. `mergeSizes` returns `Result<SizeRow[], KestrelError<"CONFLICT">>` instead of throwing. The
  message texts are unchanged (they keep the `images: ` prefix the deleted `mapping()` helper used
  to add). A failing `ensureCollection` or the initial job read during `setup()` is a boot error.
- **breaking** `images/default`: the twelve steps return `Result` and every one has a `describe()`
  entry with `summary`, `reads` and `writes` — `images.remove` reads `params.id`, `images.serve`
  reads `params.id` and `params.file`, `images.removeMany` reads `result.ids`, `images.attach` reads
  `result` and writes `result.variants`, `images.export:<dir>` writes `result.variants`, and the
  remaining steps write `result`. `ctx.fail(400/404/409, …)` becomes
  `ctx.fail("VALIDATION"/"NOT_FOUND"/"CONFLICT", …)`; the wiring guards of `images.removeMany`
  ("no ids in result") and `images.attach` ("no media item(s) in result") are thrown bugs instead of
  a 500 response, because boot's dataflow check now proves an earlier step wrote them. A failed
  variant is still a 404 naming the attempt count, and a pending one still serves the original with
  `x-kestrel-variant: pending`.
- **breaking** `backup/blobstore`: `backup()`, `prepareRestore()` and `versions()` on the `Backup`
  instance exported from `./impl` return a `Result`; a missing backup key is `Err(NOT_FOUND)`
  (`no backup at <key>`) instead of the old `{ prepared: false, key, size: 0, file }` shape, and
  every blobstore failure is passed through unchanged, so a transient blobstore outage is a
  retryable 503 instead of an uncaught rejection. `restoreWhenMissing()` (called from `setup()`) and
  `applyPendingRestore()` still throw on a real failure — that stays a boot error.
- **breaking** `backup/blobstore`: the three steps (`backup.run`, `backup.restore`,
  `backup.listVersions`) return `Result` and every one has a `describe()` entry with `summary`,
  `reads` and `writes`. `backup.restore` keeps answering `VALIDATION` (400) for an unknown version
  and `NOT_FOUND` (404) for a missing backup key, both now carrying `code`/`retryable` through the
  error model instead of a bare status.
- **breaking** `replication/sqlite`: `sync()`, `snapshot()`, `points()` and `prepareRestore()` on the
  `Replication` instance, and the exported `restoreFromBlobs()`, return a `Result`; a restore point
  with no snapshot before it, or naming an unknown `generation`, is `Err(NOT_FOUND)` instead of a
  thrown `Error`, and every blobstore failure is passed through unchanged, so a transient blobstore
  outage is a retryable 503 instead of an uncaught rejection. `restoreOnStart` in `setup()` still
  throws on a real (non-`NOT_FOUND`) failure — that stays a boot error. The direct `node:sqlite`
  handling (`DatabaseSync`, checkpoints, WAL parsing in `wal.ts`) is unchanged.
- **breaking** `replication/sqlite`: the five steps return `Result` and every one has a `describe()`
  entry with `summary`, `reads` and `writes`. `replication.prepareRestore` now answers `VALIDATION`
  for an `at` payload value that does not parse as a number or an ISO-8601 date (silently ignored
  before) and `NOT_FOUND` for an unknown restore point, both carrying `code`/`retryable` instead of
  the bare `404` it threw before.
- **breaking** `redirects/default`: `Redirects.lookup`/`export`/`render` return `Result<…,
  KestrelError<"TRANSIENT">>`; a `content@1` or `blobstore@1` failure propagates as `TRANSIENT`
  (any other code reaching them would be a bug and throws instead), so a busy database or a down
  blobstore is a retryable 503 instead of the old thrown 500 — `redirects.export`'s
  "redirects.json was not written – try again" is now `TRANSIENT` (503) rather than a plain 500.
  `RedirectRuleError` stays an internal exception thrown at rule-compile time; `redirects.validate`
  still catches it, now as `ctx.fail("VALIDATION", …, { row })` (the row number parsed from the
  message, when present) instead of `ctx.fail(400, …)`. `redirects.lookup`'s `ctx.done(...)` returns
  an `Ok` marked with the `DONE` symbol instead of throwing `PipelineDone`. All four steps
  (`validate`, `lookup`, `export`, `render`) declare `describe().reads`/`writes` per the step
  catalogue.
- **breaking** `delivery/static`: `delivery.exportLlms` answers `503` with code `TRANSIENT`
  (retryable, `Retry-After`) instead of `500` when `llms.txt` could not be written; the message
  ("llms.txt was not written – try again") is unchanged. `delivery.publish:<type>` no longer falls
  back to `params.id` and no longer answers `500 "no document id in result or params"`: it declares
  `reads: ["result.id"]`, which the boot dataflow check proves, and throws if it runs without one
  anyway. `delivery.unpublish:<type>` and `delivery.readStatus:<type>` answer
  `ctx.fail("VALIDATION", "missing id")` instead of `ctx.fail(400, …)`. Every step declares
  `reads`/`writes` (`delivery.exportLlms` writes `result.llms`), and a transient failure of
  `persistence@1`, `blobstore@1`, `content@1` or `site@1` reaches the caller as a retryable 503
  instead of a 500.
- **breaking** `delivery/static`: the `Delivery` API behind the steps (`delivery-static/impl.ts`)
  returns `Result<T, KestrelError<"TRANSIENT">>` from `publish`, `unpublish`, `status`, `publishAll`
  and `exportLlms`; any other code from a dependency is a wiring bug and throws. A `renderer@1`
  `Err` (`RENDER_FAILED` or `TRANSIENT`) is recorded on the status row as `state: "error"` with its
  message and the remaining locales are still published — the behaviour a thrown render error had
  before.
- **breaking** `migrations/default`: `list`/`check`/`apply` return a `Result` per `migrations@1`.
  The `MigrationFailed` and `MigrationsBusy` classes are gone: a second `apply()` while one is in
  flight is `Err(failure("CONFLICT", "migrations: apply is running"))`, a migration whose `up`
  throws, whose patch a `validate@1` schema rejects, or whose write `content@1` rejects is
  `Err(migrationFailed(message, { migration, document, locale?, problems? }))` (500, unchanged
  message text), and a transient ledger or `content@1` failure propagates as `TRANSIENT` (503,
  retryable) instead of the old thrown 500 — any other `content@1` or `persistence@1` code reaching
  the module would be a wiring bug and throws. `runBoot` is unchanged from the outside: mode
  `"check"` still fails boot listing what is pending, mode `"apply"` now fails boot with the
  message of the `Err` that `apply()` returned.
- **breaking** `migrations/default`: both steps return `Result` and declare their dataflow —
  `migrations.list` and `migrations.apply` read nothing and write `result`; `migrations.apply`
  passes the contract's error through (`ctx.fail(r.error)`) instead of catching typed exceptions,
  so its statuses stay 409 and 500 but now carry `code` and `retryable`.
- `core`: new `@michaelthielemann/kestrel/cast` with `boundaryCast<T>(value, boundary)`
  (`"json" | "ast" | "dom" | "host"`) — the one sanctioned double cast at an untyped boundary.
- `core`: new `boot({ dev })`, default `process.env.NODE_ENV !== "production"`. In dev mode the runner
  validates `ctx.payload` against `describe().input` (with `describe().query` merged into its
  properties) before every step; a mismatch is a 500 `INTERNAL` naming the step, the pipeline and the
  failing path, logged with outcome `error`. Production never runs it. The validator is
  `validateSchema(schema, value)` in the new `@michaelthielemann/kestrel/schema` — the JSON Schema
  subset the shipped `describe()` blocks use (`type` incl. `integer` and array form, `properties`,
  `required`, `additionalProperties`, `items`, `enum`, `const`, `oneOf`, `anyOf`, `pattern`,
  `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`), no new dependency.
  `runPipeline(pipeline, input, logger, options?)` takes `{ validateInput }`, off by default.
- `core`: step names are a compile-time catalogue. `ModuleDefinition<Name, Steps>` carries its
  module name and step map in the type, `StepsOf<M>` / `StepCatalogue<Modules>` turn a module list
  into the union of the step names it registers (factories as `` `prefix.step:${string}` ``), and
  `pipelineDefiner<Known>()` returns a `definePipeline` bound to that union, so a misspelled or
  unloaded step in a pipeline file is a `tsc` error instead of a boot error.
  `PipelineDefinition<S>` is generic over the step name type and defaults to `string`.
- `content/default`: `validate()` reports an unknown `locale` option as the field error
  `{ field: "locale", message: 'unknown locale "…"' }` instead of throwing, so `content.validate:<t>`
  answers 400 with `details.fields` instead of a 500.
- `images/default`: a blobstore failure while writing one variant is recorded on that variant row
  (state `error`/`failed` with the message) exactly like a render failure, instead of aborting the
  whole `generate` call; a failure while reading the original still fails the call. Inside the sync
  job a persistence failure is recorded on the job row (`state: "error"`) and logged, as a thrown
  error already was.
- `examples/minimal`, `examples/embedded`: new `modules.ts` per example exports the `as const`
  module list, `KnownStep` (`StepCatalogue<typeof modules>`) and a `definePipeline` bound to it via
  `pipelineDefiner`; every pipeline file imports `definePipeline` from `./modules.ts` instead of
  `@michaelthielemann/kestrel/definePipeline`, so a misspelled step name is now a `tsc` error
  naming the closest match instead of a boot failure.
- `scripts/smoke-consumer.sh`: the generated consumer config used a literal `$1` as the
  `authn/single` `passwordHash`, which bash expanded inside the unquoted heredoc and aborted the
  script under `set -u`. The hash is now generated with `hashPassword("smoke")` before the heredoc.
- **breaking** `core`: `Context` gains a readonly `runId` (set by the runner, never settable from a
  payload or header) and an optional `requestId` taken from an incoming `x-request-id` header of
  short printable ASCII. Anything constructing a `Context` literal (test fakes) must supply `runId`.
- **breaking** `core`: `buildResponse(status, body, meta, extraInline)` takes `{ runId?, requestId? }`
  instead of a bare run id. New export `errorResponse(status, error, requestId?)` — the one shape for
  errors raised before a pipeline runs; the h3 adapter uses it instead of its own copy.
- `core`: `ctx.fail(status, message, details?)` accepts a plain object; `RunResult` and the HTTP error
  body gain `step` (the step the failure or throw happened in) and `details`. The body is now
  `{ error, runId, step?, details? }`; the `"<pipeline>/<step>: <message>"` text of a thrown error is
  unchanged. `content/default` passes `details: { fields: FieldError[] }` on a validation failure, so
  a client can map errors to fields without parsing text.
- `core`: `ContextInput` gains `parentRunId`, logged in every `step` line of the run. `events/inmemory`
  puts the emitting `runId` into the envelope and passes it as `parentRunId` when it starts a handler
  pipeline; cron runs have no parent. The `x-request-id` of a request appears in the `http` log line
  and is echoed as a response header by the core server and the h3 adapter alike.
- `core`: new `http.timeouts` config (`requestMs` 30000, `headersMs` 10000, `keepAliveMs` 5000) sets
  `server.requestTimeout`, `server.headersTimeout` and `server.keepAliveTimeout`.
- **breaking** `core`: `stop(options?: { timeoutMs })` resolves with `{ drained }`. It now closes the
  listener first, waits for in-flight runs and for connections still sending a request or receiving a
  response (deadline `timeoutMs` or the new top-level config `shutdownTimeoutMs`, default 30000),
  then drops the remaining connections, stops cron/event triggers and tears the modules down —
  requests in flight at SIGTERM are served instead of cut. The `kestrel` binary exits 1 when the
  deadline is hit and registers `unhandledRejection`/`uncaughtException` handlers that log through the
  logger, attempt a 5 s `stop()` and exit 1.
- `core`: a cron entry whose pipeline is still running from the previous tick is not started again;
  the tick logs a `warn` line naming the pipeline. `Logger` gains an optional `warn` method
  (implemented by `consoleLogger`/`silentLogger`, `logWarn(logger, …)` falls back to `info`).
- `audit/persistence`: entries store the envelope's `eventId` and a redelivered event with a known id
  is skipped. `persistence@1` has no unique constraint, so the check is a read before the write and
  two concurrent deliveries can still both pass it.
- `media-default`: `media_items` gains `status` (`uploading` | `ready` | `failed`) and `checksum`
  (sha256 of the uploaded bytes, hex). `media.upload` writes the row first, then the blob, then
  flips the row to `ready`; a failing blob write leaves `status: "failed"` and rethrows, and a later
  upload of the same name replaces that row instead of colliding with it. `media.get` and
  `media.download` 404 for anything not `ready`, `media.list` (including `?ids=`) filters it out.
  `media.remove` deletes the row before the blob and only logs a failing blob delete. A rename moves
  the blob back when the row update fails. Both fields are additive: existing rows read as
  `checksum: null` and `status: "ready"`.
- `media-default`: new step `media.reconcile` — compares the blobs under the configured prefix with
  the `media_items` keys and returns `{ blobsWithoutRow, rowsWithoutBlob }`; `payload.delete: true`
  deletes the orphan blobs (never rows), keys under `media-variants/` are left to `images-default`.
  No trigger is wired; consumers should call it from a cron pipeline. The companion step
  `media.reconcileDelete` always deletes, so a pipeline can offer the report and the cleanup as two
  routes without trusting a request flag (a step is either a plain step or a `stepFactory`, so
  `media.reconcile` cannot carry an optional argument).
- **breaking** `media-default`: an upload without `provenance` is recorded as `{ origin: "unknown" }`
  instead of `{ origin: "human" }`, and rows written before the field read as `unknown` too — a
  missing declaration is not evidence that a human made the file, which is the wrong default for AI
  labelling. `origin` accepts `human | ai | mixed | unknown`. `media.download` sets
  `X-Content-Provenance` for every origin but `human`, so such items now carry
  `X-Content-Provenance: unknown`. Callers that mean "a human uploaded this" must send it.
- **breaking** `images-default`: sizes declared in code are no longer persisted. Config/default sizes
  are rebuilt from the config at every boot and registered sizes live in the process that took them,
  rebuilt by every `images.register` call; `images_sizes` rows written by earlier versions are
  deleted once at setup with a log line naming the count. A host that registers sizes must register
  them at boot (`kestrel.run("registerImageSizesBoot", …)`), otherwise the instance only knows the
  config/default sizes after a restart. `images.listSizes` still returns the merged view with
  `source`. `images.readStatus` now reports as `orphaned` the sizes that still have variants but are
  no longer declared (instead of leftover registered rows), and `images.prune` deletes those
  variants; pruning a still-declared size or a name without variants is a 400.
- `examples/minimal`: `createPage`/`updatePage` check the body against its schema again after
  `validate.sanitize:pages.body`, so what is stored is schema-valid; the first `validate.check` stays
  in front of the sanitize step, which needs a schema-valid structure to walk.
- **breaking** `images-default`: a variant is retried at most `maxAttempts` times (config, default 5).
  The last failure sets `state: "failed"` instead of `"error"`; sync and resume skip those rows, and
  `images.readStatus` reports `variants.failed` next to `done`/`pending`/`error`. `images.serve`
  404s for a failed variant instead of serving the original in its place, naming the size, the
  attempt count and the last error; a `pending` variant still falls back to the original, now with
  the header `x-kestrel-variant: pending` instead of `fallback`. Changing a size definition lifts the
  quarantine and restores the full attempt budget. A persistence error while recording a failed sync
  job is now logged instead of swallowed.
- Engines: every package requires Node `>=22.13.0` — `node:sqlite` (persistence-sqlite) runs unflagged
  only from that version; earlier 22.x needs `--experimental-sqlite`.
- **breaking** `content@1`: new method `removeTranslation(type, id, locale)` — every provider must
  implement it. `content-default` nulls every localized field of that locale (non-localized fields stay)
  and returns the document in the default locale; unknown locale → `ContentValidationError`, missing
  document or translation → `ContentTranslationError` 404, the last remaining translation → 409 (the
  default locale may be removed while another translation exists). Step
  `content.removeTranslation:<type>` (locale from the route param or `?locale=`) maps these to
  400/404/409. `examples/minimal`: `DELETE /pages/:id/translations/:locale` → `deletePageTranslation`
  (index, extract, publish, llms export, event `page.translationRemoved`).
- `delivery-static`: new step `delivery.exportLlms` and config `llms` (`siteUrl`, `full`, `settings`,
  `titleField`, `seoField`, `headings`; defaults to enabled with paths only, a missing settings type
  leaves only the fallback header) writing `<prefix>llms.txt` (always) and `<prefix>llms-full.txt`
  (`full: true`, needs the `html` format; the stored HTML restricted to `<main>` is converted with
  turndown) from the live publish status rows, skipping `seo.noindex`; the step adds
  `llms: { entries, full }` to the result. `examples/minimal` gains `settings.description`, `pages.seo`
  and the step in `createPage`/`updatePage`/`deletePage`/`setSettings`/`publishAllPages`.
- New module `migrations-default` (`migrations@1`): consumer content migrations `{ id, collection,
  up }` applied once per document and stored locale, validated against the model and — when a
  `validate@1` provider is loaded — the consumer's JSON schemas, recorded in `content_migrations`
  only after success; boot mode `apply` | `check` (boot refuses with the pending list) | `off`;
  steps `migrations.list` / `migrations.apply` (`payload.dry`); one `migrations.applied` event per
  run, never a per-document `<type>.updated`. Helpers export `./helpers`: `defineMigration`,
  `mapBlocks`, `renameBlock`, `renameProp`, `omit`.
- New contract `validate@1` (`targets`, `check`), provided by `validate-jsonschema`.
- `core`: `defineModule({ optional: [CONTRACT] })` orders a module after that provider when one is
  loaded; `deps.find(CONTRACT)` returns the instance or `undefined`.
- `references-default`: a document referencing itself no longer counts as a referrer — `referrers`,
  `referrersMany`, `guard` and `guardAll` ignore self-references, so a page whose link points to
  itself can be deleted.
- `validate-jsonschema`: a failed `{ type: "null" }` branch of a nullable union is no longer reported
  when a deeper problem under the same path explains the failure (the admin used to show "must be
  null" on a repeater container next to the real row error).
- `contracts/testing`: `fakePersistence` mirrors SQLite semantics — reads null-fill schema fields
  absent from the stored document, and a field outside the schema throws (filters, sort, create,
  update) instead of silently matching nothing; the persistence contract test covers both against
  the fake and `persistence-sqlite`.
- `validate-jsonschema`: a discriminated `oneOf` (all branches tagged by `properties.type.const`) no
  longer lets non-object values (`null`, strings, numbers, arrays) pass — ajv's `discriminator` only
  constrains objects, so `withDiscriminators` now also pins `type: "object"` on the union node (and
  leaves a union whose declared type is not `object` untouched).
- `content-default`: `content.get:<single>` answers 200 with an empty document (every model field `null`, `_translations` all
  `false` when locales exist, `_locales: {}` with `?fallback=true`) while the singleton was never set;
  The empty document goes through the step's fixed filter like any other, so
  `content.get:settings?status=published` still answers 404 until something is published; 404 stays for multi types. OpenAPI no longer lists 404 for single-kind `get` steps.
- **breaking**: a step that takes an argument (`content.get:pages`) must be wrapped in
  `stepFactory()` from `@michaelthielemann/kestrel/context`. A `Step` and a `StepFactory` are both
  one-argument functions, so the registry could not tell them apart and called a plain step with the
  argument string to find out. Resolving a step now fails at boot when a factory is used without an
  argument or a plain step with one, and never calls the step to decide. Every shipped module is
  wrapped; third-party modules with factory steps must be updated.
- `core`: boot rejects a config whose `modules` entries are out of order with the loaded modules
  (only when an entry demonstrably names a different loaded module), a module that provides a
  contract but registers its steps under another prefix, and two http triggers that resolve to the
  same route pattern (`GET /pages/:id` and `GET /pages/:slug`). The per-module "requires X which is
  not registered" check is gone; `sortModules` already refuses a missing provider and orders
  providers first.
- `core`: `matchRoute` picks the most specific route (literal before `:param` before `*rest`)
  regardless of registration order, and no longer throws on a malformed percent-escape; an encoded
  `/` in a wildcard tail no longer matches. Router-level responses (health, 400, 404, 413, 500) and
  CORS preflights carry `x-kestrel-run-id` and the mandatory security headers, and a binary result's
  own headers can add to but no longer overwrite them. `content-disposition` follows RFC 6266 with
  an ASCII fallback plus `filename*` for non-ASCII names. Same for the h3 adapter.
- `authz-roles`, `backup-blobstore`, `ratelimit-memory`, `replication-sqlite`,
  `validate-jsonschema`: the instance no longer reaches its steps through a module-level variable,
  so a second `boot()` in the same process no longer takes over the first one's steps. `authz@1`
  implementations from `authz-roles` expose `canAnonymous`.
- `contracts`: `fakePersistence` mirrors SQLite storage semantics (typed columns, ASCII-only `LIKE`
  folding, binary string collation, nulls first ascending, structural json comparison), and the
  persistence contract test pins them for every implementation.
- `examples/minimal`: `GET /pages/:id` only serves published pages, `GET /admin/pages/:id`
  (`pages.manage`) serves any; `createPage`/`updatePage` validate before sanitizing so an
  over-nested payload is rejected before the recursive sanitizer walks it.
- `core`: event triggers are contributed by modules, not wired by the core. `defineModule` accepts
  `triggers: { event(instance, entries, run, logger) }`; boot collects the modules offering the hook
  and calls it in `start()` with the configured event entries, pushing the returned stop function
  onto the shutdown list. Boot no longer looks up `events@1` by name (and no longer casts it): event
  triggers without such a module fail at boot with "event triggers need a module that provides an
  event trigger hook", two modules offering the hook fail naming both, and a module providing its own
  `events@1` with different method names now fails at boot instead of throwing in `start()`.
  `events-inmemory` provides the hook. `EventEntry`, `ModuleTriggers` and `Runner` are exported from
  `@michaelthielemann/kestrel`.

- `media-default`: `media.upload` now processes every file of a multipart request, not just the
  first. Exactly one file keeps today's response (the item, unchanged); two or more return
  `{ items: MediaItem[], errors: [{ filename, status, message }], ids: string[] }` — a rejected
  (400) or conflicting (409) file is recorded in `errors` and does not stop the others (partial
  success, 200). `events.emit:<name>` now also puts `result.ids` on the envelope as `ids` (`id`
  stays `null` for a bulk result). `images.generate` accepts `payload.ids` (from a bulk
  `media.uploaded` event) and generates variants for each, skipping unknown ids.
- **breaking**: repeated query parameters (`?tag=a&tag=b`) now arrive in `ctx.payload` as
  `string[]` instead of collapsing onto the last value; a single occurrence still arrives as
  `string`. Core and the h3 adapter parse identically (`parseQuery`, exported from `@michaelthielemann/kestrel`).
  Steps that expect a scalar read it through the new `first(value)` helper from
  `@michaelthielemann/kestrel/context`.

- `examples/embedded` (and `examples/h3`, which mounts the same config): `createPage` now runs
  `authn.requireUser` + `authz.require:pages.write` like the canonical example in
  `docs/PIPELINES.md`. The config loads `authn-single` (user `editor`, password `kestrel-demo`)
  and `authz-roles`, and a `login` pipeline on `POST /login` hands out the token.

- `examples/minimal`: `setSettings` validates `navigation` against the new
  `schemas/settings.navigation.json` (list of `{ label, path, children? }`, no other properties,
  400 with path and reason). `media-default` now validates `alt`, `title` and `description` as plain
  text (max 2000 characters, no control characters except tab and newline, 400
  `media/default: <field> must be plain text (max 2000 chars)`) instead of running them through the
  HTML allowlist, which would have rewritten legitimate text such as `5 < 6`.

- `core`: boot refuses `http.inlineTypes` containing `image/svg+xml` when no module registers the
  step `sanitize.svg` – inline SVG delivery is now tied to the sanitizer the docs assume
 .

- **breaking**: `events.emit:<name>` now sends `{ event, at, identity, params, id }` instead of
  `{ event, at, identity, params, result }`. `id` is derived from `ctx.result.id` →
  `ctx.result.document.id` → `ctx.params.id` → `null`; `result` is included only with the step
  argument `events.emit:<name>?with=result`. `images.generate` now reads the media id
  from `payload.id` only (the `payload.result.id` fallback is gone).

- `core`: JSON log lines from `consoleLogger` (`step`, `info`, `error`) now start with `time` — a
  local ISO 8601 timestamp with milliseconds and UTC offset.

- `core`: the context is now shallowly frozen between steps (`createContext` and after each step in
  `runPipeline`). A step that mutates a context field in place now throws a `TypeError` and fails the
  pipeline with status 500 instead of silently mutating shared state; `{ ...ctx, result }` and
  `return ctx` keep working as before. `payload`, `params`, `headers`, `files`, and `result` contents
  stay mutable.

- **breaking**: renamed read-only steps to verbs and prefixed module collections with their module
  segment. No data migration — existing deployments regenerate the collections and get
  regenerated (`publishAll` for delivery status, boot registration + `images.sync` for the image
  registry/variants).

  | Kind | Old | New |
  |---|---|---|
  | Step | `delivery.status` | `delivery.readStatus` |
  | Step | `images.sizes` | `images.listSizes` |
  | Step | `images.status` | `images.readStatus` |
  | Step | `media.folders` | `media.listFolders` |
  | Step | `replication.points` | `replication.listPoints` |
  | Step | `replication.status` | `replication.readStatus` |
  | Step | `backup.versions` | `backup.listVersions` |
  | Collection | `publish_status` | `delivery_publish_status` |
  | Collection | `image_sizes` | `images_sizes` |
  | Collection | `image_variants` | `images_variants` |
  | Collection | `image_jobs` | `images_jobs` |

First shape of the system:

- core: contracts via `defineContract`, boot check, pipeline runner, HTTP/event/cron triggers,
  multipart uploads and binary results, `kestrel` CLI
- contracts: persistence@1, authn@1, authz@1, blobstore@1, events@1, content@1 (i18n, enum, ref, completeWhen), site@1, renderer@1
- core: /health, X-Kestrel-Run-Id, nosniff/no-store on every response, access log, client ip with trustProxy
- core: `ctx.done(result)` ends a pipeline early with status 200 (counterpart of `ctx.fail`)
- modules: events-inmemory, persistence-sqlite, authn-single, authn-multi, authz-roles, ratelimit-memory, content-default,
  references-default, links-default, blobstore-filesystem, blobstore-s3, media-default, backup-blobstore,
  audit-persistence
- kestrel-openapi: OpenAPI 3.1 from triggers, pipelines and step descriptions (`describe()` in defineModule)
- sanitize-svg + core http.inlineTypes: sanitized SVG uploads served inline
- validate-jsonschema: payload fields against JSON Schema files (ajv); HTML sanitizing at format:"html" positions (sanitize-html); `watch` reloads changed schema files without restart
- replication-sqlite: Litestream-style continuous replication (snapshots + WAL segments), PITR, retention
- delivery-static + renderer-plain: static delivery with publish status per locale
- media-default: provenance (human/ai/mixed) per item, X-Content-Provenance on download
- adapter kestrel-h3: HTTP triggers as an h3 event handler for Nuxt/Nitro (`examples/h3`)
- embedded mode: `http: null`, `kestrel.triggers` + `matchRoute` for host frameworks (`examples/embedded`)
- example consumer under `examples/minimal`
- core: modules receive `deps.logger`; optional `teardown()` runs on `kestrel.stop()` in reverse boot order; boot failures after setup tear down already-constructed modules
- redirects-default: admin-managed redirect rules; `redirects.lookup` in site resolution, `redirects.json` exported to the blobstore for an edge proxy
- blobstore@1: `move(from, to)` (filesystem rename, S3 copy+delete)
- media-default: persistent folders (create/rename/delete routes), blob keys `media/<folder>/<filename>`
  (`prefix` config) so the filesystem blobstore mirrors the library without colliding with replication
  snapshots, the static site or `redirects.json`; one-off key migration on boot, resumable after an
  interrupted move; references.guardAll step; `GET /media/folders` no longer reports a `""` entry for
  items in the root
- blobstore-filesystem: `move`/`remove` prune directories they empty (the root stays);
  blobstore-s3: `CopySource` keeps its slashes and percent-encodes the segments
- media-default: `media.list` with `recursive: true` matches the exact subtree of `folder` via a range
  scan instead of a LIKE prefix, so sibling folders like `2026x` or `2026-alt` no longer match `2026`
- blobstore-s3: `pnpm test:s3` runs the `blobstore@1` contract test against MinIO in Podman
- kestrel-openapi: `StepDescription.extendsOutput` merges a step's additions into the output schema of the
  preceding step instead of replacing it (`redirects.export` now shows `redirects` on
  `POST /admin/publish-all/pages` and `PUT /redirects`)
- images-default: image variants (size registry, generation on upload, resumable sync job, prune,
  attach/serve/export) on top of `media-default`, WebP only, original untouched
- delivery-static: optional `media` config copies referenced originals and `done` variants into the
  site export (`<prefix><target><folder>/<filename>[.<size>.<ext>]`) and rewrites their URLs in the
  rendered output; unresolved references are logged and left untouched; a resolved reference whose
  blob is missing, or a media row with an unsafe folder/filename, fails the publish instead of
  writing a broken or escaping path; the URL match is now segment-bounded (`/file-x` no longer matches `/file`)
- references-default: `references.referrersMany:<target>` step and `GET /admin/references/to/<target>?ids=a,b,c`
  routes batch up to 200 referrer lookups in one request, alongside the existing single-id routes
- references-default: internal links inside `json` fields (block trees) are indexed alongside `ref`
  fields — every `kestrel:<type>:<id>` and `{ type: "internal", collection, id }` per locale, mapped
  through the configured targets; each index row and every `referrers`/`referrersMany`/`report` entry
  carries `via: "field" | "body"`, so `references.guard`/`guardAll` now refuse deleting media or pages
  that are only used in a block; `INTERNAL_REF`/`collectInternalRefs` moved to `kestrel-contracts/links`
- **breaking** site@1 + site-default: the website vocabulary leaves `content@1`, which is now generic
  document CRUD. `SiteRules`, `LinkTarget` and `resolveLinks` are gone from `content@1` (`LinkTarget`
  now lives in `kestrel-contracts/links`); path ↔ document resolution, `pathOf` and the rewriting of
  `kestrel:<type>:<id>` are the new contract `site@1`, provided by `site-default`. The steps
  `content.resolve:<t>` and `content.resolveLinks:<t>` are renamed to `site.resolve:<t>` and
  `site.resolveLinks:<t>`, and configs that resolve site paths must activate
  `@michaelthielemann/kestrel-site-default` after `content-default`. `delivery-static` requires
  `site@1` in addition. The HTTP surface is unchanged.
- contracts: the query vocabulary (`Filter`, `Condition`, `FindOptions`, `Page`) moved to its own
  `kestrel-contracts/query`, shared by `persistence@1`, `content@1`, `site@1`; `content@1` no longer
  imports from `persistence.ts`; `kestrel-contracts/persistence` still re-exports the same names
- events@1: `emit` is documented as synchronous and now aggregates handler errors into an
  `AggregateError` instead of stopping at the first one; the `events.emit:<name>` step logs a
  listener failure instead of failing the emitting pipeline
- docs: submodule template allows flat helper files; README rule by content
- `persistence-sqlite`: every connection now also sets `PRAGMA busy_timeout` (new optional config
  `busyTimeoutMs`, default 5000 — a locked database makes the caller wait instead of failing at once
  with `SQLITE_BUSY`), `PRAGMA foreign_keys = ON` and `PRAGMA synchronous = NORMAL` next to the WAL
  mode it already used. The README documents the pragmas and states the one-process assumption
  (`replication-sqlite`'s second connection in the same process is supported, a second process on
  the same file is not).
- **breaking** `backup-blobstore`: `backup.restore` no longer writes over the open database. It
  downloads the blob to `<file>.restore-pending` and writes the marker `<file>.restore-marker`; the
  module's `setup()` swaps both in on the next start (removing `<file>`, `-wal` and `-shm` first) and
  logs `applied pending restore`. A marker without a staged file is dropped. The step result is now
  `{ key, size, file, pending: true, appliedOnRestart: true }` instead of `{ restored, key, size }` —
  callers must restart the process for a restore to take effect. `Backup.restore()` is replaced by
  `prepareRestore()` (stage) and `restoreWhenMissing()` (the boot path for `restoreOnStart`).
- `blobstore-s3`: the S3 client is configured with explicit timeouts and a retry limit instead of the
  SDK defaults — new config `timeoutMs` (default 10000, used as both `connectionTimeout` and
  `requestTimeout`) and `maxAttempts` (default 3).
- `delivery-static`, `images-default`: the module's `Config` type is derived from `configSchema`
  (`z.output`) instead of a hand-written interface cast with `as unknown as`. Since `llms` carries a
  schema default it is always present, `delivery.exportLlms` no longer has an "llms is not
  configured" path.
- `content-default`: `content.list:<t>` validates its query parameters — `limit` and `offset` must be
  integers (`limit` >= 1, `offset` >= 0), `limit` at most the new config `maxLimit` (default 200),
  and an unknown `sort` field now throws `ContentQueryError` (exported from `./impl`) instead of a
  generic `Error`. All four cases fail the run with 400 instead of being silently dropped or
  answering 500; the OpenAPI query schema carries `maximum: maxLimit`.
- `openapi`: the `Error` component schema documents the optional `step` and `details` fields the HTTP
  error body can carry.
