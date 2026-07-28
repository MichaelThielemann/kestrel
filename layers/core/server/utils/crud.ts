import { and, asc, count, desc, eq, getTableColumns, inArray, ne } from 'drizzle-orm'
import { createError } from 'h3'
import { nanoid } from 'nanoid'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { BuiltCollection } from './collection-types'
import { primaryLocale, prefixPrimaryLocale, resolveLocale, supportedLocales } from './locale'
import { populateRow } from './populate'
import { captureRead } from './read-capture'
import { emitWrite } from './write-events'
import { allCollections } from './registry'
import { resolvePageSlug } from './page-slug'
import { recordRefs } from '../database/record-refs'
import { collectionMayReference, deadTargets } from './record-ref-index'
// Intentional core→fields dependency: the `fields` layer is the field-type SPI the engine is built on (column
// + validator + transform + naming). It is effectively part of the engine, not a swappable layer, so the CRUD
// engine consumes it by direct import rather than through a registration seam.
import { getFieldType } from '../../../fields/server/field-registry/index'
import { resolveColumnName } from '../../../fields/server/field-registry/naming'
import { getBlock } from '../../../fields/server/utils/defineBlock'
import { fieldIs, type FieldDef } from './defineCollection'
import { serializeField } from './serialize-collection'
import { fieldFilterKind, FILTER_RE, isFilterOp, opAllowed, type FilterKind, type FilterOp } from '../../app/utils/filter-ops'
import { clampPerPage } from '../../app/utils/list-limits'
import { filterCondition } from './filter-predicate'
import { withResolveScope, resolveBudgetFor } from './resolve-scope'

type DB = BetterSQLite3Database
type Row = Record<string, unknown>

// Upper bound on relation/media populate recursion. `depth` is attacker-controlled on anonymous reads
// (both list + detail routes accept `?depth`), and the relation populator recurses one getOne per level —
// an unbounded value drives thousands of synchronous DB reads / a stack overflow. No real content nests
// beyond a handful of hops, so clamp hard.
const MAX_DEPTH = 10
const clampDepth = (value: unknown): number => Math.min(MAX_DEPTH, Math.max(0, Number(value) || 0))

export interface ListQuery {
  locale?: string | string[]
  sort?: string | string[]
  page?: number
  perPage?: number
  filter?: FilterClause[]
  depth?: number
  /** Skip the total count() query (default: compute it). Set false on the prerender/resolvePage hot
   *  path, which reads only the first row and discards `total` — saving a count() per page-like probe. */
  withTotal?: boolean
  /** Skip the publish dependency capture (default: capture a collection-level tag). Set false for the
   *  resolvePage self-lookup, which captures the found record instead of the whole collection. */
  capture?: boolean
}

// The table is built at runtime from the collection's fields, so its columns can't be statically typed —
// `Record<string, AnySQLiteColumn>` is the honest shape (keyed by jsKey) every query helper indexes into.
function columns(c: BuiltCollection): Record<string, AnySQLiteColumn> {
  return getTableColumns(c.table) as Record<string, AnySQLiteColumn>
}

function table(c: BuiltCollection): AnySQLiteTable {
  return c.table as AnySQLiteTable
}

/** Whether a thrown DB error is a SQLite UNIQUE-constraint violation. The single home for this brittle
 *  driver-message heuristic, reused by every write path that maps it to a 409 (crud + media upload). */
export function isUniqueViolation(error: unknown): boolean {
  return String((error as Error)?.message).includes('UNIQUE')
}

/** Run a DB write, mapping SQLite's UNIQUE-constraint failure to a 409 (duplicate locale-in-group or path). */
function runCatchingUnique<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw createError({ statusCode: 409, statusMessage: 'Conflict: duplicate locale in translation group, or duplicate path' })
    }
    throw error
  }
}

/** WHERE matching a collection's singleton row: keyed by name, plus locale for translatable singletons. */
function singletonWhere(cols: Record<string, AnySQLiteColumn>, c: BuiltCollection, loc: string | undefined) {
  const key = eq(cols.singletonKey, c.name)
  return c.def.translatable ? and(key, eq(cols.locale, loc)) : key
}

