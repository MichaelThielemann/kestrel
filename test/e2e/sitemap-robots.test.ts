import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch as testFetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '../../layers/auth/server/utils/password'

const dbPath = join(tmpdir(), `kestrel-sitemap-e2e-${process.pid}.sqlite`)
const PW = 'sitemap-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_SITE_URL = 'https://example.test'
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('sitemap.xml + robots.txt routes (e2e)', async () => {
  await setup({ rootDir: fileURLToPath(new URL('../../', import.meta.url)), dev: true })

  beforeAll(async () => {
    const res = await testFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    })
    const set = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean) as string[]
    const cookie = set.map((c) => c.split(';')[0]).join('; ')

    await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'About', path: '/about', status: 'published' } })
    await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Über uns', path: '/ueber-uns', locale: 'de', status: 'published' } })
    await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Secret', path: '/secret', status: 'draft' } })
    await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Hidden', path: '/hidden', status: 'published', seo: { noindex: true } } })
  })

  afterAll(() => {
    for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s) } catch {} }
  })

  it('serves a public sitemap of published, indexable pages with absolute, locale-aware URLs', async () => {
    const xml = await $fetch('/sitemap.xml') as string // public: no cookie
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<loc>https://example.test/about</loc>')
    expect(xml).toContain('<loc>https://example.test/de/ueber-uns</loc>')
    expect(xml).toContain('<lastmod>')
    expect(xml).not.toContain('/secret') // draft excluded
    expect(xml).not.toContain('/hidden') // noindex excluded
  })

  it('serves robots.txt allowing all and pointing at the sitemap', async () => {
    const txt = await $fetch('/robots.txt') as string
    expect(txt).toContain('User-agent: *')
    expect(txt).toContain('Allow: /')
    expect(txt).toContain('Sitemap: https://example.test/sitemap.xml')
  })
})
