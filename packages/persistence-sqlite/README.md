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
stays a throw, because it is a wiring bug.

`persistence.snapshot:<file>` writes a transactionally consistent copy via
`VACUUM INTO` (safe while writes are in flight) – back that file up, not the live database.
`persistence.checkpoint` folds the WAL into the main file.

| Step | reads | writes | errors |
|---|---|---|---|
| `persistence.checkpoint` | – | – | `TRANSIENT` |
| `persistence.snapshot:<file>` | – | `result` | `TRANSIENT` |
| `persistence.createOne:<c>` | – | `result` | `CONFLICT`, `TRANSIENT` |
| `persistence.findOne:<c>` | `params.id` | `result` | `NOT_FOUND`, `TRANSIENT` |
| `persistence.findMany:<c>` | – | `result` | `TRANSIENT` |
| `persistence.updateOne:<c>` | `params.id` | `result` | `VALIDATION`, `NOT_FOUND`, `CONFLICT`, `TRANSIENT` |
| `persistence.deleteOne:<c>` | `params.id` | `result` | `VALIDATION`, `TRANSIENT` |

Not included: migrations beyond adding columns, transactions across calls, full-text search.