/** One parsed filter clause. The wire stays a FilterClause[] (not a `Record<field,value>`) so a repeated
 *  key AND-s (two `contains` on one array field) and a range clause-builder can layer on later without a
 *  re-migration. */
export interface FilterClause {
  field: string
  op: FilterOp
  value: string
}

/** Parse the `filter[...]` query keys into clauses. A bare key means `eq`. ufo turns a repeated key into an
 *  array, so one clause is emitted per value (repeated same-op AND). An unknown operator TOKEN is a clean
 *  400 here; an operator that is merely disallowed FOR THE FIELD's kind is caught in list(). */
export function parseFilter(query: Record<string, unknown>): FilterClause[] {
  const out: FilterClause[] = []
  for (const [key, value] of Object.entries(query)) {
    const m = FILTER_RE.exec(key)
    if (!m) continue
    const op = m[2] ?? 'eq'
    if (!isFilterOp(op)) throw createError({ statusCode: 400, statusMessage: `Unknown filter operator: ${op}` })
    for (const v of Array.isArray(value) ? value : [value]) out.push({ field: m[1]!, op, value: String(v) })
  }
  return out
}

/** The allow-list of a collection's filterable columns → their FilterKind (drives op validation + predicate
 *  building). Built per-request from the schema; a column absent here can't be filtered (a clean 400). */
function filterKindMap(c: BuiltCollection): Record<string, FilterKind> {
  const map: Record<string, FilterKind> = { id: 'number' }
  for (const [key, f] of Object.entries(c.def.fields)) {
    const kind = fieldFilterKind(serializeField(f))
    if (kind) map[resolveColumnName(key, f).jsKey] = kind
  }
  if (c.def.pageLike) map.path = 'text'
  if (c.def.status) map.status = 'enum'
  map.createdAt = 'datetime'
  map.updatedAt = 'datetime'
  return map
}

export function list(db: DB, c: BuiltCollection, q: ListQuery, publishedOnly = false) {
  const cols = columns(c)
  // A listing depends on the whole collection (any add/remove/edit changes it) — tag it collection-level.
  if (q.capture !== false) captureRead(c.def.name)
  const conds = []

  const localeRaw = Array.isArray(q.locale) ? q.locale[0] : q.locale
  const sortRaw = Array.isArray(q.sort) ? q.sort[0] : q.sort

  // One normalized locale drives BOTH the WHERE filter and the populate locale. `all` means
  // "no locale filter"; there is no single populate locale then, so fall back to primary.
  let populateLocale = primaryLocale()
  if (c.def.translatable && localeRaw !== 'all') {
    const loc = resolveLocale(localeRaw)
    conds.push(eq(cols.locale, loc))
    populateLocale = loc
  }

  const kinds = filterKindMap(c)
  for (const cl of q.filter ?? []) {
    // Object.hasOwn on both maps is prototype-safe: a `toString`/`__proto__` field never resolves to an
    // inherited member — it is an unknown (unfilterable) field → a clean 400.
    if (!Object.hasOwn(kinds, cl.field) || !Object.hasOwn(cols, cl.field)) {
      throw createError({ statusCode: 400, statusMessage: `Unknown filter field: ${cl.field}` })
    }
    const kind = kinds[cl.field]!
    if (!opAllowed(kind, cl.op)) {
      throw createError({ statusCode: 400, statusMessage: `Operator "${cl.op}" is not allowed for field "${cl.field}"` })
    }
    conds.push(filterCondition(cols[cl.field]!, kind, cl.op, cl.value))
  }
  if (publishedOnly && Object.hasOwn(cols, 'status')) conds.push(eq(cols.status, 'published'))

  const where = conds.length ? and(...conds) : undefined

  let orderColumn = cols.createdAt
  let direction: typeof asc = desc
  if (sortRaw) {
    const descending = sortRaw.startsWith('-')
    const name = descending ? sortRaw.slice(1) : sortRaw
    if (!Object.hasOwn(cols, name)) throw createError({ statusCode: 400, statusMessage: `Unknown sort field: ${name}` })
    orderColumn = cols[name]
    direction = descending ? desc : asc
  }

  // `?? default` only catches null/undefined, NOT NaN (e.g. `?page=abc` → Number('abc') === NaN), which
  // would then bind `.offset(NaN)` = OFFSET NULL — a garbage query. Guard `page` with Number.isFinite;
  // `perPage` is clamped by the shared `clampPerPage` (which also blocks the `.limit(NaN)` cap-bypass).
  const num = (v: number | undefined, fallback: number) => (Number.isFinite(v) ? (v as number) : fallback)
  const page = Math.max(1, Math.floor(num(q.page, 1)))
  const perPage = clampPerPage(q.perPage) // the shared page-size cap (also caps a bulk selection)

  const depth = clampDepth(q.depth)

  const rawData = db.select().from(table(c)).where(where)
    .orderBy(direction(orderColumn)).limit(perPage).offset((page - 1) * perPage).all()
  const totalRow = q.withTotal === false
    ? undefined
    : db.select({ value: count() }).from(table(c)).where(where).get() as { value: number } | undefined

  // One resolve scope per request: repeated refs across the page's rows resolve once, and the DISTINCT
  // fan-out is budgeted — an anonymous `?depth=10&perPage=500` read can no longer multiply into an
  // unbounded number of synchronous DB reads (each blocks the single event-loop thread).
  const data = withResolveScope(
    () => rawData.map((r) => populateRow(r as Record<string, unknown>, { depth, locale: populateLocale, def: c.def })),
    resolveBudgetFor(perPage), // scale the ceiling with the page size so a full legitimate page always populates
    `list ${c.def.name}`,
  ) as Row[]
  attachTranslationStatus(db, c, data, publishedOnly)
  // Dead-reference warnings are an admin-editor signal; skip the extra query on published-scope
  // (public / prerender) reads, where it is irrelevant and would tax the hot path.
  if (!publishedOnly) attachDeadRefs(db, c, data)
  return { data, total: Number(totalRow?.value ?? 0), page, perPage }
}

