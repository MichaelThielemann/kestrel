import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, mkdtempSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch as testFetch, createPage, url } from '@nuxt/test-utils/e2e'
import sharp from 'sharp'
import { hashPassword } from '../../layers/auth/server/utils/password'
import { e2eBrowserOptions } from '../helpers/e2e-browser'

const dbPath = join(tmpdir(), `kestrel-media-lib-e2e-${process.pid}.sqlite`)
const uploads = mkdtempSync(join(tmpdir(), 'kestrel-media-lib-up-'))
const PW = 'media-lib-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_MEDIA_LOCAL_DIR = uploads
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('media library browse (e2e, browser)', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('../../', import.meta.url)),
    dev: true,
    browser: true,
    browserOptions: e2eBrowserOptions,
  })

  let cookie = ''
  let fileId = 0
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

    const png = await sharp({
      create: { width: 64, height: 48, channels: 4, background: { r: 5, g: 6, b: 7, alpha: 1 } },
    }).png().toBuffer()
    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), 'demo.png')
    form.append('folder', 'lib-demo')

    const created = await $fetch('/api/media', {
      method: 'POST',
      headers: { cookie },
      body: form,
    }) as { id: number }
    fileId = created.id
  })

  afterAll(() => {
    for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s) } catch {} }
    try { rmSync(uploads, { recursive: true, force: true }) } catch {}
  })

  it('browses the library: shows the folder, navigates in, shows the file', async () => {
    // Inject the admin session cookie into the browser context so the client
    // gate passes without driving the login form.
    const name = cookie.slice(0, cookie.indexOf('='))
    const value = cookie.slice(cookie.indexOf('=') + 1)
    const page = await createPage()
    await page.context().addCookies([{ name, value, url: url('/') }])
    await page.goto(url('/admin/media'))

    // the root listing renders the uploaded folder (default view is grid)
    const folderTile = page.locator('[data-test="folder-lib-demo"]')
    await folderTile.getByText('lib-demo').waitFor()

    // navigating into the folder (URL-driven) reveals the uploaded file
    await folderTile.click()
    await page.waitForURL(/folder=lib-demo/)
    const fileTile = page.locator(`[data-test="file-${fileId}"]`)
    await fileTile.getByText('demo.png').waitFor()
  })

  it('redirects an unauthenticated visit to the login page', async () => {
    const page = await createPage('/admin/media')
    await page.waitForURL(/\/admin\/login/)
    expect(new URL(page.url()).pathname).toBe('/admin/login')
  })

  it('resolve endpoint returns the uploaded file by id and skips missing ids', async () => {
    const res = await testFetch(`/api/media/resolve?ids=${fileId}`, {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { id: number; src: string }[] }
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(fileId)
    expect(body.data[0].src).toBeTruthy()

    const res2 = await testFetch(`/api/media/resolve?ids=${fileId},999999`, {
      headers: { cookie },
    })
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as { data: { id: number }[] }
    expect(body2.data).toHaveLength(1)
    expect(body2.data[0].id).toBe(fileId)
  })
})
