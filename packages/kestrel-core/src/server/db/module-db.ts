import { Context, Data, Layer } from 'effect'
import type Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { OwnershipManifest } from '@kestrel/contracts'

/**
 * Thrown in dev/test mode when a `<Module>Db` adapter issues a statement that references a table
 * outside its `OwnershipManifest` (ADR-0012). Module-local and plain (`Data.TaggedError`, not
 * `Schema.TaggedError`): it is a programmer guard, decided off in prod, that never crosses the
 * Promise/HTTP consumer boundary, so it carries no encode/decode contract.
 *
 * @public
 */
export class OwnershipViolation extends Data.TaggedError('OwnershipViolation')<{
  readonly module: string
  readonly table: string
}> {}

/**
 * A raw-SQL statement handle scoped to the same surface `better-sqlite3.Statement` exposes for running
 * and reading a prepared statement — everything except the `.database` back-reference, which would leak
 * the raw handle the adapter is built to keep private.
 *
 * @public
 */
export interface ModuleStatement {
  readonly run: (...params: Parameters<Database.Statement['run']>) => ReturnType<Database.Statement['run']>
  readonly get: (...params: Parameters<Database.Statement['get']>) => ReturnType<Database.Statement['get']>
  readonly all: (...params: Parameters<Database.Statement['all']>) => ReturnType<Database.Statement['all']>
  readonly iterate: (...params: Parameters<Database.Statement['iterate']>) => ReturnType<Database.Statement['iterate']>
  readonly columns: () => ReturnType<Database.Statement['columns']>
  readonly bind: (...params: Parameters<Database.Statement['bind']>) => ModuleStatement
  readonly pluck: (toggleState?: boolean) => ModuleStatement
  readonly expand: (toggleState?: boolean) => ModuleStatement
  readonly raw: (toggleState?: boolean) => ModuleStatement
  readonly safeIntegers: (toggleState?: boolean) => ModuleStatement
}

/**
 * The transaction-scoped handle a `db.transaction(fn)` callback receives: an OBJECT LITERAL exposing only
 * `select`/`insert`/`update`/`delete` (each still ownership-checked) plus a `transaction` for a nested
 * SAVEPOINT (recursively the same checked handle). Deliberately not a wrapped/proxied Drizzle transaction
 * object — that leaves every method the literal doesn't name (`run`/`all`/`get`/`values`, `with`/`$count`,
 * and `session` — the real escape hatch to the raw `better-sqlite3.Database`) simply absent, not merely
 * unchecked. No current call site needs a raw-SQL prepare inside a transaction FOR ITS OWN MODULE's tables,
 * so none is exposed here; add one (checked, mirroring `db.prepare`) if a real call site needs it.
 *
 * One deliberate, narrow exception exists: {@link rawSqliteClientOf} (ADR-0023's ownership exemption,
 * mirroring `findMediaUsagesForMany`'s in `usages.ts`) — the media library's synthetic-write outbox seam
 * (`media-write.ts`'s `emitMediaOutbox`) needs the raw connection to write into `outbox_content`, a
 * CONTENT-owned table no media manifest could ever legitimately "own" a checked `prepare` for. A checked
 * raw-prepare here would only duplicate `outbox.ts`'s own enforcement-free primitives for no gain — see
 * `emitMediaOutbox`'s TSDoc.
 *
 * @public
 */
export interface ModuleTxHandle {
  readonly [ModuleDbBrand]: true
  readonly select: BetterSQLite3Database['select']
  readonly insert: BetterSQLite3Database['insert']
  readonly update: BetterSQLite3Database['update']
  readonly delete: BetterSQLite3Database['delete']
  readonly transaction: <T>(fn: (tx: ModuleTxHandle) => T) => T
}

/** The `config` shape better-sqlite3's driver accepts on `.transaction(fn, config)` (e.g.
 * @public
 *  `{ behavior: 'immediate' }`) — lifted from `BetterSQLite3Database` rather than redeclared. */
export type ModuleTxConfig = Parameters<BetterSQLite3Database['transaction']>[1]

/**
 * A pure type-level tag (never assigned or read at runtime — `declare const` only introduces a name for
 * the type checker) marking `ModuleDbService['db']`/`ModuleTxHandle` as genuinely built by
 * {@link makeModuleDb}/`buildTxHandle`, not a raw `BetterSQLite3Database`/drizzle instance a caller
 * assembled by hand. Exported (not kept private to this module) specifically so `record-ref-index.ts`'s
 * `Pick`-narrowed `DB`/`WriteDB`/`RebuildDB` can re-intersect it: `Pick<T, K>` drops every key outside
 * `K`, so a narrowed type has to name this key explicitly to keep rejecting a raw handle — the one
 * legitimate reason a sibling file in this package needs to reference it. `makeModuleDb`'s and
 * `buildTxHandle`'s own construction sites cast their plain object literals `as unknown as` the branded
 * interface — that cast is what vouches for the brand; nothing else can.
 * @public
 */
