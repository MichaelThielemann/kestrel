import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { createError } from 'h3'
import { buildCollection } from '@kestrel/core'
import { clearRegistry, defineCollection, desiredSchema, diffSchema, getResolvedKestrelConfig, registerCollection, renderSqlite, resetDbInstance, setResolvedKestrelConfig, useDb } from '@kestrel/core'
import { registerBlock, clearBlocks } from '@kestrel/fields'
// The route is a server route driven by auto-imports (Nitro's `server/utils` convention); stub those as
// globals so the handler can be exercised as a plain function. `siteBaseUrl`/`siteName`/`siteDescription`/
// `llmsFullEnabled` are explicit `@kestrel/publishing` imports, mocked as `vi.fn()`s so individual tests
// can override their return value.
vi.mock('@kestrel/publishing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kestrel/publishing')>()),
  llmsFullEnabled: vi.fn(() => true),
  siteBaseUrl: vi.fn(() => 'https://example.test'),
  siteName: vi.fn(() => 'Example'),
  siteDescription: vi.fn(() => ''),
}))
const publishing = await import('@kestrel/publishing')
const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: true, pageLike: true, status: true, seo: true,
  blocks: { enabled: true }, fields: { title: { type: 'text' }, lead: { type: 'text' }, hero: { type: 'media' } },
}))
// Its table gets a projected column dropped mid-test, so the read throws like a drifted/unmigrated DB.
const drifted = buildCollection(defineCollection({
  name: 'drifted', mode: 'multi', translatable: false, pageLike: true, status: true, seo: true,
  fields: { title: { type: 'text' } },
}))

let db: BetterSQLite3Database
let sqlite: Database.Database
const selectArgs: unknown[][] = []
let handler: (event: unknown) => unknown

function insert(row: { path: string; status: string; locale?: string; content?: string; seo?: string; lead?: string }): number {
  return sqlite.prepare(
    `INSERT INTO pages (locale, translation_group, path, status, title, lead, seo, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1000)`,
  ).run(row.locale ?? 'en', `g-${row.path}`, row.path, row.status, `T ${row.path}`, row.lead ?? '', row.seo ?? '{}', row.content ?? '[]')
    .lastInsertRowid as number
}
const wipe = () => sqlite.exec('DELETE FROM pages')

beforeAll(async () => {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  db = useDb() as unknown as BetterSQLite3Database
  sqlite = (db as unknown as { $client: Database.Database }).$client
  const desired = desiredSchema(
    [pages.table, drifted.table],
    new Map([[pages.def.name, pages.def], [drifted.def.name, drifted.def]]),
  )
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  vi.spyOn(db, 'select').mockImplementation((...args: unknown[]) => {
    selectArgs.push(args)
    return (Object.getPrototypeOf(db).select as (...a: unknown[]) => unknown).apply(db, args)
  })
  clearRegistry()
  registerCollection(pages)
  vi.stubGlobal('defineEventHandler', (h: (event: unknown) => unknown) => h)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('primaryLocale', () => 'en')
  vi.stubGlobal('prefixPrimaryLocale', () => false)
  vi.stubGlobal('publicReadableResources', () => ['pages'])
  vi.stubGlobal('isPubliclyReadable', () => true)
  vi.stubGlobal('setHeader', () => {})
  handler = (await import('./llms-full.txt.get')).default as (event: unknown) => unknown
})

afterEach(() => {
  wipe()
  clearBlocks()
  vi.mocked(publishing.llmsFullEnabled).mockReturnValue(true)
  vi.mocked(publishing.siteBaseUrl).mockReturnValue('https://example.test')
})

