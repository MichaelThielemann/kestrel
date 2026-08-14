import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { createError } from 'h3'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { desiredSchema } from '../../../core/server/schema/desired'
import { diffSchema } from '../../../core/server/schema/diff'
import { renderSqlite } from '../../../core/server/schema/render-sqlite'
import { collectionHeading } from '../utils/llms'
import { buildLlmsFullTxt, recordMarkdown } from '../utils/llms-full'
import { registerBlock, clearBlocks } from '../../../fields/server/utils/defineBlock'
import type { BuiltCollection } from '../../../core/server/utils/collection-types'

// The route is a server route driven by auto-imports; stub them as globals (the same seam the Nitro
// build provides) so the handler can be exercised as a plain function.
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
let enabled = true

function insert(row: { path: string; status: string; locale?: string; content?: string; seo?: string; lead?: string }): number {
  return sqlite.prepare(
    `INSERT INTO pages (locale, translation_group, path, status, title, lead, seo, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1000)`,
  ).run(row.locale ?? 'en', `g-${row.path}`, row.path, row.status, `T ${row.path}`, row.lead ?? '', row.seo ?? '{}', row.content ?? '[]')
    .lastInsertRowid as number
}
const wipe = () => sqlite.exec('DELETE FROM pages')

beforeAll(async () => {
  sqlite = new Database(':memory:')
  const desired = desiredSchema(
    [pages.table, drifted.table],
    new Map([[pages.def.name, pages.def], [drifted.def.name, drifted.def]]),
  )
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  const spyDb = { select: (...args: unknown[]) => { selectArgs.push(args); return (db.select as (...a: unknown[]) => unknown)(...args) } }
  vi.stubGlobal('defineEventHandler', (h: (event: unknown) => unknown) => h)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('useDb', () => spyDb)
  vi.stubGlobal('llmsFullEnabled', () => enabled)
  vi.stubGlobal('siteBaseUrl', () => 'https://example.test')
  vi.stubGlobal('siteName', () => 'Example')
  vi.stubGlobal('siteDescription', () => '')
  vi.stubGlobal('primaryLocale', () => 'en')
  vi.stubGlobal('prefixPrimaryLocale', () => false)
  vi.stubGlobal('allCollections', (): BuiltCollection[] => [pages])
  vi.stubGlobal('publicReadableResources', () => ['pages'])
  vi.stubGlobal('isPubliclyReadable', () => true)
  vi.stubGlobal('buildLlmsFullTxt', buildLlmsFullTxt)
  vi.stubGlobal('recordMarkdown', recordMarkdown)
  vi.stubGlobal('collectionHeading', collectionHeading)
  vi.stubGlobal('setHeader', () => {})
  handler = (await import('./llms-full.txt.get')).default as (event: unknown) => unknown
})

afterEach(() => { wipe(); clearBlocks(); enabled = true })

describe('llms-full.txt route', () => {
  it('404s while the feature is off — the default', () => {
    enabled = false
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
    vi.stubGlobal('siteBaseUrl', () => '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(handler({}) as string).toBe('# Example\n')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('llms-full.txt: siteUrl is unset'))
    } finally {
      warn.mockRestore()
      vi.stubGlobal('siteBaseUrl', () => 'https://example.test')
    }
  })

  it('logs the collection it skipped when its table is unreadable, instead of silently dropping its section', () => {
    insert({ path: '/about', status: 'published' })
    sqlite.prepare(`INSERT INTO drifted (path, status, title, seo, created_at, updated_at) VALUES ('/gone', 'published', 'T', '{}', 0, 1000)`).run()
    sqlite.exec('ALTER TABLE drifted DROP COLUMN seo')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('allCollections', (): BuiltCollection[] => [pages, drifted])
    try {
      const txt = handler({}) as string
      expect(txt).not.toContain('/gone') // the gap itself stays — a bare prerender DB must not fail the publish
      expect(txt).toContain('Source: https://example.test/about')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('llms-full.txt: skipped collection drifted'), expect.anything())
    } finally {
      error.mockRestore()
      vi.stubGlobal('allCollections', (): BuiltCollection[] => [pages])
      sqlite.exec('DELETE FROM drifted')
    }
  })
})
