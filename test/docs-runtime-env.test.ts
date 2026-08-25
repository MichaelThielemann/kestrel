import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import kestrelModule from '../layers/core/modules/kestrel/index'

// Vitest runs from the package root.
const root = process.cwd()
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')
const configMd = read('docs/guide/configuration.md')
const deployMd = read('docs/guide/deploying.md')
const readme = read('README.md')
const envExample = read('.env.example')

/** Every hand-written doc page, so a future re-split cannot drop a page out of the NUXT_* check. */
function docPages(dir: string): string[] {
  return readdirSync(resolve(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`
    if (statSync(resolve(root, rel)).isDirectory()) return name === 'api' || name === 'superpowers' ? [] : docPages(rel)
    return name.endsWith('.md') ? [rel] : []
  })
}

/** The runtimeConfig the `kestrel` module freezes at setup — i.e. everything a prebuilt server reads. */
async function moduleRuntimeConfig(): Promise<Record<string, unknown>> {
  const nuxt = { options: { runtimeConfig: {} as Record<string, unknown>, rootDir: '/tmp/kestrel-docs-test', nitro: {} }, hook: () => {} }
  await (kestrelModule as unknown as (options: unknown, nuxt: unknown) => Promise<void>)({}, nuxt)
  return nuxt.options.runtimeConfig
}

/**
 * Nitro's runtimeConfig env-override naming: `NUXT_` + the key path, each camelCase segment split into
 * SCREAMING_SNAKE (`kestrel.dbPath` → `NUXT_KESTREL_DB_PATH`). Leaves only — those are the settable values.
 */
function envNames(node: unknown, prefix = 'NUXT'): string[] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [prefix]
  return Object.entries(node as Record<string, unknown>)
    .flatMap(([key, value]) => envNames(value, `${prefix}_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`))
}

/** The `## <heading>` section of a markdown doc, up to the next `## `. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}`)
  expect(start).toBeGreaterThan(-1)
  const rest = md.slice(start + 3)
  const end = rest.indexOf('\n## ')
  return end === -1 ? rest : rest.slice(0, end)
}

describe('docs — when the environment is actually read', () => {
  it('says the non-auth KESTREL_* vars are consumed at module setup, so a prebuilt server ignores them', () => {
    // Every non-auth setting is resolved once in the `kestrel` module and frozen into runtimeConfig, so
    // `KESTREL_DB=… node .output/server/index.mjs` silently keeps the build-time database. Docs that sell
    // KESTREL_* as a per-environment escape hatch send operators straight into that trap.
    const precedence = section(configMd, 'Precedence')
    expect(precedence).toMatch(/module setup/i)
    expect(precedence).toMatch(/prebuilt/i)
    expect(precedence).toMatch(/NUXT_KESTREL_DB_PATH/)
    expect(precedence).toMatch(/NUXT_MEDIA_S3_ACCESS_KEY_ID/)
  })

  it('names only NUXT_* vars that map onto a runtimeConfig key the module writes', async () => {
    const valid = new Set(envNames(await moduleRuntimeConfig()))
    const cited = [readme, envExample, ...docPages('docs').map(read)]
      .flatMap((md) => md.match(/\bNUXT_[A-Z0-9_]+/g) ?? [])
    expect(cited.length).toBeGreaterThan(0)
    expect([...new Set(cited)].filter((name) => !valid.has(name))).toEqual([])
  })

  it('describes the S3 credentials as read at build time, unconditionally', () => {
    const s3 = section(configMd, 'S3 credentials')
    // index.ts reads the keys at module setup whatever the driver is — not lazily "at driver construction",
    // and not "only when driver === 's3'". They must therefore be in the BUILD environment (and land in the
    // artifact), which is exactly what an operator needs to know before shipping .output/ somewhere.
    expect(s3).not.toMatch(/at driver construction/i)
    expect(s3).not.toMatch(/only when `?media\.driver/i)
    expect(s3).toMatch(/module setup/i)
    expect(s3).toMatch(/NUXT_MEDIA_S3_SECRET_ACCESS_KEY/)
  })

  it('points the prebuilt-server deploy paths at the runtime names', () => {
    expect(deployMd).toMatch(/\bNUXT_[A-Z0-9_]+/)
    expect(deployMd).toMatch(/NUXT_KESTREL_SITE_URL/)
    expect(envExample).toMatch(/\bNUXT_[A-Z0-9_]+/)
  })
})
