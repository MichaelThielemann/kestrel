# persistence/sqlite
`persistence@1` on top of Node's built-in `node:sqlite` (no native dependency). One table per
collection, `id TEXT PRIMARY KEY`, columns from the schema (`boolean` as 0/1, `json` as text).
`ensureCollection` adds missing columns to existing tables; it never drops or retypes them. A field
declared as `{ type, unique: true }` gets a `UNIQUE INDEX` (`<collection>_<field>_unique`; `NULL`
stays repeatable, as in SQLite); the index is dropped again when the declaration goes. Existing rows
that already share a value make `ensureCollection` throw (collection, field, value, count) – boot
fails instead of running on data the index cannot cover.
Config: `{ file: "./data/kestrel.db", busyTimeoutMs?: 5000 }` or `file: ":memory:"`. Directories are
created on setup.

Pragmas set on every connection: `journal_mode = WAL` (readers never block the writer),
`busy_timeout = <busyTimeoutMs>` (default 5000 – a locked database makes the caller wait that long
before the call answers `Err(TRANSIENT)`; `0` restores the SQLite default of giving up at once),
`foreign_keys = ON` and `synchronous = NORMAL`. `NORMAL` is the WAL-safe choice: a
process crash cannot corrupt the database, only the last transactions can be lost if the *machine*
loses power – pair it with `backup/blobstore` or `replication/sqlite` rather than with `FULL`.

**One process, one writer.** The module assumes it is the only process that opens `file`, and
makes sure of it: before it opens the file, `setup()` takes the instance lock on it, the sidecar
`<file>.instance` next to the database. A second *process* on the same file – a standalone
`kestrel` CLI next to a running server, a second dev server, two containers on a shared volume –
fails to boot with `instance-locked`, naming the host and PID of the process that holds the file
for a readable lock (an unreadable lock file is named instead), and leaves the file as it is. Writes are only serialised inside one process, and restores swap the
file before it is opened, so point each process at its own file, or route all writes through one
of them. `replication/sqlite` and `backup/blobstore` on the same file in the same process share the
lock; `replication/sqlite` also opens a second connection to the file (it holds a read transaction
and runs its own checkpoints), which is supported. Teardown closes the connection and gives the
lock up; the lock file goes with the last module of the process that holds it. `:memory:` takes no
lock. `health()` reports `ok: false` with `restartRequired: true` once another instance took the
lock over. To share the file between processes on purpose, set `allowConcurrentProcesses: true`
here and on every other module that names the file; a module of the same file without it fails
the boot with `invalid-module-config`. The lock never enters the database or a
`persistence.snapshot`; see "One process per database file" in `docs/configuration.md` of the
kestrel repository for the restart behaviour after an unclean stop.

Every `persistence@1` method returns a `Result`. A `SQLITE_BUSY`/`SQLITE_LOCKED` after the busy
timeout is `Err(TRANSIENT)` (503, `retryable`, `details.retryAfterSeconds: 1`), a
`UNIQUE constraint failed` is `Err(CONFLICT)` (409) – `createOne` with an id that already exists
included; for a unique field the error carries `details: { collection, field }` and applies to
`createOne`, `createMany`, `updateOne` and `updateMany` alike. `updateOne` on a missing id is `Err(NOT_FOUND)`, `deleteOne` on one is `Ok`. Everything
else – unknown collection, unknown field, `id` in a schema, a non-string for a string column –
stays a throw, because it is a wiring bug. A `createMany` outside a group whose `COMMIT` fails with
an error SQLite reports (an I/O error, say) rolls back and answers `Err(TRANSIENT)`. `node:sqlite`
reports the *extended* result code in `errcode` (a primary-key collision is 1555), so the mapping
masks it with `0xff` to get the primary code: 5 `SQLITE_BUSY`, 6 `SQLITE_LOCKED`, 19
`SQLITE_CONSTRAINT`.