/**
 * Attach `$hasDeadRefs` (a boolean sidecar, like `$translations`) to a page of admin list rows in ONE
 * batched query over `record_refs` (no N+1): true when any reference the row holds points at a deleted or
 * unpublished target. A no-op for collections that can never hold a reference. The warning is DERIVED on
 * read, so it clears the instant the link is removed/repointed or the target is restored/republished.
 */
function attachDeadRefs(db: DB, c: BuiltCollection, rows: Row[]): void {
  if (rows.length === 0 || !collectionMayReference(c.def)) return
  const ids = rows.map((r) => r.id).filter((x): x is number => typeof x === 'number')
  if (!ids.length) return
  let edges: { sourceId: number; targetColl: string; targetId: number }[]
  try {
    edges = db.select({ sourceId: recordRefs.sourceId, targetColl: recordRefs.targetColl, targetId: recordRefs.targetId })
      .from(recordRefs).where(and(eq(recordRefs.sourceColl, c.def.name), inArray(recordRefs.sourceId, ids))).all()
  } catch {
    return // record_refs not migrated yet (e.g. a bare DB) — derive no warnings rather than break the list.
  }
  for (const r of rows) r.$hasDeadRefs = false
  if (!edges.length) return
  const dead = deadTargets(db, edges.map((e) => ({ collection: e.targetColl, id: e.targetId })))
  if (!dead.size) return
  const deadSources = new Set<number>()
  for (const e of edges) if (dead.has(`${e.targetColl}:${e.targetId}`)) deadSources.add(e.sourceId)
  for (const row of rows) if (deadSources.has(row.id as number)) row.$hasDeadRefs = true
}

/**
 * Attach the per-row translation status (`$translations`: locale → sibling row id, or null when the
 * locale is missing) for a page of list rows in a SINGLE batched query — the no-N+1 alternative to
 * calling resolveTranslations() once per row. Same shape as resolveTranslations(); the `$`-prefix
 * marks it a server-computed sidecar (mirrors the media `$media` convention), so it never collides
 * with a user-defined field. Only multi-mode translatable collections own a translationGroup, so it
 * is a no-op (and issues no query) for every other collection and for an empty page. The sibling
 * lookup honours `publishedOnly` (same as the page query) so a published-scope read never reveals
 * draft translations.
 */