export declare const ModuleDbBrand: unique symbol

/**
 * The surface a `<Module>Db` service exposes: the manifest's own Drizzle table objects, plus a `db`
 * handle restricted to those tables. `db` mirrors the subset of `BetterSQLite3Database` this codebase's
 * DB call sites use (`select`/`selectDistinct`/`insert`/`update`/`delete`/`transaction`) plus a raw-SQL
 * `prepare`; the underlying `better-sqlite3.Database` instance itself is not reachable from `db`/
 * `ModuleTxHandle` in either dev or prod, in either mode — with ONE named exception:
 * {@link rawSqliteClientOf}, an identity-keyed lookup a caller can use to recover the raw connection a
 * SPECIFIC `db` object was built from (never a coincidental/most-recently-built guess). Two named
 * consumers today: ADR-0023's `emitMediaOutbox` (a cross-module write no manifest could legitimately
 * cover), and `snapshots.ts`'s `nextRowId` (an own-table `sqlite_sequence` read that predicts an
 * AUTOINCREMENT id ahead of an insert — outside anything a checked `prepare` gates) — see the reason
 * documented on each, and on `rawSqliteClientOf` itself.
 *
 * @public
 */
export interface ModuleDbService {
  readonly db: {
    readonly [ModuleDbBrand]: true
    readonly select: BetterSQLite3Database['select']
    readonly selectDistinct: BetterSQLite3Database['selectDistinct']
    readonly insert: BetterSQLite3Database['insert']
    readonly update: BetterSQLite3Database['update']
    readonly delete: BetterSQLite3Database['delete']
    readonly prepare: (sql: string) => ModuleStatement
    readonly transaction: <T>(fn: (tx: ModuleTxHandle) => T, config?: ModuleTxConfig) => T
  }
  readonly tables: Record<string, AnySQLiteTable>
}

// Table-reference extraction: no SQL-parser dependency is allowlisted (docs/internals/releasing.md
// § Dependency allowlist), so this is a hand-rolled scan over the compiled/raw SQL text rather than a real parser.
// Nesting (subqueries, CTE bodies) is not tracked, so a foreign table referenced anywhere in the
// statement is caught regardless of depth — that half is intentionally over-eager. What follows is not
// a parser, though, so it only recognizes the specific keyword shapes below; a table name reached any
// other way is a genuine false negative. Recognized: FROM/JOIN (including a comma-joined FROM list),
// INSERT INTO, UPDATE, DELETE FROM, DROP TABLE, ALTER TABLE, CREATE INDEX ... ON, and
// `PRAGMA <name>(<table>)` (e.g. `table_info`). A schema-qualified name (`main.posts`) is resolved to
// its final segment. Known false negatives, not covered by any of the above:
//  - a table name built through string concatenation, a bind parameter, or `sql.raw`;
//  - `CREATE TRIGGER ... ON <table>` and other DDL/PRAGMA shapes not listed above;
//  - a table name reachable only through `.catch()`/`.finally()` on a query builder without ever calling
//    `.then()` — those delegate to the builder's own internal execution path, bypassing the wrapper (see
//    `wrapQueryBuilder`'s `then` note below).
// CTE names declared via `WITH name AS (...)` are excluded from FROM/JOIN references (they are local
// aliases, not tables) but never from a DML/DDL/PRAGMA target — SQLite resolves a DML target straight to
// the real table even when a CTE of the same name is in scope, so excluding it there would open a write
// bypass.
// The UPDATE alternative excludes a literal `SET` right after the keyword: an upsert's compiled SQL
// (`.onConflictDoUpdate()`) reads `... DO UPDATE SET col = ?, ...`, which is not a table-qualified UPDATE
// statement at all — without the exclusion, `SET` itself was captured as a bogus "table" reference.
const QUOTE_OPEN = "[\"'`\\[]?"
const QUOTE_CLOSE = "[\"'`\\]]?"
const IDENT = '([A-Za-z_]\\w*)'
/** An optionally schema-qualified, optionally quoted table identifier; only the table itself is captured. */
const QUALIFIED_IDENT = `(?:${QUOTE_OPEN}[A-Za-z_]\\w*${QUOTE_CLOSE}\\.)?${QUOTE_OPEN}${IDENT}${QUOTE_CLOSE}`