**Statement cache.** Each connection keeps up to 256 prepared statements, keyed by their SQL text, and
drops the least recently used one beyond that. A statement's text depends on the collection, the filter's
fields and operators (an `eq` or `ne` against `null` and an empty `in` list each have their own form), the
length of an `in` list, the sort and the fields an update patches, in their order. `LIMIT` and `OFFSET`
are bound parameters, so pages of any size share one statement. `ensureCollection` and `close()` empty
the cache.

**Counting.** `findMany` returns `total`, the number of matches, not only those on the page. A page that holds every
match (no `limit` and no `offset`, or a short page at offset 0) knows its total without a second query;
otherwise the module runs a `COUNT(*)` over the same filter. A call that passes `withTotal: false`
gets the page without `total` and no count runs, which matters for a scan over a large collection that only
walks pages.

`persistence.snapshot:<file>` writes a transactionally consistent copy via
`VACUUM INTO` (safe while writes are in flight) – back that file up, not the live database.
`persistence.checkpoint` folds the WAL into the main file. Both are `Promise<void>`, routed through
the same mutex as every other call – they wait for an open scope and hold the connection while they
run – and signal a locked database by throwing; the steps turn that into the same `TRANSIENT` the
contract methods return.

| Step | reads | writes | errors |
|---|---|---|---|
| `persistence.checkpoint` | – | – | `TRANSIENT` |
| `persistence.snapshot:<file>` | – | `result` | `TRANSIENT` |
| `persistence.createOne:<c>` | – | `result` | `CONFLICT`, `TRANSIENT` |
| `persistence.findOne:<c>` | `params.id` | `result` | `NOT_FOUND`, `TRANSIENT` |
| `persistence.findMany:<c>` | – | `result` | `TRANSIENT` |
| `persistence.updateOne:<c>` | `params.id` | `result` | `VALIDATION`, `NOT_FOUND`, `CONFLICT`, `TRANSIENT` |
| `persistence.deleteOne:<c>` | `params.id` | `result` | `VALIDATION`, `TRANSIENT` |

**Transactions across calls.** A pipeline's atomic group (`{ atomic: [...] }`, see the core's
`pipelines.md`) runs as one `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK` on the module's single
connection. `IMMEDIATE` takes the write lock at `BEGIN` rather than on the first write, so a group
that reads before it writes (`references.check` before `content.create`, for example) cannot lose a
snapshot to a writer that committed in between. `createMany` joins an outer scope instead of opening
a nested transaction.

One FIFO queue makes every public method – inside a group or not – wait for the connection in call
order; a step's own calls made from inside the group's own async flow run directly, without
queueing behind themselves. Everything waits, including a concurrent read: the module has one
connection, so a read outside the group must not observe the group's uncommitted rows. Two
independent budgets bound the wait: `acquireTimeoutMs` bounds how long a call or a group may wait
for its turn, `scopeTimeoutMs` bounds how long a group may hold the connection once it has it, timed
from `BEGIN IMMEDIATE`. A call still waiting when `acquireTimeoutMs` runs out answers
`Err(TRANSIENT)`, a group a failed `begin`, and neither runs afterwards, even if the connection
frees up in that same moment. A group that outlasts `scopeTimeoutMs` rolls back and answers
`TRANSIENT` with `details: { reason: "scope-timeout", pipeline }`; the answer for a call or group that
timed out waiting carries no `reason`. `checkpoint()` and `snapshot()` wait for their turn without this
budget. `acquireTimeoutMs` defaults to `busyTimeoutMs + 10000` (`15000` when `busyTimeoutMs`
is also left at its own default of `5000`). Setup rejects an explicit `acquireTimeoutMs` that does not
exceed `busyTimeoutMs`, naming the key – `BEGIN IMMEDIATE` blocks the event loop for up to
`busyTimeoutMs`, so an equal budget would expire exactly when the wait succeeded.

