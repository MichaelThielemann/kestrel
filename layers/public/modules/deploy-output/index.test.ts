import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// The real deploy would talk to S3; stub only the shipping half so the module's gating stays real.
const { deploySpy } = vi.hoisted(() => ({
  deploySpy: vi.fn(async (_dir: string, _driver: unknown, _opts?: { incomplete?: string }) => ({ pruned: 0, keys: [] as string[] })),
}))
vi.mock('@michaelthielemann/kestrel-delivery-static', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@michaelthielemann/kestrel-delivery-static')>()),
  deployStaticOutput: deploySpy,
}))

import { deployStaticOutput } from '@michaelthielemann/kestrel-delivery-static'
import deployOutputModule from './index'
import prerenderRoutesModule from '../prerender-routes/index'

type CompiledHook = () => Promise<void>
type NitroHook = (payload?: unknown) => unknown
type NuxtModule = (inline: object, nuxt: unknown) => Promise<unknown>

const add = (m: Map<string, NitroHook[]>, name: string, fn: NitroHook): void => { m.set(name, [...(m.get(name) ?? []), fn]) }

/**
 * A stand-in for the ONE Nuxt instance every module is handed — the object the two modules pass the
 * route-discovery signal over — plus the hook registries, so a test can fire them in nitro's real order
 * (`nitro:config` → `nitro:init` → `prerender:done` → `compiled`).
 */
function fakeNuxt(kestrel: Record<string, unknown>, rootDir = '/tmp/kestrel-deploy-output-test'): {
  nuxt: object
  nuxtHooks: Map<string, NitroHook[]>
  nitroHooks: Map<string, NitroHook[]>
  initNitro: (isStaticGenerate?: boolean) => void
} {
  const nuxtHooks = new Map<string, NitroHook[]>()
  const nitroHooks = new Map<string, NitroHook[]>()
  const nuxt = { options: { kestrel, rootDir }, hook: (name: string, fn: NitroHook) => add(nuxtHooks, name, fn) }
  const initNitro = (isStaticGenerate = true): void => {
    const nitro = {
      options: { static: isStaticGenerate, output: { publicDir: `${rootDir}/.output/public` } },
      hooks: { hook: (name: string, fn: NitroHook) => add(nitroHooks, name, fn) },
    }
    for (const fn of nuxtHooks.get('nitro:init') ?? []) fn(nitro)
  }
  return { nuxt, nuxtHooks, nitroHooks, initNitro }
}

/** Run the deploy module alone against a fake Nuxt/Nitro; returns the nitro hooks it registered, by name. */
async function runModule(kestrel: Record<string, unknown>, isStaticGenerate = true): Promise<Map<string, NitroHook[]>> {
  const ctx = fakeNuxt(kestrel)
  await (deployOutputModule as unknown as NuxtModule)({}, ctx.nuxt)
  ctx.initNitro(isStaticGenerate)
  return ctx.nitroHooks
}

/** The module's `compiled` hooks — nitro runs prerendering before this, so it sees the finished tree. */
const compiledHooks = (hooks: Map<string, NitroHook[]>): CompiledHook[] => (hooks.get('compiled') ?? []) as CompiledHook[]

