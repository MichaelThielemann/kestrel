import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { desiredSchema } from '../../../core/server/schema/desired'
import { diffSchema } from '../../../core/server/schema/diff'
import { renderSqlite } from '../../../core/server/schema/render-sqlite'
import type { BuiltCollection } from '../../../core/server/utils/collection-types'
import { resolvePage } from './page-resolve'

const def = (name: string) => buildCollection(defineCollection({
  name, mode: 'multi', translatable: true, pageLike: true, status: true, fields: { title: { type: 'text' } },
}))
const p1 = def('p1')
const p2 = def('p2')
// seo-enabled pageLike to exercise the noindex hreflang filter
const seoP = buildCollection(defineCollection({
  name: 'seop', mode: 'multi', translatable: true, pageLike: true, status: true, seo: true, fields: { title: { type: 'text' } },
}))
// the lean schema variant: translatable + pageLike but NO status column at all
const noStatus = buildCollection(defineCollection({
  name: 'nostatus', mode: 'multi', translatable: true, pageLike: true, fields: { title: { type: 'text' } },
}))
// a non-pageLike collection (no path) — resolvePage must skip it without querying its table
const settings = buildCollection(defineCollection({ name: 'settings', mode: 'single', fields: { siteName: { type: 'text' } } }))

function build(collections: BuiltCollection[]): { db: BetterSQLite3Database; sqlite: Database.Database } {
  const sqlite = new Database(':memory:')
  const desired = desiredSchema(collections.map((c) => c.table), new Map(collections.map((c) => [c.def.name, c.def])))
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  return { db: drizzle(sqlite), sqlite }
}

function insert(sqlite: Database.Database, table: string, row: { path: string; status: string; locale?: string; group?: string }): void {
  sqlite.prepare(
    `INSERT INTO ${table} (locale, translation_group, path, status, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)`,
  ).run(row.locale ?? 'en', row.group ?? `g-${table}-${row.path}`, row.path, row.status, 'T')
}

