import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { syncSchema, planOps, isDestructive, describeOp, opTable, type SyncDb } from '../../../src/server/schema/sync.js'
import { introspect } from '../../../src/server/schema/introspect.js'
import { desiredSchema } from '../../../src/server/schema/desired.js'
import { buildTable, defineCollection } from '../../../src/index.js'

// better-sqlite3's `pragma()` returns `unknown`; `SyncDb` narrows it to `Row[]` (see introspect.ts) — cast at the crossing.
function asSyncDb(db: Database.Database): SyncDb {
  return db as unknown as SyncDb
}
const things = buildTable(defineCollection({
  name: 'things', mode: 'multi', translatable: false,
  fields: { slug: { type: 'text', required: true, unique: true }, title: { type: 'text' } },
}))
const more = buildTable(defineCollection({ name: 'more', mode: 'single', translatable: false, fields: { data: { type: 'json' } } }))

// same table 'thing' with and without the `legacy` field — drives drop-column / rebuild
const withLegacy = buildTable(defineCollection({ name: 'thing', mode: 'multi', translatable: false, fields: { keep: { type: 'text' }, legacy: { type: 'text' } } }))
const withoutLegacy = buildTable(defineCollection({ name: 'thing', mode: 'multi', translatable: false, fields: { keep: { type: 'text' } } }))

const colNames = (db: Database.Database, table: string) =>
  (db.pragma(`table_info("${table}")`) as { name: string }[]).map((c) => c.name)

describe('syncSchema — additive', () => {
  it('creates tables + indexes on an empty db and reports the applied statements', () => {
    const db = new Database(':memory:')
    const desired = desiredSchema([things])
    const { applied, skipped } = syncSchema(asSyncDb(db), desired)
    expect(applied.some((s) => s.startsWith('CREATE TABLE `things`'))).toBe(true)
    expect(applied.some((s) => s.includes('CREATE UNIQUE INDEX `things_slug_unique`'))).toBe(true)
    expect(skipped).toEqual([])
    expect(planOps(asSyncDb(db), desired)).toEqual([]) // in sync now
    db.close()
  })

  it('is idempotent — a second sync applies nothing', () => {
    const db = new Database(':memory:')
    const desired = desiredSchema([things, more])
    syncSchema(asSyncDb(db), desired)
    expect(syncSchema(asSyncDb(db), desired).applied).toEqual([])
    db.close()
  })

  it('additively adds a new collection while preserving existing rows', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([things]))
    db.prepare("INSERT INTO things (slug, created_at, updated_at) VALUES ('a', 0, 0)").run()
    const { applied } = syncSchema(asSyncDb(db), desiredSchema([things, more]))
    expect(applied.some((s) => s.includes('CREATE TABLE `more`'))).toBe(true)
    expect(db.prepare('SELECT count(*) AS c FROM things').get()).toEqual({ c: 1 })
    db.close()
  })
})