Both budgets are timers, so they are enforced only when the event loop gets a turn. SQLite work runs
synchronously and blocks the loop: a budget that runs out while a statement is running takes effect
once that statement returns. Neither budget covers SQLite's own busy wait on a lock that another
connection to the same file holds; that wait happens inside the statement and `busyTimeoutMs`
bounds it. A group's `BEGIN IMMEDIATE` can wait up to `busyTimeoutMs` for such a lock before its
`scopeTimeoutMs` starts, so with `acquireTimeoutMs` at or below `scopeTimeoutMs + busyTimeoutMs` a
single group can outlast a waiter's budget: a call queued behind it answers `Err(TRANSIENT)` while
the group still holds the connection. Setup allows that, and logs a warning naming the three
values.

A scope that closes leaves the store in one of two terminal states, and a call a step started
without awaiting behaves differently depending on which: after a **commit**, a late call takes the
normal queued path and writes for real (with a warning logged); after a **rollback or a timeout**, a
late call throws – it is not executed – because the group's writes are gone and the call would store
a fragment of a transaction that never happened.

**A `ROLLBACK` that fails while a transaction stays open.** Rolling back is not expected to fail;
when it does and the connection still reports an open transaction, or the database was closed
underneath the group so its state cannot be read, the module can neither finish that transaction
nor prove it finished. It then marks the store unusable: from that point every call answers
`Err(TRANSIENT)`, naming the reason and that the process needs a restart, because serving writes
from that connection could turn one incident into silent corruption. That covers the calls and
groups already waiting for their turn too: none of them runs on the connection. A group answers a
failed `begin` with that error, and `checkpoint()`/`snapshot()` reject with an error the steps
answer as the same `TRANSIENT`. The transaction `createMany` runs on its own outside a group is
treated the same way: when its `ROLLBACK` fails with the transaction still open, that `createMany`
answers the same `Err(TRANSIENT)`, or rethrows the wiring error it was rolling back for. A
`ROLLBACK` that fails because SQLite already rolled the transaction back on its own (after some I/O
errors, for example) leaves no transaction open, so it is not a failed rollback and the store stays
usable.

The module declares `health()`, synchronous and with no I/O, which reports that unusable state as
`{ ok: false, reason, restartRequired: true }` and otherwise `{ ok: true }`; lock contention and ordinary
failed calls never change it. A host's readiness and liveness probes can read it through
`kestrel.health()` (see the core's `architecture.md`) instead of waiting for a request to hit
`TRANSIENT`.

Not included: migrations beyond adding columns, savepoints or nested groups, full-text search.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-persistence-sqlite` – module `persistence/sqlite`: provides `persistence@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `file` | string | yes | – |
| `busyTimeoutMs` | integer | no | – |
| `acquireTimeoutMs` | integer | no | – |
| `scopeTimeoutMs` | integer | no | `5000` |
| `allowConcurrentProcesses` | boolean | no | `false` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `persistence.checkpoint` | Fold the write-ahead log into the main database file | – | – | – | – | – | – | no |
| `persistence.snapshot:<arg>` | Write a transactionally consistent copy of the database to <arg> | – | `result` | – | { file: string, … } | – | – | no |
| `persistence.createOne:<arg>` | Create one <arg> document from the payload | – | `result` | object | object | 409 a document with that id or a unique value already exists | – | no |
| `persistence.findOne:<arg>` | Read the <arg> document named by params.id | `params.id` | `result` | – | object | 404 no such document | – | no |
| `persistence.findMany:<arg>` | List every <arg> document | – | `result` | – | { items: object[], total: number, … } | – | – | no |
| `persistence.updateOne:<arg>` | Patch the <arg> document named by params.id from the payload | `params.id` | `result` | object | object | 400 missing id; 404 no such document; 409 a unique value already exists | – | no |
| `persistence.deleteOne:<arg>` | Delete the <arg> document named by params.id | `params.id` | `result` | – | { ok: true, … } | 400 missing id | – | no |

<!-- kestrel-docs:end -->
