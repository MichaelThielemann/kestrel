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

**One process, one writer.** The module assumes it is the only process that opens `file`.
`replication/sqlite` opens a second connection to the same file inside the same process (it holds a
read transaction and runs its own checkpoints); that is supported. A second *process* on the same
file – a standalone `kestrel` CLI next to a running server, a second dev server, two containers on
a shared volume – is not: writes are only serialised inside one process, and restores swap the file
before it is opened. Point each process at its own file, or route all writes through one of them.

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
frees up in that same moment. `checkpoint()` and `snapshot()` wait for their turn without this
budget. `acquireTimeoutMs` defaults to `busyTimeoutMs + 10000` (`15000` when `busyTimeoutMs`
is also left at its own default of `5000`). Setup rejects an explicit `acquireTimeoutMs` that does not
exceed `busyTimeoutMs`, naming the key – `BEGIN IMMEDIATE` blocks the event loop for up to
`busyTimeoutMs`, so an equal budget would expire exactly when the wait succeeded.

Both budgets are timers, so they are enforced only when the event loop gets a turn. SQLite work runs
synchronously and blocks the loop: a budget that runs out while a statement is running takes effect
once that statement returns. Neither budget covers SQLite's own busy wait on a lock that another
connection to the same file holds; that wait happens inside the statement and `busyTimeoutMs`
bounds it. With `acquireTimeoutMs` at or below
`scopeTimeoutMs`, a single group can outlast a waiter's budget: a call queued behind a group that
runs longer than `acquireTimeoutMs` answers `Err(TRANSIENT)` while the group still holds the
connection. Setup allows that, and logs a warning naming both values.

A scope that closes leaves the store in one of two terminal states, and a call a step started
without awaiting behaves differently depending on which: after a **commit**, a late call takes the
normal queued path and writes for real (with a warning logged); after a **rollback or a timeout**, a
late call throws – it is not executed – because the group's writes are gone and the call would store
a fragment of a transaction that never happened. After a rollback that itself fails, the store
answers `Err(TRANSIENT)` to every subsequent call, naming the reason and that the process needs a
restart; the connection's state can no longer be proven, and continuing to serve writes from it
would turn one incident into silent corruption. That includes every call and group already waiting
for its turn when the rollback failed: none of them runs on the connection. A group answers a failed
`begin` with that error, and `checkpoint()`/`snapshot()` reject with an error the steps answer as
the same `TRANSIENT`. The same holds for the transaction `createMany` runs on its own outside a
group: when its `ROLLBACK` fails, that `createMany` already answers the same `Err(TRANSIENT)`, or
rethrows the wiring error it was rolling back for. A `ROLLBACK` that fails because SQLite already
rolled the transaction back on its own (after some I/O errors, for example) leaves no transaction
open and does not count as a failed rollback.

That unusable state is also readable without provoking a call: the module declares `health()`,
synchronous and with no I/O, so a host's readiness probe learns it needs to stop routing traffic
here, and a liveness probe learns the process needs a restart, before the next request would have
hit `TRANSIENT` anyway. See `kestrel.health()` in the core's `architecture.md`.

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