describe('syncSchema — destructive gate', () => {
  it('withholds a destructive rebuild by default, leaving the DB intact', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([withLegacy]))
    db.prepare("INSERT INTO thing (keep, legacy, created_at, updated_at) VALUES ('v', 'x', 0, 0)").run()
    const { applied, skipped } = syncSchema(asSyncDb(db), desiredSchema([withoutLegacy]))
    expect(applied).toEqual([])
    expect(skipped.map((o) => o.type)).toEqual(['rebuild_table'])
    expect(colNames(db, 'thing')).toContain('legacy')
    db.close()
  })

  it('applies the rebuild with allowDestructive, dropping the column but preserving surviving data', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([withLegacy]))
    db.prepare("INSERT INTO thing (keep, legacy, created_at, updated_at) VALUES ('v', 'x', 0, 0)").run()
    const { applied, skipped } = syncSchema(asSyncDb(db), desiredSchema([withoutLegacy]), { allowDestructive: true })
    expect(applied.length).toBeGreaterThan(0)
    expect(skipped).toEqual([])
    expect(colNames(db, 'thing')).not.toContain('legacy')
    expect(db.prepare('SELECT keep FROM thing').get()).toEqual({ keep: 'v' })
    db.close()
  })

  it('preserves the AUTOINCREMENT high-water mark across a rebuild (ids are never reused)', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([withLegacy]))
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO thing (keep, created_at, updated_at) VALUES ('v', 0, 0)").run()
    db.prepare('DELETE FROM thing WHERE id = 3').run() // top row gone; AUTOINCREMENT high-water stays 3
    syncSchema(asSyncDb(db), desiredSchema([withoutLegacy]), { allowDestructive: true }) // rebuild drops `legacy`
    const r = db.prepare("INSERT INTO thing (keep, created_at, updated_at) VALUES ('after', 0, 0)").run()
    expect(r.lastInsertRowid).toBe(4) // 4, not 3 — the deleted id 3 is not reused
    db.close()
  })

  it('drop_table needs explicit per-table opt-in — allowDestructive alone never drops a table', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([things, more]))
    // default + blanket allowDestructive both withhold the drop (so an unmanaged table is never lost)
    expect(syncSchema(asSyncDb(db), desiredSchema([things])).skipped.map((o) => o.type)).toEqual(['drop_table'])
    expect(syncSchema(asSyncDb(db), desiredSchema([things]), { allowDestructive: true }).applied).toEqual([])
    // only naming the table drops it
    const dropped = syncSchema(asSyncDb(db), desiredSchema([things]), { dropTables: ['more'] })
    expect(dropped.applied).toEqual(['DROP TABLE `more`;'])
    expect(introspect(asSyncDb(db)).more).toBeUndefined()
    db.close()
  })
})

describe('syncSchema — tables scoping (per-module migration)', () => {
  it('applies only ops on the named tables, leaving the rest pending', () => {
    const db = new Database(':memory:')
    const desired = desiredSchema([things, more])
    const { applied, skipped } = syncSchema(asSyncDb(db), desired, { tables: ['things'] })
    expect(applied.some((s) => s.startsWith('CREATE TABLE `things`'))).toBe(true)
    expect(applied.some((s) => s.includes('`more`'))).toBe(false)
    expect(skipped).toEqual([])
    // `more` is still pending — scoping withheld it, not applied-and-skipped
    expect(new Set(planOps(asSyncDb(db), desired).map(opTable))).toEqual(new Set(['more']))
    db.close()
  })

  it('an empty table list applies nothing', () => {
    const db = new Database(':memory:')
    const { applied } = syncSchema(asSyncDb(db), desiredSchema([things]), { tables: [] })
    expect(applied).toEqual([])
    db.close()
  })

  it('a second scoped call picks up the remaining table', () => {
    const db = new Database(':memory:')
    const desired = desiredSchema([things, more])
    syncSchema(asSyncDb(db), desired, { tables: ['things'] })
    const second = syncSchema(asSyncDb(db), desired, { tables: ['more'] })
    expect(second.applied.some((s) => s.startsWith('CREATE TABLE `more`'))).toBe(true)
    expect(planOps(asSyncDb(db), desired)).toEqual([])
  })
})

describe('opTable', () => {
  it('reads the table name off create_table + create_index (same table)', () => {
    const db = new Database(':memory:')
    const ops = planOps(asSyncDb(db), desiredSchema([things]))
    expect(ops.map((o) => o.type)).toEqual(['create_table', 'create_index'])
    expect(ops.map(opTable)).toEqual(['things', 'things'])
    db.close()
  })

  it('reads the table name off a rebuild_table and a drop_table', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([withLegacy, more]))
    db.prepare("INSERT INTO thing (keep, legacy, created_at, updated_at) VALUES ('v', 'x', 0, 0)").run()
    const ops = planOps(asSyncDb(db), desiredSchema([withoutLegacy]))
    expect(ops.find((o) => o.type === 'rebuild_table')).toBeDefined()
    expect(ops.find((o) => o.type === 'drop_table')).toBeDefined()
    expect(new Set(ops.map(opTable))).toEqual(new Set(['thing', 'more']))
    db.close()
  })
})

