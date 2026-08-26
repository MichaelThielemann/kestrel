import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '@michaelthielemann/kestrel-auth'

const dbPath = join(tmpdir(), `kestrel-e2e-collections-${process.pid}.sqlite`)
const PW = 'e2e-test-password'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('Collections definitions API (e2e)', async () => {
  await setup({ rootDir: fileURLToPath(new URL('../../', import.meta.url)), dev: true })

  let cookie = ''
  beforeAll(async () => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    })
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean) as string[]
    cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
    expect(cookie).toContain('kestrel_session')
  })

  afterAll(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(dbPath + suffix) } catch {}
    }
  })

  it('lists collection definitions for an admin', async () => {
    const res = await $fetch('/api/collections', { headers: { cookie } })
    expect(Array.isArray(res.data)).toBe(true)
    const names = res.data.map((c: { name: string }) => c.name)
    expect(names).toContain('pages')
    const pages = res.data.find((c: { name: string }) => c.name === 'pages')
    expect(pages).toMatchObject({ mode: 'multi', translatable: true })
    expect(pages.fields).toBeTypeOf('object')
    expect(JSON.stringify(pages)).not.toMatch(/validator|sanitize|column/i)
  })

  it('returns one definition by name', async () => {
    const pages = await $fetch('/api/pages/schema', { headers: { cookie } })
    expect(pages).toMatchObject({ name: 'pages', mode: 'multi' })
    expect(pages.fields.title).toMatchObject({ type: 'text' })
  })

  it('404s an unknown collection name', async () => {
    await expect($fetch('/api/nope/schema', { headers: { cookie } }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('denies anonymous access (default-deny: collections not in the anon grant)', async () => {
    await expect($fetch('/api/collections')).rejects.toMatchObject({ statusCode: 401 })
    await expect($fetch('/api/pages/schema')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('lists block definitions for an admin (fields shaped like collection fields)', async () => {
    const res = await $fetch('/api/blocks', { headers: { cookie } })
    const names = res.data.map((b: { name: string }) => b.name)
    expect(names).toContain('hero')
    expect(names).toContain('prose')
    const hero = res.data.find((b: { name: string }) => b.name === 'hero')
    expect(hero.fields.heading).toMatchObject({ type: 'text', required: true })
    expect(hero.fields.image).toMatchObject({ type: 'media' })
    expect(JSON.stringify(res)).not.toMatch(/validator|sanitize|column/i)
  })

  it('filters blocks by ?allowed=', async () => {
    const res = await $fetch('/api/blocks', { query: { allowed: 'prose' }, headers: { cookie } })
    expect(res.data.map((b: { name: string }) => b.name)).toEqual(['prose'])
  })

  it('denies anonymous access to block definitions', async () => {
    await expect($fetch('/api/blocks')).rejects.toMatchObject({ statusCode: 401 })
  })
})