const STRING_LITERAL_RE = /'(?:[^']|'')*'/g
const LINE_COMMENT_RE = /--[^\n]*/g
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g
const CTE_NAME_RE = /(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s+AS\s*\(/gi

/** Write/DDL/PRAGMA targets: never filtered by CTE aliases (see the module-level note above). */
const ALWAYS_CHECK_RE = new RegExp(
  '\\b(?:'
  + `INTO\\s+${QUALIFIED_IDENT}`
  + `|UPDATE\\s+(?!SET\\b)${QUALIFIED_IDENT}`
  + `|DELETE\\s+FROM\\s+${QUALIFIED_IDENT}`
  + `|DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+${QUALIFIED_IDENT}`
  + `|ALTER\\s+TABLE\\s+${QUALIFIED_IDENT}`
  + `|CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUOTE_OPEN}[A-Za-z_]\\w*${QUOTE_CLOSE}\\s+ON\\s+${QUALIFIED_IDENT}`
  + `|PRAGMA\\s+\\w+\\s*\\(\\s*${QUALIFIED_IDENT}\\s*\\)`
  + ')',
  'gi',
)

/** Reads: FROM/JOIN. A CTE alias is excluded here — it is never a real table. */
const READ_REF_RE = new RegExp(`\\b(?:FROM\\s+${QUALIFIED_IDENT}|JOIN\\s+${QUALIFIED_IDENT})`, 'gi')

function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(STRING_LITERAL_RE, "''")
    .replace(BLOCK_COMMENT_RE, ' ')
    .replace(LINE_COMMENT_RE, ' ')
}

function extractCteNames(sql: string): Set<string> {
  const names = new Set<string>()
  if (!/^\s*WITH\b/i.test(sql)) return names
  for (const match of sql.matchAll(CTE_NAME_RE)) names.add(match[1]!)
  return names
}

function extractReferencedTables(rawSql: string): string[] {
  const sql = stripLiteralsAndComments(rawSql)
  const cteNames = extractCteNames(sql)
  const refs: string[] = []

  for (const match of sql.matchAll(ALWAYS_CHECK_RE)) {
    const name = match.slice(1).find((g): g is string => g !== undefined)
    if (name) refs.push(name)
  }

  const commaItemRe = new RegExp(`\\s*,\\s*${QUALIFIED_IDENT}`, 'y')
  for (const match of sql.matchAll(READ_REF_RE)) {
    const name = match[1] ?? match[2]
    if (!name) continue
    if (!cteNames.has(name)) refs.push(name)

    // `FROM a, b, c` — SQLite's implicit-join comma list; a regex `matchAll` on FROM/JOIN alone only
    // sees `a`, so walk the trailing comma-separated tail explicitly.
    if (match[1]) {
      commaItemRe.lastIndex = match.index + match[0].length
      let extra: RegExpExecArray | null
      while ((extra = commaItemRe.exec(sql))) {
        const extraName = extra[1]!
        if (!cteNames.has(extraName)) refs.push(extraName)
        commaItemRe.lastIndex = extra.index + extra[0].length
      }
    }
  }
  return refs
}

function assertOwned(sql: string, manifest: OwnershipManifest, owned: ReadonlySet<string>): void {
  for (const table of extractReferencedTables(sql)) {
    if (!owned.has(table)) throw new OwnershipViolation({ module: manifest.module, table })
  }
}

/** Wraps a `better-sqlite3.Statement` so `.database` (the raw handle) never leaves the adapter; every
 *  chaining method returns the same facade instead of the real statement. */
function wrapStatement(stmt: Database.Statement): ModuleStatement {
  const facade: ModuleStatement = {
    run: (...params) => stmt.run(...params),
    get: (...params) => stmt.get(...params),
    all: (...params) => stmt.all(...params),
    iterate: (...params) => stmt.iterate(...params),
    columns: () => stmt.columns(),
    bind: (...params) => { stmt.bind(...params); return facade },
    pluck: (toggleState) => { stmt.pluck(toggleState); return facade },
    expand: (toggleState) => { stmt.expand(toggleState); return facade },
    raw: (toggleState) => { stmt.raw(toggleState); return facade },
    safeIntegers: (toggleState) => { stmt.safeIntegers(toggleState); return facade },
  }
  return facade
}

/** Compiles a Drizzle query-builder-shaped object to its SQL text. Most builders expose `.toSQL()`; a
 *  builder produced by the chain's own `.prepare()` (e.g. `select().from(t).prepare()`) instead exposes
 *  `{ query: { sql } }`. An object shaped like neither fails closed (throws) rather than silently
 *  skipping the ownership check. */
function compileSql(target: unknown): string {
  const t = target as { toSQL?: () => { sql: string }; query?: { sql?: string } }
  if (typeof t.toSQL === 'function') return t.toSQL().sql
  if (typeof t.query?.sql === 'string') return t.query.sql
  throw new TypeError('module-db: cannot introspect SQL for ownership check on this query builder shape')
}

// Terminal calls trigger execution. `values()` is ambiguous: on a select/prepared-query builder a
// zero-arg call is terminal (raw array rows); on an insert builder `.values(rows)` supplies the row data
// and is a chain method. `then` is also treated as terminal: a Drizzle query builder is itself thenable,
// so `await svc.db.select()...` executes through `.then()` without ever calling `.all()/.run()` — leaving
// it unwrapped would let an awaited query bypass the check entirely. `.catch()`/`.finally()` are not
// covered: on this thenable they may resolve through the builder's own internal call to `this.then(...)`
// rather than through the proxy, which stays a documented gap (see the module-level note above).
const TERMINAL_METHODS = new Set(['all', 'run', 'get', 'execute', 'iterate', 'then'])

function isTerminalCall(name: string, args: readonly unknown[]): boolean {
  if (name === 'values') return args.length === 0
  return TERMINAL_METHODS.has(name)
}

/** Wraps a Drizzle query builder so its terminal execution methods are checked against the manifest via
 *  their compiled SQL right before they run; chain methods are re-wrapped so the check reaches the final
 *  call regardless of how long the chain is. */
function wrapQueryBuilder<T extends object>(
  builder: T,
  manifest: OwnershipManifest,
  owned: ReadonlySet<string>,
): T {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      const name = prop as string
      return (...args: unknown[]) => {
        if (isTerminalCall(name, args)) {
          assertOwned(compileSql(target), manifest, owned)
          return value.apply(target, args)
        }
        const result = value.apply(target, args)
        return result && typeof result === 'object' ? wrapQueryBuilder(result, manifest, owned) : result
      }
    },
  })
}