describe('syncSchema — renames (data-preserving)', () => {
  const oneOld = defineCollection({ name: 'art', mode: 'multi', translatable: false, fields: { content: { type: 'text' } } })
  const oneNew = defineCollection({ name: 'art', mode: 'multi', translatable: false, fields: { body: { type: 'text', renamedFrom: 'content' } } })
  const dropOld = defineCollection({ name: 'art', mode: 'multi', translatable: false, fields: { content: { type: 'text' }, legacy: { type: 'text' } } })

  it('a pure rename is an ALTER RENAME COLUMN (no rebuild, no opt-in) and keeps the data', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([buildTable(oneOld)]))
    db.prepare("INSERT INTO art (content, created_at, updated_at) VALUES ('hello', 0, 0)").run()
    const { applied } = syncSchema(asSyncDb(db), desiredSchema([buildTable(oneNew)], new Map([['art', oneNew]])))
    expect(applied).toEqual(['ALTER TABLE `art` RENAME COLUMN `content` TO `body`;'])
    expect(db.prepare('SELECT body FROM art').get()).toEqual({ body: 'hello' })
    db.close()
  })

  it('a rename coinciding with a rebuild renames first, so the rebuild keeps the renamed data', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([buildTable(dropOld)]))
    db.prepare("INSERT INTO art (content, legacy, created_at, updated_at) VALUES ('keep', 'drop', 0, 0)").run()
    const { applied } = syncSchema(asSyncDb(db), desiredSchema([buildTable(oneNew)], new Map([['art', oneNew]])), { allowDestructive: true })
    expect(applied[0]).toBe('ALTER TABLE `art` RENAME COLUMN `content` TO `body`;')
    expect(applied.some((s) => s.includes('CREATE TABLE `__kestrel_new_art`'))).toBe(true)
    expect(db.prepare('SELECT body FROM art').get()).toEqual({ body: 'keep' })
    expect(colNames(db, 'art')).not.toContain('legacy')
    db.close()
  })

  it('withholds a rename that only makes sense as a rebuild prologue when the rebuild itself is withheld', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([buildTable(dropOld)]))
    db.prepare("INSERT INTO art (content, legacy, created_at, updated_at) VALUES ('keep', 'drop', 0, 0)").run()
    // same rename+rebuild plan as above, but WITHOUT allowDestructive — the bare rename must not ship alone
    const { applied, skipped } = syncSchema(asSyncDb(db), desiredSchema([buildTable(oneNew)], new Map([['art', oneNew]])))
    expect(applied).toEqual([])
    expect(skipped.map((o) => o.type).sort()).toEqual(['rebuild_table', 'rename_column'])
    expect(colNames(db, 'art')).toContain('content')
    expect(colNames(db, 'art')).not.toContain('body')
    db.close()
  })
})

describe('syncSchema — relation/media single↔multiple toggle (shape transform)', () => {
  const single = defineCollection({ name: 'gal', mode: 'multi', translatable: false, fields: { cover: { type: 'media' } } })
  const multi = defineCollection({ name: 'gal', mode: 'multi', translatable: false, fields: { cover: { type: 'media', options: { multiple: true } } } })

  it('single→multiple wraps the scalar id into a json array (data preserved)', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([buildTable(single)], new Map([['gal', single]])))
    db.prepare('INSERT INTO gal (cover_id, created_at, updated_at) VALUES (42, 0, 0)').run()
    const { applied } = syncSchema(asSyncDb(db), desiredSchema([buildTable(multi)], new Map([['gal', multi]])), { allowDestructive: true })
    expect(applied.some((s) => s.includes('json_array'))).toBe(true)
    expect(colNames(db, 'gal')).toContain('cover')
    expect(colNames(db, 'gal')).not.toContain('cover_id')
    expect(db.prepare('SELECT cover FROM gal').get()).toEqual({ cover: '[42]' })
    db.close()
  })

  it('multiple→single unwraps the first id (narrowing)', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([buildTable(multi)], new Map([['gal', multi]])))
    db.prepare("INSERT INTO gal (cover, created_at, updated_at) VALUES ('[7,8]', 0, 0)").run()
    syncSchema(asSyncDb(db), desiredSchema([buildTable(single)], new Map([['gal', single]])), { allowDestructive: true })
    expect(colNames(db, 'gal')).toContain('cover_id')
    expect(colNames(db, 'gal')).not.toContain('cover')
    expect(db.prepare('SELECT cover_id FROM gal').get()).toEqual({ cover_id: 7 })
    db.close()
  })
})