function attachTranslationStatus(db: DB, c: BuiltCollection, rows: Row[], publishedOnly: boolean): void {
  if (c.def.mode !== 'multi' || !c.def.translatable || rows.length === 0) return
  const cols = columns(c)
  const groups = [...new Set(rows.map((r) => r.translationGroup as string).filter((g) => g != null))]
  if (groups.length === 0) return

  const conds = [inArray(cols.translationGroup, groups)]
  if (publishedOnly && Object.hasOwn(cols, 'status')) conds.push(eq(cols.status, 'published'))
  const siblings = db.select({ translationGroup: cols.translationGroup, locale: cols.locale, id: cols.id })
    .from(table(c)).where(and(...conds)).all() as Array<{ translationGroup: string; locale: string; id: number }>

  const byGroup = new Map<string, Record<string, number | null>>()
  for (const g of groups) {
    const map: Record<string, number | null> = {}
    for (const loc of supportedLocales()) map[loc] = null
    byGroup.set(g, map)
  }
  for (const s of siblings) byGroup.get(s.translationGroup)![s.locale] = s.id
  for (const r of rows) {
    const g = r.translationGroup as string | undefined
    if (g != null) r.$translations = byGroup.get(g) ?? null
  }
}

export function getOne(db: DB, c: BuiltCollection, id: number, depth = 0, locale?: string, publishedOnly = false): Row {
  captureRead(c.def.name, id) // a detail read depends on exactly this record
  const cols = columns(c)
  const row = db.select().from(table(c)).where(eq(cols.id, id)).get() as Row | undefined
  if (!row) throw createError({ statusCode: 404, statusMessage: `${c.name} ${id} not found` })
  if (publishedOnly && Object.hasOwn(cols, 'status') && row.status !== 'published') {
    throw createError({ statusCode: 404, statusMessage: `${c.name} ${id} not found` })
  }
  const safeDepth = clampDepth(depth)
  const loc = c.def.translatable ? resolveLocale(locale) : primaryLocale()
  // Nested reads (the relation populator's recursive getOne) reuse the enclosing request's scope.
  return withResolveScope(
    () => populateRow(row as Record<string, unknown>, { depth: safeDepth, locale: loc, def: c.def }),
    resolveBudgetFor(1),
    `get ${c.def.name}:${id}`,
  ) as Row
}

/** Re-enforce `required` for conditional fields whose condition is met (the per-field schema relaxes
 *  them since it can't see siblings). Runs on the EFFECTIVE record — for a partial update/PUT that is
 *  the existing row overlaid with the parsed change, so a patch that merely makes the condition met is
 *  validated too. Same 400 shape as a Zod failure, keyed by the field's def name. */
function assertConditions(c: BuiltCollection, record: Row): void {
  const issues = c.applyConditions?.(record).issues
  if (issues?.length) {
    throw createError({ statusCode: 400, statusMessage: 'Validation failed', data: issues })
  }
}

/** Apply field-type write-transforms (e.g. slug auto-generation) before insert/update. `record` is the
 *  cross-field context a transform reads (`options.from`). On CREATE every transforming field runs (so an
 *  omitted slug is still generated); on UPDATE only fields present in the patch run (an unrelated edit must
 *  not silently rewrite a slug/URL). Mutates `values` in place. */
export function applyFieldTransforms(c: BuiltCollection, values: Row, record: Row, all: boolean): void {
  for (const [key, fieldDef] of Object.entries(c.def.fields)) {
    const { jsKey: col } = resolveColumnName(key, fieldDef) // values are keyed by jsKey
    if (!all && !Object.hasOwn(values, col)) continue
    if (fieldIs(fieldDef, 'repeater')) {
      const arr = values[col]
      if (Array.isArray(arr)) for (const entry of arr) if (entry && typeof entry === 'object') transformNested(fieldDef.options.fields, entry as Row)
      continue
    }
    const transform = getFieldType(fieldDef.type).transform
    if (transform) values[col] = transform(values[col], record, fieldDef)
  }
  // Block content is sent whole, so recurse transforms through each block's props + nested slots.
  if (c.def.blocks?.enabled && (all || Object.hasOwn(values, 'content'))) transformBlocks(values.content)
}