describe('resolvePage', () => {
  it('returns the first published pageLike match across collections; skips drafts and non-pageLike', () => {
    const { db, sqlite } = build([p1, p2, settings])
    insert(sqlite, 'p1', { path: '/about', status: 'published' })
    insert(sqlite, 'p1', { path: '/draft', status: 'draft' })
    insert(sqlite, 'p2', { path: '/about', status: 'published' }) // same path as p1 → precedence test
    insert(sqlite, 'p2', { path: '/promo', status: 'published' })

    // registration order is the precedence rule: p1 before p2 → p1 wins on the shared path
    expect(resolvePage(db, [p1, p2, settings], '/about', 'en').page).toMatchObject({ collection: 'p1' })
    // only p2 owns /promo
    expect(resolvePage(db, [p1, p2, settings], '/promo', 'en').page).toMatchObject({ collection: 'p2' })
    // a draft is never served (publishedOnly), even though the row exists
    expect(resolvePage(db, [p1, p2, settings], '/draft', 'en').page).toBeNull()
    expect(resolvePage(db, [p1, p2, settings], '/missing', 'en').page).toBeNull()
  })

  it('honours the requested locale', () => {
    const { db, sqlite } = build([p1])
    insert(sqlite, 'p1', { path: '/x', status: 'published', locale: 'de' })
    expect(resolvePage(db, [p1], '/x', 'de').page).toMatchObject({ collection: 'p1' })
    expect(resolvePage(db, [p1], '/x', 'en').page).toBeNull() // no en row at this path
  })

  it('returns the published translation alternates of the matched page (never drafts), by locale', () => {
    const { db, sqlite } = build([p1])
    insert(sqlite, 'p1', { path: '/x', status: 'published', locale: 'en', group: 'g1' })
    insert(sqlite, 'p1', { path: '/x-de', status: 'published', locale: 'de', group: 'g1' })
    insert(sqlite, 'p1', { path: '/x-fr', status: 'draft', locale: 'fr', group: 'g1' })
    insert(sqlite, 'p1', { path: '/other', status: 'published', locale: 'en', group: 'g2' })
    const resolved = resolvePage(db, [p1], '/x', 'en').page!
    expect(resolved.alternates).toEqual([
      { locale: 'de', path: '/x-de' },
      { locale: 'en', path: '/x' },
    ])
  })

  it('excludes a noindexed sibling from the hreflang alternates (matches the sitemap)', async () => {
    const { withReadCapture } = await import('../../../core/server/utils/read-capture')
    const { db, sqlite } = build([seoP])
    const insSeo = (path: string, locale: string, noindex: boolean) =>
      sqlite.prepare(`INSERT INTO seop (locale, translation_group, path, status, title, seo, created_at, updated_at) VALUES (?, 'g1', ?, 'published', 'T', ?, 0, 0)`)
        .run(locale, path, JSON.stringify(noindex ? { noindex: true } : {}))
    insSeo('/about', 'en', false)
    insSeo('/ueber-uns', 'de', true) // published but noindexed → must NOT appear as an alternate
    insSeo('/a-propos', 'fr', false)
    const { result, tags } = await withReadCapture(() => resolvePage(db, [seoP], '/about', 'en').page!)
    // the noindexed DE variant is dropped; EN + FR remain → still a real (≥2) hreflang set
    expect(result.alternates).toEqual([
      { locale: 'en', path: '/about' },
      { locale: 'fr', path: '/a-propos' },
    ])
    // every sibling (incl. the filtered noindex one) is captured as a publish dep, so a later change re-renders
    expect(tags.filter((t) => t.startsWith('seop:')).length).toBe(3)
  })

  it('emits no hreflang set when the rendered page itself is noindexed, even with indexable siblings', async () => {
    const { db, sqlite } = build([seoP])
    const insSeo = (path: string, locale: string, noindex: boolean) =>
      sqlite.prepare(`INSERT INTO seop (locale, translation_group, path, status, title, seo, created_at, updated_at) VALUES (?, 'g1', ?, 'published', 'T', ?, 0, 0)`)
        .run(locale, path, JSON.stringify(noindex ? { noindex: true } : {}))
    insSeo('/ueber-uns', 'de', true) // the page being rendered — itself noindexed
    insSeo('/about', 'en', false)
    insSeo('/a-propos', 'fr', false)
    const resolved = resolvePage(db, [seoP], '/ueber-uns', 'de').page!
    // en+fr alone would be a valid (>=2) hreflang set, but without a self-reference it must be suppressed
    expect(resolved.alternates).toEqual([])
  })

  it('captures a DRAFT sibling as a publish dependency (publishing it must re-render this page)', async () => {
    const { withReadCapture } = await import('../../../core/server/utils/read-capture')
    const { db, sqlite } = build([p1])
    insert(sqlite, 'p1', { path: '/about', status: 'published', locale: 'en', group: 'g1' })
    insert(sqlite, 'p1', { path: '/ueber-uns', status: 'draft', locale: 'de', group: 'g1' })
    const draftId = (sqlite.prepare(`SELECT id FROM p1 WHERE locale = 'de'`).get() as { id: number }).id
    const { result, tags } = await withReadCapture(() => resolvePage(db, [p1], '/about', 'en').page!)
    // the draft sibling is still never advertised (lone published member → no hreflang set) …
    expect(result.alternates).toEqual([])
    // … but the dependency edge exists, so the PUBLISH tag `p1:<id>` has something to match
    expect(tags).toContain(`p1:${draftId}`)
  })

  it('resolves alternates for a collection whose table has no status column (the projection is flag-gated)', () => {
    const { db, sqlite } = build([noStatus])
    const ins = (path: string, locale: string) =>
      sqlite.prepare(`INSERT INTO nostatus (locale, translation_group, path, title, created_at, updated_at) VALUES (?, 'g1', ?, 'T', 0, 0)`).run(locale, path)
    ins('/about', 'en')
    ins('/ueber-uns', 'de')
    expect(resolvePage(db, [noStatus], '/about', 'en').page!.alternates).toEqual([
      { locale: 'de', path: '/ueber-uns' },
      { locale: 'en', path: '/about' },
    ])
  })

  it('skips a null-path sibling instead of throwing', () => {
    const { db, sqlite } = build([p1])
    insert(sqlite, 'p1', { path: '/x', status: 'published', locale: 'en', group: 'g1' })
    sqlite.prepare(`INSERT INTO p1 (locale, translation_group, path, status, title, created_at, updated_at) VALUES ('de', 'g1', NULL, 'published', 'T', 0, 0)`).run()
    // only EN has a path → group of 1 after dropping the null-path DE row → no alternates, no throw
    expect(resolvePage(db, [p1], '/x', 'en').page!.alternates).toEqual([])
  })

  it('returns no alternates for a lone page (single-member group)', () => {
    const { db, sqlite } = build([p1])
    insert(sqlite, 'p1', { path: '/solo', status: 'published' })
    expect(resolvePage(db, [p1], '/solo', 'en').page!.alternates).toEqual([])
  })

  it('skips a collection whose table is missing/drifted instead of throwing out of resolvePage', () => {
    const { db, sqlite } = build([p1, p2])
    insert(sqlite, 'p2', { path: '/about', status: 'published' })
    sqlite.exec('DROP TABLE p1') // simulate an unmigrated/drifted collection sharing this build's DB
    expect(resolvePage(db, [p1, p2], '/about', 'en').page).toMatchObject({ collection: 'p2' })
  })

  it('logs the skipped collection — a swallowed read must not look like an empty result', () => {
    const { db, sqlite } = build([p1, p2])
    insert(sqlite, 'p2', { path: '/about', status: 'published' })
    sqlite.exec('DROP TABLE p1')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      resolvePage(db, [p1, p2], '/about', 'en')
      const messages = spy.mock.calls.map((args) => args.map(String).join(' '))
      expect(messages.some((m) => m.includes('resolvePage') && m.includes('p1'))).toBe(true)
    } finally { spy.mockRestore() }
  })

  it('reports the collections whose lookup failed, so no match is not read as no such page', () => {
    const { db, sqlite } = build([p1, p2])
    insert(sqlite, 'p2', { path: '/about', status: 'published' })
    sqlite.exec('DROP TABLE p1')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // a match in a healthy collection still resolves — the gap is reported alongside it …
      expect(resolvePage(db, [p1, p2], '/about', 'en').failed).toEqual(['p1'])
      // … and a scan that matched nothing is explicitly INCOMPLETE, not an authoritative 404
      expect(resolvePage(db, [p1, p2], '/nowhere', 'en')).toEqual({ page: null, failed: ['p1'] })
    } finally { spy.mockRestore() }
  })

  it('subscribes the rendered page to its translation group, so any sibling write re-renders it', async () => {
    const { withReadCapture } = await import('../../../core/server/utils/read-capture')
    const { DepsStore } = await import('./publish/deps')
    const { classifyWrite, planInvalidation } = await import('./publish/invalidation')
    const { db, sqlite } = build([p1])
    // /about renders while it is the ONLY member of its group — nothing it captures can name a sibling yet
    insert(sqlite, 'p1', { path: '/about', status: 'published', locale: 'en', group: 'g1' })
    const { tags } = await withReadCapture(() => resolvePage(db, [p1], '/about', 'en').page!)
    const deps = new DepsStore()
    deps.record('/about', tags)

    const sibling = (over: Record<string, unknown> = {}) => ({ id: 99, path: '/ueber-uns', locale: 'de', status: 'published', translationGroup: 'g1', ...over })
    const routes = (before: Record<string, unknown> | null, after: Record<string, unknown> | null) => {
      const inv = planInvalidation(classifyWrite(p1.def, before, after, 'en'))
      return inv.type === 'tags' ? deps.routesForTags(inv.tags) : []
    }
    // created straight as published …
    expect(routes(null, sibling())).toContain('/about')
    // … the commonest flow: draft, then publish …
    expect(routes(sibling({ status: 'draft' }), sibling())).toContain('/about')
    // … and deleted again: /about's hreflang set must lose it
    expect(routes(sibling(), null)).toContain('/about')
  })

  it('resolves a draft when publishedOnly is false (the authenticated admin preview path)', () => {
    const { db, sqlite } = build([p1])
    insert(sqlite, 'p1', { path: '/draft', status: 'draft' })
    // default (published-only) hides the draft — the static-site / anonymous contract
    expect(resolvePage(db, [p1], '/draft', 'en').page).toBeNull()
    // opting out of the published gate surfaces it (admin live preview)
    expect(resolvePage(db, [p1], '/draft', 'en', false).page).toMatchObject({ collection: 'p1' })
  })
})
