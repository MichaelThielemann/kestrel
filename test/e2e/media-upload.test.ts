import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, mkdtempSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, fetch as testFetch, createPage, url } from '@nuxt/test-utils/e2e'
import sharp from 'sharp'
import { hashPassword } from '@kestrel/auth'
import { e2eBrowserOptions } from '../helpers/e2e-browser'

const dbPath = join(tmpdir(), `kestrel-media-upload-e2e-${process.pid}.sqlite`)
const uploads = mkdtempSync(join(tmpdir(), 'kestrel-media-upload-up-'))
const PW = 'media-upload-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_MEDIA_LOCAL_DIR = uploads
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('media upload + new-folder + collision (e2e, browser)', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('../../', import.meta.url)),
    dev: true,
    browser: true,
    browserOptions: e2eBrowserOptions,
  })

  let cookie = ''
  beforeAll(async () => {
    const res = await testFetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    })
    const set = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean) as string[]
    cookie = set.map((c) => c.split(';')[0]).join('; ')
  })

  afterAll(() => {
    for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s) } catch {} }
    try { rmSync(uploads, { recursive: true, force: true }) } catch {}
  })

  it('creates a folder, uploads a file, and resolves a collision by overwriting', async () => {
    // Inject the admin session cookie so the client gate passes without the login form.
    const name = cookie.slice(0, cookie.indexOf('='))
    const value = cookie.slice(cookie.indexOf('=') + 1)
    const page = await createPage()
    await page.context().addCookies([{ name, value, url: url('/') }])
    await page.goto(url('/admin/media'))

    const newFolderBtn = page.getByRole('button', { name: 'New folder' })
    await newFolderBtn.waitFor()

    await newFolderBtn.click()
    const folderName = page.getByPlaceholder('e.g. holiday')
    await folderName.waitFor()
    await folderName.fill('up-demo')
    await page.getByRole('button', { name: 'Create' }).click()

    const folderTile = page.locator('[data-test="folder-up-demo"]')
    await folderTile.getByText('up-demo').waitFor()

    const png = await sharp({
      create: { width: 32, height: 24, channels: 4, background: { r: 11, g: 22, b: 33, alpha: 1 } },
    }).png().toBuffer()
    const fileInput = page.locator('input[type=file]')
    await fileInput.setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png })

    await page.getByText('shot.png').waitFor()

    await fileInput.setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png })

    const dialogTitle = page.getByText('Resolve upload conflicts')
    await dialogTitle.waitFor()

    // The per-row "Overwrite" button (scoped to the conflict row, not "Overwrite all").
    const row = page.locator('.media-conflicts__row', { hasText: 'shot.png' })
    await row.getByRole('button', { name: 'Overwrite', exact: true }).click()

    await dialogTitle.waitFor({ state: 'hidden' })

    const tiles = page.getByText('shot.png')
    await expect.poll(() => tiles.count()).toBe(1)
  })
})