/** Builds the checked {@link ModuleTxHandle} object literal for a real Drizzle transaction handle (the
 *  `tx` a `.transaction(fn)` callback receives) — see the type's own TSDoc for why this is a literal, not
 *  a wrap/proxy of `tx` itself. `transaction` recurses into the same literal for a nested SAVEPOINT. */
function buildTxHandle(
  tx: BetterSQLite3Database,
  manifest: OwnershipManifest,
  owned: ReadonlySet<string>,
): ModuleTxHandle {
  return {
    select: (...args: Parameters<BetterSQLite3Database['select']>) => wrapQueryBuilder(tx.select(...args), manifest, owned),
    insert: (...args: Parameters<BetterSQLite3Database['insert']>) => wrapQueryBuilder(tx.insert(...args), manifest, owned),
    update: (...args: Parameters<BetterSQLite3Database['update']>) => wrapQueryBuilder(tx.update(...args), manifest, owned),
    delete: (...args: Parameters<BetterSQLite3Database['delete']>) => wrapQueryBuilder(tx.delete(...args), manifest, owned),
    transaction: (<T>(fn: (nested: ModuleTxHandle) => T) =>
      tx.transaction((nested) => fn(buildTxHandle(nested as unknown as BetterSQLite3Database, manifest, owned)))),
  } as unknown as ModuleTxHandle
}

// Maps a built `ModuleDbService['db']` object back to the raw connection it was built from — keyed by
// object identity (a WeakMap, so it never leaks/retains after the built db itself is collected), populated
// once per `buildDb` call below. This is the ONLY way to recover the raw `better-sqlite3.Database` from a
// checked adapter — see `rawSqliteClientOf`'s own TSDoc and the `ModuleTxHandle` TSDoc above for why this
// exists and how narrowly it is meant to be used.
const rawClients = new WeakMap<object, Database.Database>()

/**
 * Recovers the raw `better-sqlite3.Database` a `ModuleDbService['db']` (e.g. a `MediaDb`) was built from —
 * `undefined` for anything not built by {@link makeModuleDb} (a plain object, a mock). ADR-0012's deliberate
 * exemption for `media-write.ts`'s `emitMediaOutbox`: content's `outbox_content` table is not, and can never
 * legitimately be, part of any other module's ownership manifest, so the checked `db`/`prepare` surface has
 * no way to reach it at all. A second consumer, `snapshots.ts`'s `nextRowId`, uses it for a different
 * reason: reading `sqlite_sequence` to predict an AUTOINCREMENT id ahead of an insert, entirely within its
 * OWN table — nothing a checked `prepare` needs to gate, just a system table no manifest names. This is
 * identity-based, not "whatever was built most recently" — the exact db object the caller already holds
 * resolves to the exact connection it was built from, structurally, with no assumption about call order or
 * a shared cache being fresh.
 * @public
 */