describe('planOps / isDestructive', () => {
  it('plans without mutating and classifies destructive ops', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([withLegacy]))
    const ops = planOps(asSyncDb(db), desiredSchema([withoutLegacy]))
    expect(colNames(db, 'thing')).toContain('legacy') // dry run did not mutate
    expect(ops.filter(isDestructive).map((o) => o.type)).toEqual(['rebuild_table'])
    db.close()
  })

  it('describeOp names the affected table for destructive ops', () => {
    expect(describeOp({ type: 'drop_table', name: 'more' })).toBe('drop table `more`')
  })

  it('describeOp names the affected table/column/index for additive ops (not a bare op-type name)', () => {
    const table = { name: 'things', columns: [{ name: 'id', type: 'integer', notNull: true, primaryKey: true, autoIncrement: true, default: null }], indexes: [] }
    const column = { name: 'slug', type: 'text', notNull: false, primaryKey: false, autoIncrement: false, default: null }
    const index = { name: 'things_slug', table: 'things', columns: ['slug'], unique: false, where: null }
    expect(describeOp({ type: 'create_table', table })).toBe('create table `things` (1 column(s))')
    expect(describeOp({ type: 'add_column', table: 'things', column })).toBe('add column `things`.`slug` text')
    expect(describeOp({ type: 'create_index', index })).toBe('create index `things_slug` on `things` (slug)')
    expect(describeOp({ type: 'drop_index', index })).toBe('drop index `things_slug` on `things`')
    expect(describeOp({ type: 'rename_column', table: 'things', from: 'old', to: 'slug' })).toBe('rename column `things`.`old` to `slug`')
  })
})

describe('syncSchema — additive feasibility (fail loud, change nothing)', () => {
  // Pure add_column: an existing collection gains a required field, nothing else changes → a single
  // additive `add_column` op (NOT a rebuild). SQLite rejects `ADD COLUMN … NOT NULL` with no default on
  // a POPULATED table, so it must fail loud BEFORE the transaction — not abort mid-apply.
  const pcOld = buildTable(defineCollection({ name: 'pc', mode: 'multi', translatable: false, fields: { keep: { type: 'text' } } }))
  const pcNew = buildTable(defineCollection({ name: 'pc', mode: 'multi', translatable: false, fields: { keep: { type: 'text' }, req: { type: 'text', required: true } } }))

  it('rejects adding a required field to a POPULATED collection (pure add_column) — applies nothing', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([pcOld]))
    db.prepare("INSERT INTO pc (keep, created_at, updated_at) VALUES ('v', 0, 0)").run()
    const ops = planOps(asSyncDb(db), desiredSchema([pcNew]))
    expect(ops.some((o) => o.type === 'add_column')).toBe(true)
    expect(ops.some((o) => o.type === 'rebuild_table')).toBe(false) // genuinely additive, not a rebuild
    expect(() => syncSchema(asSyncDb(db), desiredSchema([pcNew]))).toThrow(/pc\.req/)
    expect(colNames(db, 'pc')).not.toContain('req')
    db.close()
  })

  it('allows adding a required field to an EMPTY collection (SQLite permits ADD COLUMN NOT NULL on no rows)', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([pcOld]))
    const { applied } = syncSchema(asSyncDb(db), desiredSchema([pcNew]))
    expect(applied.length).toBeGreaterThan(0)
    expect(colNames(db, 'pc')).toContain('req')
    db.close()
  })

  // Pure create_index: an existing column gains `unique: true`, nothing else → a standalone
  // `create_index` op. A UNIQUE index over existing duplicates aborts, so probe up front.
  const ucOld = buildTable(defineCollection({ name: 'uc', mode: 'multi', translatable: false, fields: { code: { type: 'text' } } }))
  const ucNew = buildTable(defineCollection({ name: 'uc', mode: 'multi', translatable: false, fields: { code: { type: 'text', unique: true } } }))

  it('rejects making an existing column UNIQUE while current rows hold duplicates — applies nothing', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([ucOld]))
    db.prepare("INSERT INTO uc (code, created_at, updated_at) VALUES ('x', 0, 0)").run()
    db.prepare("INSERT INTO uc (code, created_at, updated_at) VALUES ('x', 0, 0)").run()
    const ops = planOps(asSyncDb(db), desiredSchema([ucNew]))
    expect(ops.some((o) => o.type === 'create_index')).toBe(true)
    expect(ops.some((o) => o.type === 'rebuild_table')).toBe(false)
    expect(() => syncSchema(asSyncDb(db), desiredSchema([ucNew]))).toThrow(/uc_code_unique|duplicate/)
    expect((db.pragma('index_list("uc")') as { name: string }[]).some((i) => i.name === 'uc_code_unique')).toBe(false)
    db.close()
  })

  it('allows making an existing column UNIQUE when current rows are distinct', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([ucOld]))
    db.prepare("INSERT INTO uc (code, created_at, updated_at) VALUES ('x', 0, 0)").run()
    db.prepare("INSERT INTO uc (code, created_at, updated_at) VALUES ('y', 0, 0)").run()
    const { applied } = syncSchema(asSyncDb(db), desiredSchema([ucNew]))
    expect(applied.some((s) => s.includes('CREATE UNIQUE INDEX'))).toBe(true)
    db.close()
  })
})