describe('llms-full.txt route', () => {
  it('404s while the feature is off — the default', () => {
    vi.mocked(publishing.llmsFullEnabled).mockReturnValue(false)
    expect(() => handler({})).toThrowError(expect.objectContaining({ statusCode: 404 }))
  })

  it('emits each published, indexable page under its own heading with its body', () => {
    registerBlock({ name: 'prose', fields: { body: { type: 'richtext' } } })
    insert({ path: '/about', status: 'published', lead: 'A lead.', content: JSON.stringify([{ id: 'b1', type: 'prose', props: { body: '<h1>Story</h1><p>Since 1999.</p>' } }]) })
    insert({ path: '/secret', status: 'draft', lead: 'Hidden lead.' })
    insert({ path: '/hidden', status: 'published', lead: 'Also hidden.', seo: JSON.stringify({ noindex: true }) })
    const txt = handler({}) as string
    expect(txt).toBe(
      '# Example\n'
      + '\n## Pages\n'
      + '\n### T /about\n'
      + '\nSource: https://example.test/about\n'
      + '\nA lead.\n'
      + '\n#### Story\n'
      + '\nSince 1999.\n',
    )
    expect(txt).not.toContain('Hidden lead.')
    expect(txt).not.toContain('Also hidden.')
  })

  it('prefers the meta title and description, and locale-prefixes the source URL', () => {
    insert({ path: '/ueber-uns', status: 'published', locale: 'de', seo: JSON.stringify({ title: 'Über uns', description: 'Wer wir sind' }) })
    const txt = handler({}) as string
    expect(txt).toContain('### Über uns')
    expect(txt).toContain('Source: https://example.test/de/ueber-uns')
    expect(txt).toContain('\nWer wir sind\n')
  })

  it('does not repeat the page title as body text', () => {
    insert({ path: '/about', status: 'published' })
    expect((handler({}) as string).match(/T \/about/g)).toHaveLength(1)
  })

  it('resolves an internal richtext link to a published page and drops one to a draft', () => {
    registerBlock({ name: 'prose', fields: { body: { type: 'richtext' } } })
    const draftId = insert({ path: '/secret', status: 'draft' })
    const liveId = insert({ path: '/live', status: 'published' })
    insert({
      path: '/about',
      status: 'published',
      content: JSON.stringify([{ id: 'b1', type: 'prose', props: { body: `<p>See <a href="kestrel:pages:${liveId}">live</a> and <a href="kestrel:pages:${draftId}">secret</a>.</p>` } }]),
    })
    const txt = handler({}) as string
    expect(txt).toContain('See [live](https://example.test/live) and secret.')
    expect(txt).not.toContain('kestrel:pages:')
  })

  it('projects the prose columns and the block content, but not media/relation columns', () => {
    selectArgs.length = 0
    insert({ path: '/about', status: 'published' })
    handler({})
    const proj = selectArgs[0]![0] as Record<string, unknown>
    expect(Object.keys(proj).sort()).toEqual(['content', 'id', 'lead', 'locale', 'path', 'seo', 'status', 'title'])
  })

  it('emits the site header alone when the site url is unset — a relative Source: line resolves nowhere', () => {
    insert({ path: '/about', status: 'published' })
    vi.mocked(publishing.siteBaseUrl).mockReturnValue('')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(handler({}) as string).toBe('# Example\n')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('llms-full.txt: siteUrl is unset'))
    } finally {
      warn.mockRestore()
    }
  })

  it('logs the collection it skipped when its table is unreadable, instead of silently dropping its section', () => {
    insert({ path: '/about', status: 'published' })
    sqlite.prepare(`INSERT INTO drifted (path, status, title, seo, created_at, updated_at) VALUES ('/gone', 'published', 'T', '{}', 0, 1000)`).run()
    sqlite.exec('ALTER TABLE drifted DROP COLUMN seo')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    clearRegistry()
    registerCollection(pages)
    registerCollection(drifted)
    try {
      const txt = handler({}) as string
      expect(txt).not.toContain('/gone') // the gap itself stays — a bare prerender DB must not fail the publish
      expect(txt).toContain('Source: https://example.test/about')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('llms-full.txt: skipped collection drifted'), expect.anything())
    } finally {
      error.mockRestore()
      clearRegistry()
      registerCollection(pages)
      sqlite.exec('DELETE FROM drifted')
    }
  })
})