/** Apply transforms inside a NESTED scope (a repeater entry or a block's props): the object IS the full
 *  sibling context (the whole nested value is always sent), so a transform reads AND writes it. Recurses
 *  into nested repeaters. */
function transformNested(fields: Record<string, FieldDef>, scope: Row): void {
  for (const [key, fieldDef] of Object.entries(fields)) {
    if (fieldIs(fieldDef, 'repeater')) {
      const arr = scope[key]
      if (Array.isArray(arr)) for (const entry of arr) if (entry && typeof entry === 'object') transformNested(fieldDef.options.fields, entry as Row)
      continue
    }
    const transform = getFieldType(fieldDef.type).transform
    if (transform) scope[key] = transform(scope[key], scope, fieldDef)
  }
}

/** Recurse transforms through block content: each block's props (keyed by field name) + its slots' blocks. */
function transformBlocks(blocks: unknown): void {
  if (!Array.isArray(blocks)) return
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; props?: unknown; slots?: unknown }
    const def = typeof b.type === 'string' ? getBlock(b.type) : undefined
    if (def && b.props && typeof b.props === 'object') transformNested(def.fields, b.props as Row)
    if (b.slots && typeof b.slots === 'object') for (const sub of Object.values(b.slots as Record<string, unknown>)) transformBlocks(sub)
  }
}

/** Reject (hard, NO silent dedup) a `unique` slug that already exists — so the editor gets a clear
 *  field-scoped "already exists" error and the photographer must choose a different slug (Pruvious-style).
 *  Runs AFTER transforms (sees the generated value), BEFORE insert/update. Throws a 400 keyed to the field
 *  (`path: [key]` → the slug widget shows it inline). `excludeId` skips the row's own row on update so
 *  re-saving an unchanged slug isn't a false collision. Scope = the whole table (a plain `unique` column is
 *  global). The DB UNIQUE index stays as the integrity backstop against a race. */
function assertUniqueSlugs(db: DB, c: BuiltCollection, values: Row, excludeId: number | null): void {
  let cols: Record<string, AnySQLiteColumn> | undefined
  const issues: { path: string[]; message: string }[] = []
  for (const [key, fieldDef] of Object.entries(c.def.fields)) {
    if (fieldDef.type !== 'slug' || !fieldDef.unique) continue
    const { jsKey } = resolveColumnName(key, fieldDef)
    const slug = values[jsKey]
    if (typeof slug !== 'string' || !slug) continue
    cols ??= columns(c)
    const where = excludeId == null ? eq(cols[jsKey], slug) : and(eq(cols[jsKey], slug), ne(cols.id, excludeId))
    if (db.select({ id: cols.id }).from(table(c)).where(where).get()) {
      issues.push({ path: [key], message: `The slug “${slug}” already exists — choose a different one.` })
    }
  }
  if (issues.length) throw createError({ statusCode: 400, statusMessage: 'Validation failed', data: issues })
}

export function create(db: DB, c: BuiltCollection, body: unknown): Row {
  if (c.def.mode === 'single') {
    throw createError({ statusCode: 405, statusMessage: 'Use PUT for singletons' })
  }
  const parsed = c.insert.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Validation failed', data: parsed.error.issues })
  }
  assertConditions(c, parsed.data as Row)
  const values = { ...(parsed.data as Row) }
  if (c.def.translatable) values.locale = resolveLocale(values.locale as string | undefined)
  if (c.def.mode === 'multi' && c.def.translatable && !values.translationGroup) values.translationGroup = nanoid()
  // pageLike: require a slug (auto-generate from the title when blank) + enforce global resolved-route
  // uniqueness. Owns the path normalization (leading slash + lowercase).
  if (c.def.pageLike) resolvePageSlug(db, c, values, { id: null, existing: null, collections: allCollections(), primary: primaryLocale(), prefixPrimary: prefixPrimaryLocale() })
  applyFieldTransforms(c, values, values, true) // e.g. a blank `slug` field auto-generated from `title`
  assertUniqueSlugs(db, c, values, null) // a duplicate slug is a clear field error, never a silent rewrite
  delete values.id
  delete values.createdAt
  delete values.updatedAt

  const row = runCatchingUnique(() => db.insert(table(c)).values(values).returning().get() as Row)
  emitWrite(c.def, null, row)
  return row
}