describe('kestrel-deploy-output module', () => {
  let logs: string[]
  beforeEach(() => {
    // Guards against the `vi.mock('@michaelthielemann/kestrel-delivery-static', ...)` specifier above silently going dark
    // (e.g. drifting back to a relative path that no longer resolves to the real import): if this ever
    // stops being the spy, every test below runs the REAL deployStaticOutput unmocked against a fake
    // rootDir instead of catching the gating logic this suite exists to test — fail loudly here instead.
    expect(vi.isMockFunction(deployStaticOutput), '@michaelthielemann/kestrel-delivery-static\'s deployStaticOutput is not mocked — the vi.mock specifier above no longer intercepts the real import').toBe(true)
    logs = []
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)) })
    deploySpy.mockClear()
    vi.stubEnv('KESTREL_S3_ACCESS_KEY_ID', 'a')
    vi.stubEnv('KESTREL_S3_SECRET_ACCESS_KEY', 'b')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('does NOT ship the generated tree when output.auto is on (default) — the server owns that bucket', async () => {
    const [compiled] = compiledHooks(await runModule({ output: { driver: 's3', s3: { bucket: 'b', prefix: 'site' } } }))
    await compiled()
    expect(deploySpy).not.toHaveBeenCalled()
    expect(logs.join('\n')).toMatch(/output\.auto/)
  })

  it('ships it for the build-time model (output.auto off)', async () => {
    const [compiled] = compiledHooks(await runModule({ output: { driver: 's3', auto: false, s3: { bucket: 'b', prefix: 'site' } } }))
    await compiled()
    expect(deploySpy).toHaveBeenCalledTimes(1)
  })

  it('refuses the deploy when the s3 media driver comes from the env only (env wins over config)', async () => {
    vi.stubEnv('KESTREL_MEDIA_DRIVER', 's3')
    const [compiled] = compiledHooks(await runModule({
      media: { driver: 'local', s3: { bucket: 'assets', prefix: 'site/uploads' } },
      output: { driver: 's3', auto: false, s3: { bucket: 'assets', prefix: 'site' } },
    }))
    await expect(compiled()).rejects.toThrow(/delete live media/i)
    expect(deploySpy).not.toHaveBeenCalled()
  })

  it('never deploys on a plain build (no static generate)', async () => {
    const [compiled] = compiledHooks(await runModule({ output: { driver: 's3', auto: false, s3: { bucket: 'b', prefix: 'site' } } }, false))
    await compiled()
    expect(deploySpy).not.toHaveBeenCalled()
  })

  it('marks the deploy incomplete when nitro reports routes that failed to prerender (no prune on a half-built site)', async () => {
    const hooks = await runModule({ output: { driver: 's3', auto: false, s3: { bucket: 'b', prefix: 'site' } } })
    // Nitro's real order: prerender (→ `prerender:done`) runs to completion, THEN the build's `compiled`.
    for (const fn of hooks.get('prerender:done') ?? []) {
      await fn({ prerenderedRoutes: [{ route: '/' }], failedRoutes: [{ route: '/about' }, { route: '/blog/a' }] })
    }
    await compiledHooks(hooks)[0]()
    expect(deploySpy).toHaveBeenCalledTimes(1)
    expect(deploySpy.mock.calls[0][2]).toMatchObject({ incomplete: expect.stringMatching(/2 .*prerender/) })
  })

  it('leaves the deploy complete (prune armed) when every route prerendered', async () => {
    const hooks = await runModule({ output: { driver: 's3', auto: false, s3: { bucket: 'b', prefix: 'site' } } })
    for (const fn of hooks.get('prerender:done') ?? []) {
      await fn({ prerenderedRoutes: [{ route: '/' }, { route: '/about' }], failedRoutes: [] })
    }
    await compiledHooks(hooks)[0]()
    expect(deploySpy.mock.calls[0][2]).toMatchObject({ incomplete: undefined })
  })
})

// Both real modules on one shared Nuxt instance: the signal has to survive the trip between them, and
// neither can see the other's module scope in a real build.
describe('prerender + deploy modules together', () => {
  const s3 = { output: { driver: 's3', auto: false, s3: { bucket: 'b', prefix: 'site' } } }

  beforeEach(() => {
    expect(vi.isMockFunction(deployStaticOutput), '@michaelthielemann/kestrel-delivery-static\'s deployStaticOutput is not mocked — the vi.mock specifier above no longer intercepts the real import').toBe(true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    deploySpy.mockClear()
    vi.stubEnv('KESTREL_S3_ACCESS_KEY_ID', 'a')
    vi.stubEnv('KESTREL_S3_SECRET_ACCESS_KEY', 'b')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /** Set both modules up on one nuxt, then drive nitro's real hook order. `rootDir` decides whether the
   *  build-time DB (`<rootDir>/.data/db.sqlite`) exists, which is what route discovery reports on. */
  async function generate(rootDir: string): Promise<void> {
    const ctx = fakeNuxt(s3, rootDir)
    await (prerenderRoutesModule as unknown as NuxtModule)({}, ctx.nuxt)
    await (deployOutputModule as unknown as NuxtModule)({}, ctx.nuxt)
    for (const fn of ctx.nuxtHooks.get('nitro:config') ?? []) fn({})
    ctx.initNitro(true)
    for (const fn of ctx.nitroHooks.get('prerender:done') ?? []) await fn({ prerenderedRoutes: [{ route: '/' }], failedRoutes: [] })
    await (ctx.nitroHooks.get('compiled') ?? [])[0]()
  }

  it('marks the deploy incomplete when route discovery could not enumerate the pages (no DB yet)', async () => {
    await generate(mkdtempSync(join(tmpdir(), 'kestrel-generate-')))
    expect(deploySpy).toHaveBeenCalledTimes(1)
    expect(deploySpy.mock.calls[0][2]?.incomplete).toMatch(/no database/i)
  })

  it('arms the prune when route discovery read the DB — however few pages it found', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'kestrel-generate-'))
    mkdirSync(join(rootDir, '.data'))
    const db = new Database(join(rootDir, '.data', 'db.sqlite'))
    db.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, locale TEXT NOT NULL, path TEXT, status TEXT NOT NULL DEFAULT 'draft')`)
    db.exec(`CREATE UNIQUE INDEX pages_path_locale ON pages (path, locale) WHERE path is not null`)
    db.exec(`INSERT INTO pages (locale, path, status) VALUES ('en','/only','published')`)
    db.close()
    await generate(rootDir)
    expect(deploySpy).toHaveBeenCalledTimes(1)
    expect(deploySpy.mock.calls[0][2]?.incomplete).toBeUndefined()
  })
})
