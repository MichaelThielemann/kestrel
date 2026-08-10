import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// The real prune deletes baked files; stub only the deleting half so the module's own gating stays real.
const { pruneSpy } = vi.hoisted(() => ({
  pruneSpy: vi.fn((_dir: string, _baseUrl: string, _opts?: { dryRun?: boolean; ownedKeys?: Set<string> }) => ({ kept: 0, pruned: 0 })),
}))
vi.mock('./prune-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prune-media')>()),
  pruneUnreferencedMedia: pruneSpy,
}))

import pruneMediaModule from './index'

type CompiledHook = () => Promise<void> | void
type NitroHook = (payload?: unknown) => unknown
type NuxtModule = (inline: object, nuxt: unknown) => Promise<unknown>

const add = (m: Map<string, NitroHook[]>, name: string, fn: NitroHook): void => { m.set(name, [...(m.get(name) ?? []), fn]) }

/**
 * A stand-in for the Nuxt instance the module is handed, plus the hook registries, so a test can fire them
 * in nitro's real order (`nitro:init` → `compiled`, the latter only once the output is on disk).
 */
function fakeNuxt(kestrel: Record<string, unknown>, rootDir: string): {
  nuxt: object
  nitroHooks: Map<string, NitroHook[]>
  initNitro: (isStaticGenerate?: boolean) => void
} {
  const nuxtHooks = new Map<string, NitroHook[]>()
  const nitroHooks = new Map<string, NitroHook[]>()
  const nuxt = { options: { kestrel, rootDir }, hook: (name: string, fn: NitroHook) => add(nuxtHooks, name, fn) }
  const initNitro = (isStaticGenerate = true): void => {
    const nitro = {
      options: { static: isStaticGenerate, output: { publicDir: join(rootDir, '.output', 'public') } },
      hooks: { hook: (name: string, fn: NitroHook) => add(nitroHooks, name, fn) },
    }
    for (const fn of nuxtHooks.get('nitro:init') ?? []) fn(nitro)
  }
  return { nuxt, nitroHooks, initNitro }
}

/** Set the module up on a fake nuxt, then drive nitro's real hook order. `rootDir` decides whether the
 *  build-time DB (`<rootDir>/.data/db.sqlite`) exists, which is what the owned-key read reports on. */
async function generate(rootDir: string, kestrel: Record<string, unknown> = {}, isStaticGenerate = true): Promise<Map<string, NitroHook[]>> {
  const ctx = fakeNuxt(kestrel, rootDir)
  await (pruneMediaModule as unknown as NuxtModule)({}, ctx.nuxt)
  ctx.initNitro(isStaticGenerate)
  for (const fn of (ctx.nitroHooks.get('compiled') ?? []) as CompiledHook[]) await fn()
  return ctx.nitroHooks
}

const tempRoot = (): string => mkdtempSync(join(tmpdir(), 'kestrel-prune-module-'))

function seedDb(rootDir: string, sql: string): string {
  mkdirSync(join(rootDir, '.data'), { recursive: true })
  const db = new Database(join(rootDir, '.data', 'db.sqlite'))
  db.exec(sql)
  db.close()
  return rootDir
}

describe('kestrel-prune-media module', () => {
  let logs: string[]
  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)) })
    pruneSpy.mockClear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('skips the prune when there is no database to read the media registry from', async () => {
    await generate(tempRoot())
    expect(pruneSpy).not.toHaveBeenCalled()
    expect(logs.join('\n')).toMatch(/prune skipped/)
  })

  it('skips the prune when the database carries no media table', async () => {
    await generate(seedDb(tempRoot(), 'CREATE TABLE pages (id INTEGER PRIMARY KEY, path TEXT)'))
    expect(pruneSpy).not.toHaveBeenCalled()
    expect(logs.join('\n')).toMatch(/prune skipped/)
  })

  it('skips the prune for an in-memory database — a build-time read can never see its rows', async () => {
    await generate(tempRoot(), { db: ':memory:' })
    expect(pruneSpy).not.toHaveBeenCalled()
    expect(logs.join('\n')).toMatch(/prune skipped/)
  })

  it('prunes the bake scoped to the keys the registry owns — originals and derivatives', async () => {
    const rootDir = seedDb(tempRoot(), `
      CREATE TABLE media (id INTEGER PRIMARY KEY, storage_key TEXT NOT NULL, derivatives TEXT);
      INSERT INTO media (storage_key, derivatives) VALUES
        ('a/hero.webp', '{"w320":{"key":"a/hero-w320.webp"}}'),
        ('docs/spec.pdf', NULL);
    `)
    await generate(rootDir)
    expect(pruneSpy).toHaveBeenCalledTimes(1)
    expect(pruneSpy.mock.calls[0][0]).toBe(join(rootDir, '.output', 'public'))
    expect(pruneSpy.mock.calls[0][1]).toBe('/uploads')
    expect(pruneSpy.mock.calls[0][2]?.ownedKeys).toEqual(new Set(['a/hero.webp', 'a/hero-w320.webp', 'docs/spec.pdf']))
    expect(logs.join('\n')).not.toMatch(/prune skipped/)
  })

  it('reports without deleting when the dry-run env var is set', async () => {
    vi.stubEnv('KESTREL_OUTPUT_DRY_RUN', '1')
    await generate(seedDb(tempRoot(), `
      CREATE TABLE media (id INTEGER PRIMARY KEY, storage_key TEXT NOT NULL, derivatives TEXT);
      INSERT INTO media (storage_key, derivatives) VALUES ('a/hero.webp', NULL);
    `))
    expect(pruneSpy.mock.calls[0][2]).toMatchObject({ dryRun: true })
  })

  it('never prunes on a plain build (no static generate)', async () => {
    await generate(seedDb(tempRoot(), `
      CREATE TABLE media (id INTEGER PRIMARY KEY, storage_key TEXT NOT NULL, derivatives TEXT);
      INSERT INTO media (storage_key, derivatives) VALUES ('a/hero.webp', NULL);
    `), {}, false)
    expect(pruneSpy).not.toHaveBeenCalled()
    expect(logs.join('\n')).not.toMatch(/prune skipped/) // returns before the registry is read at all
  })

  it('registers nothing for the s3 media driver — only local bakes an uploads dir into the output', async () => {
    const hooks = await generate(seedDb(tempRoot(), `
      CREATE TABLE media (id INTEGER PRIMARY KEY, storage_key TEXT NOT NULL, derivatives TEXT);
      INSERT INTO media (storage_key, derivatives) VALUES ('a/hero.webp', NULL);
    `), { media: { driver: 's3' } })
    expect(hooks.get('compiled')).toBeUndefined()
    expect(pruneSpy).not.toHaveBeenCalled()
  })
})