export interface UpdateOptions {
  /** Optimistic-concurrency precondition: the `updatedAt` (epoch ms) the caller last read. When given and
   *  it no longer matches the stored row, the update is refused with 409 — so a stale editor tab can't
   *  silently revert a newer save (and propagate that revert into the static output). Omitted → unconditional. */
  expectedUpdatedAt?: number
}

export function update(db: DB, c: BuiltCollection, id: number, body: unknown, opts: UpdateOptions = {}): Row {
  if (c.def.mode === 'single') throw createError({ statusCode: 405, statusMessage: 'Use PUT for singletons' })
  const parsed = c.update.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Validation failed', data: parsed.error.issues })
  }
  const values: Row = { ...(parsed.data as Row), updatedAt: new Date() }
  // Normalize whenever `locale` is present — including '' (the update schema allows any string). Mirrors
  // create(): resolveLocale('') coerces to the primary, so an empty locale can never be persisted (which
  // would drop the row from every locale-filtered list and mis-route a pageLike record).
  if (c.def.translatable && 'locale' in values) values.locale = resolveLocale(values.locale as string | undefined)
  delete values.id
  delete values.createdAt
  delete values.translationGroup
  delete values.singletonKey

  const cols = columns(c)
  const before = db.select().from(table(c)).where(eq(cols.id, id)).get() as Row | undefined
  // Optimistic concurrency: refuse a write whose baseline is stale, BEFORE any mutation (a missing row
  // still 404s below, not 409 — the precondition only guards an existing row the caller means to replace).
  if (before && opts.expectedUpdatedAt !== undefined) {
    const current = before.updatedAt instanceof Date ? before.updatedAt.getTime() : new Date(before.updatedAt as string | number).getTime()
    if (current !== opts.expectedUpdatedAt) {
      throw createError({ statusCode: 409, statusMessage: 'This record changed since you opened it. Reload to see the latest version before saving.' })
    }
  }
  // Conditional-required is enforced on the merged record (existing ⊕ patch); skip when the row is
  // missing — the update returns 404 below rather than a misleading 400.
  if (before) assertConditions(c, { ...before, ...(parsed.data as Row) })
  // pageLike slug: re-validate when the update changes the resolved route — either `path` directly, OR
  // the `locale` (the route is localePath(path, locale, …), so a locale-only change re-routes the row).
  // For a locale-only change, seed the existing path so resolvePageSlug re-checks it as an explicit path
  // under the new locale (rejects a cross-collection 409). An update touching neither leaves the route as-is.
  const localeChanged = !!c.def.translatable && 'locale' in values && values.locale !== before?.locale
  if (c.def.pageLike && before && ('path' in values || localeChanged)) {
    if (!('path' in values) && typeof before.path === 'string') values.path = before.path
    if ('path' in values) resolvePageSlug(db, c, values, { id, existing: before, collections: allCollections(), primary: primaryLocale(), prefixPrimary: prefixPrimaryLocale() })
  }
  // Field write-transforms (only the patched fields; merged record gives transforms their cross-field source).
  if (before) applyFieldTransforms(c, values, { ...before, ...values }, false)
  assertUniqueSlugs(db, c, values, id) // a patched slug that collides errors (excluding this row itself)
  const row = runCatchingUnique(() => db.update(table(c)).set(values).where(eq(cols.id, id)).returning().get() as Row | undefined)
  if (!row) throw createError({ statusCode: 404, statusMessage: `${c.name} ${id} not found` })
  emitWrite(c.def, before ?? null, row)
  return row
}

/** Single-record delete — a thin delegate over `removeMany([id])` so there is ONE delete implementation.
 *  The `[id].delete.ts` route and its `{ deleted, id }` contract are unchanged. */