describe('syncSchema — rebuild feasibility (fail loud, change nothing)', () => {
  // same table 'ta' gains a required field while another is dropped (forces a rebuild)
  const aOld = buildTable(defineCollection({ name: 'ta', mode: 'multi', translatable: false, fields: { keep: { type: 'text' }, legacy: { type: 'text' } } }))
  const aNew = buildTable(defineCollection({ name: 'ta', mode: 'multi', translatable: false, fields: { keep: { type: 'text' }, req: { type: 'text', required: true } } }))
  // optional field flipped to required while rows hold NULL
  const bOpt = buildTable(defineCollection({ name: 'tb', mode: 'multi', translatable: false, fields: { note: { type: 'text' } } }))
  const bReq = buildTable(defineCollection({ name: 'tb', mode: 'multi', translatable: false, fields: { note: { type: 'text', required: true } } }))

  it('rejects a new NOT NULL column with no default on a populated table — applies nothing', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([aOld]))
    db.prepare("INSERT INTO ta (keep, created_at, updated_at) VALUES ('v', 0, 0)").run()
    expect(() => syncSchema(asSyncDb(db), desiredSchema([aNew]), { allowDestructive: true })).toThrow(/ta\.req/)
    expect(colNames(db, 'ta')).toContain('legacy')
    db.close()
  })

  it('rejects flipping a column to NOT NULL while existing rows hold NULL', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([bOpt]))
    db.prepare('INSERT INTO tb (created_at, updated_at) VALUES (0, 0)').run() // note = NULL
    expect(() => syncSchema(asSyncDb(db), desiredSchema([bReq]), { allowDestructive: true })).toThrow(/tb\.note/)
    db.close()
  })

  it('a feasible NOT NULL flip (no offending NULL rows) is allowed', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([bOpt]))
    db.prepare("INSERT INTO tb (note, created_at, updated_at) VALUES ('here', 0, 0)").run()
    const { applied } = syncSchema(asSyncDb(db), desiredSchema([bReq]), { allowDestructive: true })
    expect(applied.length).toBeGreaterThan(0)
    expect(db.prepare('SELECT note FROM tb').get()).toEqual({ note: 'here' })
    db.close()
  })

  // newly-unique column whose existing rows already hold duplicates, while a dropped field forces a rebuild
  const dupOld = buildTable(defineCollection({ name: 'dup', mode: 'multi', translatable: false, fields: { code: { type: 'text' }, legacy: { type: 'text' } } }))
  const dupNew = buildTable(defineCollection({ name: 'dup', mode: 'multi', translatable: false, fields: { code: { type: 'text', unique: true } } }))

  it('rejects a rebuild that would recreate a UNIQUE index over duplicate existing data', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([dupOld]))
    db.prepare("INSERT INTO dup (code, created_at, updated_at) VALUES ('x', 0, 0)").run()
    db.prepare("INSERT INTO dup (code, created_at, updated_at) VALUES ('x', 0, 0)").run()
    expect(() => syncSchema(asSyncDb(db), desiredSchema([dupNew]), { allowDestructive: true })).toThrow(/dup_code_unique|duplicate/)
    db.close()
  })

  // The feasibility probes run against the LIVE table, whose columns still carry their PRE-migration
  // names (renames + the rebuild's INSERT…SELECT only run later, inside the transaction). A required
  // (NOT NULL) carried column that arrives via a rename or a single↔multiple transform must therefore be
  // probed under its live SOURCE name — NOT the desired name, which doesn't exist yet and would make the
  // probe abort the whole migration with `no such column`.
  const rcOld = defineCollection({ name: 'rc', mode: 'multi', translatable: false, fields: { content: { type: 'text', required: true }, legacy: { type: 'text' } } })
  const rcNew = defineCollection({ name: 'rc', mode: 'multi', translatable: false, fields: { body: { type: 'text', required: true, renamedFrom: 'content' } } })

  it('a REQUIRED renamed column coinciding with a rebuild is feasible (no spurious "no such column")', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([buildTable(rcOld)]))
    db.prepare("INSERT INTO rc (content, legacy, created_at, updated_at) VALUES ('keep', 'drop', 0, 0)").run()
    const { applied } = syncSchema(asSyncDb(db), desiredSchema([buildTable(rcNew)], new Map([['rc', rcNew]])), { allowDestructive: true })
    expect(applied[0]).toBe('ALTER TABLE `rc` RENAME COLUMN `content` TO `body`;')
    expect(db.prepare('SELECT body FROM rc').get()).toEqual({ body: 'keep' })
    expect(colNames(db, 'rc')).not.toContain('legacy')
    db.close()
  })

  // A previously-NULLABLE column that is renamed AND made NOT NULL, coinciding with a rebuild, whose OLD
  // rows still hold NULL — this must fail the up-front feasibility check (probed under the live SOURCE name),
  // not abort mid-transaction with an opaque "NOT NULL constraint failed".
  const nnOld = defineCollection({ name: 'nn', mode: 'multi', translatable: false, fields: { note: { type: 'text' }, legacy: { type: 'text' } } })
  const nnNew = defineCollection({ name: 'nn', mode: 'multi', translatable: false, fields: { body: { type: 'text', required: true, renamedFrom: 'note' } } })

  it('a renamed column made NOT NULL whose OLD rows hold NULL is rejected up-front (clear message, DB intact)', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([buildTable(nnOld)]))
    db.prepare('INSERT INTO nn (note, legacy, created_at, updated_at) VALUES (NULL, \'x\', 0, 0)').run() // note is NULL
    expect(() => syncSchema(asSyncDb(db), desiredSchema([buildTable(nnNew)], new Map([['nn', nnNew]])), { allowDestructive: true }))
      .toThrowError(/infeasible[\s\S]*became NOT NULL but existing rows hold NULL/)
    // nothing changed — the old columns are still there, the migration aborted before any DDL
    expect(colNames(db, 'nn')).toContain('note')
    expect(colNames(db, 'nn')).toContain('legacy')
    db.close()
  })

  // Two tables each rename a DIFFERENT old column to the SAME new name, both with rebuilds. The rename map
  // must be per-table: a global new→old map would probe the wrong table's source column.
  it('a cross-table rename collision on the same new name probes each table\'s OWN source (no false verdict)', () => {
    // taA: heading(nullable, has a NULL) → title NOT NULL  ⇒ INFEASIBLE (its own source is NULL)
    const taOld = defineCollection({ name: 'taa', mode: 'multi', translatable: false, fields: { heading: { type: 'text' }, gone: { type: 'text' } } })
    const taNew = defineCollection({ name: 'taa', mode: 'multi', translatable: false, fields: { title: { type: 'text', required: true, renamedFrom: 'heading' } } })
    // tbB: subject(nullable, NO nulls) → title NOT NULL   ⇒ FEASIBLE (its own source has data)
    const tbOld = defineCollection({ name: 'tbb', mode: 'multi', translatable: false, fields: { subject: { type: 'text' }, gone: { type: 'text' } } })
    const tbNew = defineCollection({ name: 'tbb', mode: 'multi', translatable: false, fields: { title: { type: 'text', required: true, renamedFrom: 'subject' } } })

    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([buildTable(taOld), buildTable(tbOld)]))
    db.prepare("INSERT INTO taa (heading, gone, created_at, updated_at) VALUES (NULL, 'x', 0, 0)").run() // taa.heading NULL
    db.prepare("INSERT INTO tbb (subject, gone, created_at, updated_at) VALUES ('ok', 'x', 0, 0)").run() // tbb.subject has data

    // taa alone is infeasible (its own heading is NULL) — must be rejected, probed against taa (not tbb).
    expect(() => syncSchema(asSyncDb(db), desiredSchema([buildTable(taNew), buildTable(tbOld)], new Map([['taa', taNew]])), { allowDestructive: true }))
      .toThrowError(/infeasible[\s\S]*taa\.title/)
    // tbb alone is feasible (its own subject has data) — must NOT be falsely rejected by taa's source.
    const { applied } = syncSchema(asSyncDb(db), desiredSchema([buildTable(taOld), buildTable(tbNew)], new Map([['tbb', tbNew]])), { allowDestructive: true })
    expect(applied.some((s) => s.includes('RENAME COLUMN `subject` TO `title`'))).toBe(true)
    expect(db.prepare('SELECT title FROM tbb').get()).toEqual({ title: 'ok' })
    db.close()
  })

  const reqSingle = defineCollection({ name: 'rg', mode: 'multi', translatable: false, fields: { cover: { type: 'media', required: true } } })
  const reqMulti = defineCollection({ name: 'rg', mode: 'multi', translatable: false, fields: { cover: { type: 'media', required: true, options: { multiple: true } } } })

  it('a REQUIRED single→multiple transform is feasible — wrap never yields NULL (no "no such column")', () => {
    const db = new Database(':memory:')
    syncSchema(asSyncDb(db), desiredSchema([buildTable(reqSingle)], new Map([['rg', reqSingle]])))
    db.prepare('INSERT INTO rg (cover_id, created_at, updated_at) VALUES (42, 0, 0)').run()
    const { applied } = syncSchema(asSyncDb(db), desiredSchema([buildTable(reqMulti)], new Map([['rg', reqMulti]])), { allowDestructive: true })
    expect(applied.some((s) => s.includes('json_array'))).toBe(true)
    expect(db.prepare('SELECT cover FROM rg').get()).toEqual({ cover: '[42]' })
    db.close()
  })

  it('a REQUIRED multiple→single transform probes the live source: feasible with data, rejected when it would unwrap to NULL', () => {
    const ok = new Database(':memory:')
    syncSchema(asSyncDb(ok), desiredSchema([buildTable(reqMulti)], new Map([['rg', reqMulti]])))
    ok.prepare("INSERT INTO rg (cover, created_at, updated_at) VALUES ('[7,8]', 0, 0)").run()
    expect(() => syncSchema(asSyncDb(ok), desiredSchema([buildTable(reqSingle)], new Map([['rg', reqSingle]])), { allowDestructive: true })).not.toThrow()
    expect(ok.prepare('SELECT cover_id FROM rg').get()).toEqual({ cover_id: 7 })
    ok.close()

    const bad = new Database(':memory:')
    syncSchema(asSyncDb(bad), desiredSchema([buildTable(reqMulti)], new Map([['rg', reqMulti]])))
    bad.prepare("INSERT INTO rg (cover, created_at, updated_at) VALUES ('[]', 0, 0)").run() // unwraps to NULL
    expect(() => syncSchema(asSyncDb(bad), desiredSchema([buildTable(reqSingle)], new Map([['rg', reqSingle]])), { allowDestructive: true })).toThrow(/rg\.cover_id|NULL/)
    bad.close()
  })
})