export function rawSqliteClientOf(db: object): Database.Database | undefined {
  return rawClients.get(db)
}

function buildDb(
  manifest: OwnershipManifest,
  sqlite: Database.Database,
  owned: ReadonlySet<string>,
  devMode: boolean,
): ModuleDbService['db'] {
  const raw = drizzle(sqlite)
  const db = !devMode
    ? {
        select: raw.select.bind(raw),
        selectDistinct: raw.selectDistinct.bind(raw),
        insert: raw.insert.bind(raw),
        update: raw.update.bind(raw),
        delete: raw.delete.bind(raw),
        prepare: (sql: string) => wrapStatement(sqlite.prepare(sql)),
        // Prod: no checking at all, so the callback gets the real (unwrapped) tx — see the TSDoc on
        // `makeModuleDb` for why this is safe (the shape only matters in dev/test).
        transaction: raw.transaction.bind(raw),
        // The brand (see `Branded` above) is a pure type-level tag with no runtime representation — this
        // object literal genuinely satisfies `ModuleDbService['db']` at runtime (every real member is
        // present); `unknown` only bridges the assertion because the object's structural type lacks the
        // phantom property TS can't see reflected in a plain literal.
      } as unknown as ModuleDbService['db']
    : {
        select: (...args: Parameters<BetterSQLite3Database['select']>) => wrapQueryBuilder(raw.select(...args), manifest, owned),
        selectDistinct: (...args: Parameters<BetterSQLite3Database['selectDistinct']>) => wrapQueryBuilder(raw.selectDistinct(...args), manifest, owned),
        insert: (...args: Parameters<BetterSQLite3Database['insert']>) => wrapQueryBuilder(raw.insert(...args), manifest, owned),
        update: (...args: Parameters<BetterSQLite3Database['update']>) => wrapQueryBuilder(raw.update(...args), manifest, owned),
        delete: (...args: Parameters<BetterSQLite3Database['delete']>) => wrapQueryBuilder(raw.delete(...args), manifest, owned),
        prepare: (sql: string) => {
          assertOwned(sql, manifest, owned)
          return wrapStatement(sqlite.prepare(sql))
        },
        transaction: (<T>(fn: (tx: ModuleTxHandle) => T, config?: ModuleTxConfig) =>
          raw.transaction((tx) => fn(buildTxHandle(tx as unknown as BetterSQLite3Database, manifest, owned)), config)) as unknown as ModuleDbService['db']['transaction'],
      } as unknown as ModuleDbService['db']
  rawClients.set(db, sqlite)
  return db
}

/**
 * Builds a `<Module>Db` adapter (ADR-0012): a `Context.Tag`/`Layer` pair whose service exposes only the
 * tables declared in `manifest` (drawn from `tables`, keyed by name) plus a `db` handle scoped to them.
 * The raw `better-sqlite3.Database` handle passed in stays private to this closure, in both modes.
 *
 * Dev/test vs. prod is a runtime read of `process.env.NODE_ENV` taken once, at this call, and captured in
 * the returned service — not re-read per statement. Off `'production'`, every statement issued through
 * `db` is checked against `manifest` by scanning its compiled SQL for table references; a foreign table
 * throws {@link OwnershipViolation}. Under `'production'` the scan is skipped entirely — `db`'s methods
 * delegate straight to the underlying Drizzle instance, so the introspection never costs a production
 * read/write; only the (cheap) statement-facade wrapping for handle privacy still runs.
 *
 * @public
 */
export function makeModuleDb(
  manifest: OwnershipManifest,
  sqlite: Database.Database,
  tables: Record<string, AnySQLiteTable>,
): { layer: Layer.Layer<ModuleDbService>; tag: Context.Tag<ModuleDbService, ModuleDbService> } {
  const owned = new Set(manifest.tables)
  const devMode = process.env.NODE_ENV !== 'production'
  const tag = Context.GenericTag<ModuleDbService>(`@kestrel/ModuleDb/${manifest.module}`)
  const service: ModuleDbService = {
    db: buildDb(manifest, sqlite, owned, devMode),
    tables,
  }
  return { layer: Layer.succeed(tag, service), tag }
}