export function remove(db: DB, c: BuiltCollection, id: number): { deleted: true; id: number } {
  removeMany(db, c, [id])
  return { deleted: true, id }
}

/**
 * Delete a batch of rows by id — the single implementation behind both the single-record delete and the
 * bulk `delete` action (a row action IS a bulk action with one id). ALL-OR-NOTHING: a pre-flight existence
 * check aborts the whole delete with a clean 404 if ANY id is absent from THIS collection (a foreign or a
 * stale id), so a partial silent success is impossible. The delete is one atomic multi-row statement; the
 * per-row write events fire strictly AFTER it (never inside a rollback-able transaction) so a failed delete
 * can never leave a stray publish-prune enqueued for an un-deleted row.
 */
export function removeMany(db: DB, c: BuiltCollection, ids: number[]): { count: number; ids: number[] } {
  if (c.def.mode === 'single') throw createError({ statusCode: 405, statusMessage: 'Use PUT for singletons' })
  const cols = columns(c)
  const rows = db.select().from(table(c)).where(inArray(cols.id, ids)).all() as Row[]
  const found = new Set(rows.map((r) => r.id as number))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length) throw createError({ statusCode: 404, statusMessage: `${c.name} not found: ${missing.join(', ')}` })
  db.delete(table(c)).where(inArray(cols.id, ids)).run()
  for (const before of rows) emitWrite(c.def, before, null)
  return { count: rows.length, ids: rows.map((r) => r.id as number) }
}

/**
 * Publish / unpublish a batch of rows by persisting their `status` — NOT a separate publish path. Writing
 * `status` and emitting the SAME write event the editor save emits IS the publish: classifyWrite →
 * planInvalidation → the publish queue coalesces N emits into one incremental publish (PUBLISH renders the
 * self route, UNPUBLISH prunes the old route). ALL-OR-NOTHING like `removeMany` (a missing id 404s before
 * any write). Validation (`assertConditions`) runs on PUBLISH ONLY — unpublishing must never be blockable
 * (you must always be able to take a broken page offline). Omits `update()`'s slug/transform branches,
 * which are provably inert for a status-only change.
 */
export function setStatusMany(db: DB, c: BuiltCollection, ids: number[], status: 'draft' | 'published'): { count: number; ids: number[] } {
  if (c.def.mode === 'single') throw createError({ statusCode: 405, statusMessage: 'Use PUT for singletons' })
  if (!c.def.status) throw createError({ statusCode: 400, statusMessage: `${c.name} has no status` })
  const cols = columns(c)
  const before = db.select().from(table(c)).where(inArray(cols.id, ids)).all() as Row[]
  const found = new Set(before.map((r) => r.id as number))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length) throw createError({ statusCode: 404, statusMessage: `${c.name} not found: ${missing.join(', ')}` })
  if (status === 'published') for (const row of before) assertConditions(c, { ...row, status })
  const updatedAt = new Date()
  db.update(table(c)).set({ status, updatedAt }).where(inArray(cols.id, ids)).run()
  for (const b of before) emitWrite(c.def, b, { ...b, status, updatedAt })
  return { count: before.length, ids: before.map((r) => r.id as number) }
}

/**
 * Duplicate a batch of rows — sequential and best-effort (a duplicate is a row action, not an all-or-nothing
 * transaction): each id becomes a new draft copy via `duplicateRecord`, and the first failing id throws its
 * own status. `duplicate.ts` is imported lazily because it composes `create()` from THIS module — a static
 * import would form a load-time cycle (crud → duplicate → crud); deferring keeps crud's module graph acyclic.
 */
export async function duplicateMany(db: DB, c: BuiltCollection, ids: number[]): Promise<Row[]> {
  const { duplicateRecord } = await import('./duplicate')
  const out: Row[] = []
  for (const id of ids) out.push(duplicateRecord(db, c, id))
  return out
}

