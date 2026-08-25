import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import prerenderRoutesModule, { discoverRoutes } from './index'
import { readRouteDiscovery } from '@kestrel/delivery-static'

const dir = (): string => mkdtempSync(join(tmpdir(), 'kestrel-prerender-'))

afterEach(() => vi.restoreAllMocks())

describe('discoverRoutes', () => {
  it('reads the published page routes from a real build-time DB and reports the enumeration complete', () => {
    const path = join(dir(), 'db.sqlite')
    const db = new Database(path)
    db.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, locale TEXT NOT NULL, path TEXT, status TEXT NOT NULL DEFAULT 'draft')`)
    db.exec(`CREATE UNIQUE INDEX pages_path_locale ON pages (path, locale) WHERE path is not null`)
    db.exec(`INSERT INTO pages (locale, path, status) VALUES ('en','/about','published'),('en','/draft','draft')`)
    db.close()
    expect(discoverRoutes(path, 'en', false)).toEqual({ routes: ['/', '/about'] })
  })

  it('degrades to the root when the DB file does not exist yet (first build) and REPORTS it incomplete', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = discoverRoutes(join(dir(), 'nope.sqlite'), 'en', false)
    expect(missing.routes).toEqual(['/'])
    expect(missing.incomplete).toMatch(/no database/i)
    expect(discoverRoutes(':memory:', 'en', false).incomplete).toMatch(/in-memory/i)
    expect(warn).toHaveBeenCalled()
  })

  it('THROWS on an unreadable DB when an S3 deploy will reconcile against this build', () => {
    const path = join(dir(), 'junk.sqlite')
    writeFileSync(path, 'not a database at all')
    expect(() => discoverRoutes(path, 'en', false, true)).toThrow(/cannot read the database/i)
  })

  it('degrades (does not abort the generate) on an unreadable DB when nothing downstream reconciles', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const path = join(dir(), 'junk.sqlite')
    writeFileSync(path, 'not a database at all')
    const degraded = discoverRoutes(path, 'en', false)
    expect(degraded.routes).toEqual(['/'])
    expect(degraded.incomplete).toMatch(/cannot read the database/i)
    expect(warn).toHaveBeenCalled()
  })

  // Opening a file says nothing about its content: SQLite accepts a 0-byte (or simply wrong) file as a
  // valid EMPTY database, and root-only routes read exactly like a complete enumeration downstream.
  it('REPORTS a DB that opens but holds no page-like table (unmigrated / zero-byte / wrong file)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const zeroByte = join(dir(), 'db.sqlite')
    writeFileSync(zeroByte, '')
    const empty = discoverRoutes(zeroByte, 'en', false)
    expect(empty.routes).toEqual(['/'])
    expect(empty.incomplete).toMatch(/no page-like table/i)

    const wrongFile = join(dir(), 'someone-elses.sqlite')
    const other = new Database(wrongFile)
    other.exec(`CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)`)
    other.close()
    expect(discoverRoutes(wrongFile, 'en', false).incomplete).toMatch(/no page-like table/i)
    expect(warn).toHaveBeenCalled()
  })

  it('reports a migrated CMS that currently publishes NO page as complete (an empty table is an answer)', () => {
    const path = join(dir(), 'db.sqlite')
    const db = new Database(path)
    db.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, locale TEXT NOT NULL, path TEXT, status TEXT NOT NULL DEFAULT 'draft')`)
    db.exec(`CREATE UNIQUE INDEX pages_path_locale ON pages (path, locale) WHERE path is not null`)
    db.exec(`INSERT INTO pages (locale, path, status) VALUES ('en','/soon','draft')`)
    db.close()
    expect(discoverRoutes(path, 'en', false, true)).toEqual({ routes: ['/'] })
  })
})

type NitroConfigHook = (nitro: { static?: boolean; prerender?: { routes?: string[]; ignore?: string[]; concurrency?: number } }) => void
type NuxtModule = (inline: object, nuxt: unknown) => Promise<unknown>

/** The real module against a stand-in Nuxt: returns the shared Nuxt object (the discovery signal's
 *  carrier) and the `nitro:config` handlers it registered. Nuxt fills `nitro.static` from the CLI's
 *  `--prerender` before calling that hook, so it is set exactly for a `nuxt generate`. */
async function setupModule(kestrel: Record<string, unknown>): Promise<{ nuxt: object; fire: (nitro: { static?: boolean }) => void }> {
  const hooks: NitroConfigHook[] = []
  const nuxt = {
    options: { kestrel, rootDir: dir() },
    hook: (name: string, fn: NitroConfigHook) => { if (name === 'nitro:config') hooks.push(fn) },
  }
  await (prerenderRoutesModule as unknown as NuxtModule)({}, nuxt)
  return { nuxt, fire: (nitro) => { for (const fn of hooks) fn(nitro) } }
}

describe('kestrel-prerender-routes module', () => {
  const unreadableDb = (): string => {
    const path = join(dir(), 'db.sqlite')
    writeFileSync(path, 'not a database at all')
    return path
  }
  const s3 = (db: string): Record<string, unknown> => ({ db, output: { driver: 's3', auto: false, s3: { bucket: 'b', prefix: 'site' } } })

  it('fails a static generate that would ship to S3 with a DB it cannot read', async () => {
    const { fire } = await setupModule(s3(unreadableDb()))
    expect(() => fire({ static: true })).toThrow(/refusing to ship/i)
  })

  it('does NOT fail `nuxt dev` / `nuxt build` on that same DB — neither deploys, so nothing is at risk', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { nuxt, fire } = await setupModule(s3(unreadableDb()))
    expect(() => fire({ static: false })).not.toThrow()
    expect(readRouteDiscovery(nuxt)?.incomplete).toMatch(/cannot read the database/i)
    expect(warn).toHaveBeenCalled()
  })
})
