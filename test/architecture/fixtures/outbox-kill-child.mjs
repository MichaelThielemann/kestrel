// Spawned by `outbox-durability.test.ts` as a real child process (not imported) — the whole point is to
// perform a commit and then be SIGKILLed by the parent, so this has to be a separate OS process, and it
// deliberately stays plain JS: no TS loader is a real project dependency, so the SQL here re-derives (does
// not import) the outbox_content shape from `layers/core/server/db/outbox.ts` and the `useDb()` pragmas
// from `layers/core/server/utils/db.ts` — kept in sync by hand, the same way the migration SQL mirrors the
// Drizzle table it was generated from.
import Database from 'better-sqlite3'

const [, , dbPath] = process.argv
const sqlite = new Database(dbPath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('synchronous = NORMAL')

sqlite.exec(`CREATE TABLE IF NOT EXISTS durability_probe (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL
)`)
sqlite.exec(`CREATE TABLE IF NOT EXISTS outbox_content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope TEXT NOT NULL,
  aggregate_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  processed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  dead INTEGER NOT NULL DEFAULT 0
)`)

const aggregateKey = 'probe:1'

sqlite.transaction(() => {
  const { lastInsertRowid: recordId } = sqlite.prepare('INSERT INTO durability_probe (title) VALUES (?)').run('kill-test record')
  const { maxSeq } = sqlite.prepare('SELECT MAX(sequence) as maxSeq FROM outbox_content WHERE aggregate_key = ?').get(aggregateKey)
  const sequence = (maxSeq ?? 0) + 1
  const envelope = JSON.stringify({
    id: 'kill-test-envelope', name: 'probe.created', version: 1,
    aggregate: { collection: 'probe', recordId: Number(recordId) },
    sequence, correlationId: 'kill-test', causation: { pipeline: 'killTest', op: 'killTest' },
    occurredAt: new Date().toISOString(), payload: { id: Number(recordId) },
  })
  sqlite.prepare('INSERT INTO outbox_content (envelope, aggregate_key, sequence) VALUES (?, ?, ?)').run(envelope, aggregateKey, sequence)
})()

// `db.transaction()` above already returned — the write is committed. Signal the parent, then hang so the
// parent's SIGKILL (not a normal exit) is what ends this process.
process.stdout.write('COMMITTED\n')
setInterval(() => {}, 1000)