export function resolveTranslations(db: DB, c: BuiltCollection, id: number): Record<string, number | null> {
  if (c.def.mode === 'single' || !c.def.translatable) {
    throw createError({ statusCode: 400, statusMessage: 'Translations are not enabled for this collection' })
  }
  const cols = columns(c)
  const base = db.select().from(table(c)).where(eq(cols.id, id)).get() as Row | undefined
  if (!base) throw createError({ statusCode: 404, statusMessage: `${c.name} ${id} not found` })
  const rows = db.select().from(table(c)).where(eq(cols.translationGroup, base.translationGroup)).all() as Row[]

  const result: Record<string, number | null> = {}
  for (const loc of supportedLocales()) result[loc] = null
  for (const row of rows) result[row.locale as string] = row.id as number
  return result
}

export function getSingleton(db: DB, c: BuiltCollection, locale?: string, publishedOnly = false, depth = 0): Row | null {
  captureRead(c.def.name) // a singleton (nav/settings/footer) is global — any page that reads it depends on it
  const cols = columns(c)
  const loc = c.def.translatable ? resolveLocale(locale) : primaryLocale()
  const where = singletonWhere(cols, c, c.def.translatable ? loc : undefined)
  const row = db.select().from(table(c)).where(where).get() as Row | undefined
  if (!row) return null
  if (publishedOnly && Object.hasOwn(cols, 'status') && row.status !== 'published') return null
  // Populate like list()/getOne() so a singleton's media/relation/link fields resolve at depth > 0 — the
  // canonical settings-singleton (site logo, nav link repeater) relies on this exactly as any collection does.
  return withResolveScope(
    () => populateRow(row as Record<string, unknown>, { depth: clampDepth(depth), locale: loc, def: c.def }),
    resolveBudgetFor(1),
    `singleton ${c.def.name}`,
  ) as Row
}

export function putSingleton(db: DB, c: BuiltCollection, locale: string | undefined, body: unknown, opts: UpdateOptions = {}): Row {
  if (c.def.mode !== 'single') {
    throw createError({ statusCode: 405, statusMessage: 'PUT is only for singletons' })
  }
  const loc = c.def.translatable ? resolveLocale(locale) : undefined
  const cols = columns(c)
  const existing = db.select().from(table(c))
    .where(singletonWhere(cols, c, loc))
    .get() as Row | undefined
  // Optimistic concurrency: reject an overwrite whose baseline is stale (a concurrent edit of the same
  // singleton). Only applies to an OVERWRITE — a first save (no existing row) has no baseline to conflict.
  if (existing && opts.expectedUpdatedAt !== undefined) {
    const current = existing.updatedAt instanceof Date ? existing.updatedAt.getTime() : new Date(existing.updatedAt as string | number).getTime()
    if (current !== opts.expectedUpdatedAt) {
      throw createError({ statusCode: 409, statusMessage: 'This record changed since you opened it. Reload to see the latest version before saving.' })
    }
  }
  // First save (no existing row) validates with the FULL insert schema so a missing hard-required field is
  // a clean 400 — `.partial()` would let it through and hit the NOT NULL column as an unmapped 500. An
  // overwrite is a PATCH-style partial (only the sent fields change).
  const parsed = (existing ? c.insert.partial() : c.insert).safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Validation failed', data: parsed.error.issues })
  }
  // A PUT replaces (create or overwrite) the singleton — enforce conditional-required on the merged record.
  assertConditions(c, { ...(existing ?? {}), ...(parsed.data as Row) })

  const values: Row = { ...(parsed.data as Row), singletonKey: c.name }
  if (c.def.translatable) values.locale = loc
  delete values.id
  delete values.createdAt
  delete values.updatedAt
  // Mirror create()/update(): auto-generate transform-driven fields (e.g. a blank slug from `title`) and
  // reject a colliding unique slug with a clean field error, BEFORE the write.
  applyFieldTransforms(c, values, existing ? { ...existing, ...values } : values, !existing)
  assertUniqueSlugs(db, c, values, (existing?.id as number) ?? null)
  const saved = runCatchingUnique(() => existing
    ? db.update(table(c)).set({ ...values, updatedAt: new Date() }).where(eq(cols.id, existing.id)).returning().get() as Row
    : db.insert(table(c)).values(values).returning().get() as Row)
  emitWrite(c.def, existing ?? null, saved)
  return saved
}
