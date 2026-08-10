import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, mkdtempSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch as testFetch } from '@nuxt/test-utils/e2e'
import sharp from 'sharp'
import { hashPassword } from '../../layers/auth/server/utils/password'

const dbPath = join(tmpdir(), `kestrel-render-e2e-${process.pid}.sqlite`)
const uploads = mkdtempSync(join(tmpdir(), 'kestrel-render-up-'))
const PW = 'render-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_MEDIA_LOCAL_DIR = uploads
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('public rendering (e2e)', async () => {
  await setup({ rootDir: fileURLToPath(new URL('../../', import.meta.url)), dev: true })

  let cookie = ''
  beforeAll(async () => {
    const res = await testFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    })
    const set = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean) as string[]
    cookie = set.map((c) => c.split(';')[0]).join('; ')

    const png = await sharp({ create: { width: 320, height: 200, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } } }).png().toBuffer()
    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), 'hero.png')
    const media = await $fetch('/api/media', { method: 'POST', headers: { cookie }, body: form }) as { id: number }

    await $fetch('/api/pages', {
      method: 'POST', headers: { cookie },
      body: { title: 'Home', path: '/', status: 'published', content: [{ id: 'h', type: 'hero', props: { heading: 'Welcome home', image: media.id } }] },
    })
    await $fetch('/api/pages', {
      method: 'POST', headers: { cookie },
      body: { title: 'Hallo', path: '/willkommen', locale: 'de', status: 'published', content: [{ id: 'p', type: 'prose', props: { body: '<p>Servus</p>' } }] },
    })
    await $fetch('/api/pages', {
      method: 'POST', headers: { cookie },
      body: { title: 'Secret', path: '/secret', status: 'draft' },
    })
  })

  afterAll(() => {
    for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s) } catch {} }
    try { rmSync(uploads, { recursive: true, force: true }) } catch {}
  })

  it('renders a page in the layout it selects, and the default when it selects none', async () => {
    // `app/layouts/alt.vue` marks itself with data-layout; the default layout does not. Exactly one <main>
    // per page also proves `layout: false` stopped the route-meta layout from wrapping it a second time.
    await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Alt', path: '/alt-layout', status: 'published', layout: 'alt' } })
    await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Plain', path: '/plain-layout', status: 'published' } })

    const alt = await $fetch('/alt-layout') as string
    expect(alt).toContain('data-layout="alt"')
    expect(alt.match(/<main/g)?.length).toBe(1)

    const plain = await $fetch('/plain-layout') as string
    expect(plain).not.toContain('data-layout=')
    expect(plain.match(/<main/g)?.length).toBe(1)
  })

  it('still renders a page whose selected layout no longer exists', async () => {
    // The column is deliberately not an enum, so a consumer deleting a layout file must degrade to the
    // default rather than blank the page — that is what NuxtLayout's `fallback` is for.
    await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Gone', path: '/gone-layout', status: 'published', layout: 'deleted-layout' } })
    const html = await $fetch('/gone-layout') as string
    expect(html).toContain('<main>')
    expect(html).toContain('Gone')
  })

  it('renders a published page with its hero block and resolved media', async () => {
    const html = await $fetch('/') as string
    expect(html).toContain('Welcome home')
    expect(html).toMatch(/<img[^>]+src="\/uploads\//)
  })

  it('resolves a de page under the /de prefix', async () => {
    const html = await $fetch('/de/willkommen') as string
    expect(html).toContain('Servus')
  })

  it('404s a draft (unpublished) path', async () => {
    await expect($fetch('/secret')).rejects.toMatchObject({ statusCode: 404 })
  })

  // ---- editor live-preview mode (?kestrel-preview=1 + the dedicated fallback page) ----

  it('serves the plain page (no marker chrome) to an anonymous visitor with the preview flag', async () => {
    const html = await $fetch('/?kestrel-preview=1') as string
    expect(html).toContain('Welcome home')
    expect(html).not.toContain('block-edit-marker')
  })

  it('activates the preview bridge (selection markers) for the admin session', async () => {
    const res = await testFetch('/?kestrel-preview=1', { headers: { cookie } })
    const html = await res.text()
    expect(html).toContain('Welcome home')
    expect(html).toContain('block-edit-marker')
    expect(html).toContain('data-block-id="h"')
  })

  it('404s the dedicated preview page for anonymous visitors', async () => {
    await expect($fetch('/__kestrel/preview')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('renders the dedicated preview page (noindex) for the admin session', async () => {
    const res = await testFetch('/__kestrel/preview?kestrel-preview=1&locale=de', { headers: { cookie } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('noindex')
    expect(html).toContain('lang="de"')
  })
})
