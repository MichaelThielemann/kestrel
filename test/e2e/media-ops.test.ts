import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, mkdtempSync } from 'node:fs'
import { describe, it, beforeAll, afterAll } from 'vitest'
import { setup, fetch as testFetch, createPage, url } from '@nuxt/test-utils/e2e'
import sharp from 'sharp'
import { hashPassword } from '@michaelthielemann/kestrel-auth'
import { e2eBrowserOptions } from '../helpers/e2e-browser'

const dbPath = join(tmpdir(), `kestrel-media-ops-e2e-${process.pid}.sqlite`)
const uploads = mkdtempSync(join(tmpdir(), 'kestrel-media-ops-up-'))
const PW = 'media-ops-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_MEDIA_LOCAL_DIR = uploads
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('media right-click delete (e2e, browser)', async () => {
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

  it('uploads a file, right-clicks it, and deletes it via the context menu + confirm dialog', async () => {
    const name = cookie.slice(0, cookie.indexOf('='))
    const value = cookie.slice(cookie.indexOf('=') + 1)
    const page = await createPage()
    await page.context().addCookies([{ name, value, url: url('/') }])
    await page.goto(url('/admin/media'))

    await page.getByRole('button', { name: 'New folder' }).waitFor()

    const png = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 1 } },
    }).png().toBuffer()
    const fileInput = page.locator('input[type=file]')
    await fileInput.setInputFiles({ name: 'to-delete.png', mimeType: 'image/png', buffer: png })

    await page.getByText('to-delete.png').waitFor()

    const fileTile = page.locator('[data-test^="file-"]', { hasText: 'to-delete.png' })

    await fileTile.click({ button: 'right' })

    // The context menu renders into a portal; scope to [role="menuitem"] to avoid
    // colliding with the dialog's "Delete" button that doesn't exist yet.
    const deleteMenuItem = page.locator('[role="menuitem"]', { hasText: 'Delete' })
    await deleteMenuItem.waitFor()
    await deleteMenuItem.click()

    // MediaDeleteDialog appears — scope the confirm button to [role="dialog"] so
    // it doesn't collide with the now-closed menu item.
    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor()

    const confirmBtn = dialog.getByRole('button', { name: 'Delete', exact: true })
    await confirmBtn.waitFor()
    await confirmBtn.click()

    await dialog.waitFor({ state: 'detached' })
    await fileTile.waitFor({ state: 'detached' })
  })

  it('uploads a file, right-clicks it, and renames it via the context menu + rename dialog', async () => {
    const name = cookie.slice(0, cookie.indexOf('='))
    const value = cookie.slice(cookie.indexOf('=') + 1)
    const page = await createPage()
    await page.context().addCookies([{ name, value, url: url('/') }])
    await page.goto(url('/admin/media'))

    await page.getByRole('button', { name: 'New folder' }).waitFor()

    const png = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 50, g: 100, b: 200, alpha: 1 } },
    }).png().toBuffer()
    const fileInput = page.locator('input[type=file]')
    await fileInput.setInputFiles({ name: 'to-rename.png', mimeType: 'image/png', buffer: png })

    await page.getByText('to-rename.png').waitFor()

    const fileTile = page.locator('[data-test^="file-"]', { hasText: 'to-rename.png' })

    await fileTile.click({ button: 'right' })

    // The context menu renders into a portal; scope to [role="menuitem"] to avoid
    // colliding with the dialog's "Rename" button that doesn't exist yet.
    const renameMenuItem = page.locator('[role="menuitem"]', { hasText: 'Rename' })
    await renameMenuItem.waitFor()
    await renameMenuItem.click()

    // MediaRenameDialog appears — scope all interactions to [role="dialog"] so
    // the "Rename" button here doesn't collide with the now-closed menu item.
    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor()

    const nameInput = dialog.locator('input[type=text],input:not([type])')
    await nameInput.waitFor()
    await nameInput.clear()
    await nameInput.fill('renamed.png')

    const confirmBtn = dialog.getByRole('button', { name: 'Rename', exact: true })
    await confirmBtn.waitFor()
    await confirmBtn.click()

    await dialog.waitFor({ state: 'detached' })
    await page.getByText('renamed.png').waitFor()
    await fileTile.waitFor({ state: 'detached' })
  })

  it('cut a file at root, navigate into a folder, paste → file moves into the folder', async () => {
    const name = cookie.slice(0, cookie.indexOf('='))
    const value = cookie.slice(cookie.indexOf('=') + 1)
    const page = await createPage()
    await page.context().addCookies([{ name, value, url: url('/') }])
    await page.goto(url('/admin/media'))

    await page.getByRole('button', { name: 'New folder' }).waitFor()

    const png = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 255, g: 0, b: 128, alpha: 1 } },
    }).png().toBuffer()
    const fileInput = page.locator('input[type=file]')
    await fileInput.setInputFiles({ name: 'to-cut.png', mimeType: 'image/png', buffer: png })
    await page.getByText('to-cut.png').waitFor()

    await page.getByRole('button', { name: 'New folder' }).click()
    const folderDialog = page.locator('[role="dialog"]')
    await folderDialog.waitFor()
    const folderNameInput = folderDialog.locator('input[type=text],input:not([type])')
    await folderNameInput.waitFor()
    await folderNameInput.fill('cut-dest')
    const createBtn = folderDialog.getByRole('button', { name: /create/i })
    await createBtn.waitFor()
    await createBtn.click()
    await folderDialog.waitFor({ state: 'detached' })
    await page.locator('[data-test^="folder-"]', { hasText: 'cut-dest' }).waitFor()

    const fileTile = page.locator('[data-test^="file-"]', { hasText: 'to-cut.png' })
    await fileTile.click({ button: 'right' })
    const cutMenuItem = page.locator('[role="menuitem"]', { hasText: 'Cut' })
    await cutMenuItem.waitFor()
    await cutMenuItem.click()

    const folderTile = page.locator('[data-test^="folder-"]', { hasText: 'cut-dest' })
    await folderTile.click()

    await page.waitForFunction(() => window.location.href.includes('cut-dest'))

    const itemsGrid = page.locator('.media-library__items')
    await itemsGrid.waitFor()
    await itemsGrid.click({ button: 'right', position: { x: 10, y: 10 } })

    const pasteMenuItem = page.locator('[role="menuitem"]', { hasText: 'Paste' })
    await pasteMenuItem.waitFor()
    await pasteMenuItem.click()

    await page.locator('[data-test^="file-"]', { hasText: 'to-cut.png' }).waitFor()

    await page.goto(url('/admin/media'))
    await page.getByRole('button', { name: 'New folder' }).waitFor()
    await page.locator('[data-test^="file-"]', { hasText: 'to-cut.png' }).waitFor({ state: 'detached' })
  })

  it('copy a file, paste into the folder it already lives in → conflict dialog → Replace', async () => {
    const name = cookie.slice(0, cookie.indexOf('='))
    const value = cookie.slice(cookie.indexOf('=') + 1)
    const page = await createPage()
    await page.context().addCookies([{ name, value, url: url('/') }])
    await page.goto(url('/admin/media'))
    await page.getByRole('button', { name: 'New folder' }).waitFor()

    const png = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 200, b: 80, alpha: 1 } },
    }).png().toBuffer()
    await page.locator('input[type=file]').setInputFiles({ name: 'to-copy.png', mimeType: 'image/png', buffer: png })
    await page.getByText('to-copy.png').waitFor()

    await page.locator('[data-test^="file-"]', { hasText: 'to-copy.png' }).click({ button: 'right' })
    const copyItem = page.locator('[role="menuitem"]', { hasText: 'Copy' })
    await copyItem.waitFor()
    await copyItem.click()

    // The clipboard indicator's "Paste here" pastes into the current (root) folder, where
    // to-copy.png already exists → a conflict. No navigation, so the singleton clipboard is safe.
    const pasteHere = page.getByRole('button', { name: 'Paste here' })
    await pasteHere.waitFor()
    await pasteHere.click()

    const conflictDialog = page.locator('[role="dialog"]')
    await conflictDialog.waitFor()
    await conflictDialog.getByText('already exists').waitFor()
    await conflictDialog.getByRole('button', { name: /^replace$/i }).click()
    await conflictDialog.waitFor({ state: 'detached' })

    await page.locator('[data-test^="file-"]', { hasText: 'to-copy.png' }).waitFor()
  })

  it('drag a file tile onto a folder tile → file moves into the folder', async () => {
    const name = cookie.slice(0, cookie.indexOf('='))
    const value = cookie.slice(cookie.indexOf('=') + 1)
    const page = await createPage()
    await page.context().addCookies([{ name, value, url: url('/') }])
    await page.goto(url('/admin/media'))

    await page.getByRole('button', { name: 'New folder' }).waitFor()

    await page.getByRole('button', { name: 'New folder' }).click()
    const folderDialog = page.locator('[role="dialog"]')
    await folderDialog.waitFor()
    const folderNameInput = folderDialog.locator('input[type=text],input:not([type])')
    await folderNameInput.waitFor()
    await folderNameInput.fill('drag-dest')
    const createBtn = folderDialog.getByRole('button', { name: /create/i })
    await createBtn.waitFor()
    await createBtn.click()
    await folderDialog.waitFor({ state: 'detached' })
    await page.locator('[data-test^="folder-"]', { hasText: 'drag-dest' }).waitFor()

    const png = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 100, g: 150, b: 200, alpha: 1 } },
    }).png().toBuffer()
    const fileInput = page.locator('input[type=file]')
    await fileInput.setInputFiles({ name: 'to-drag.png', mimeType: 'image/png', buffer: png })
    await page.getByText('to-drag.png').waitFor()

    const fileTile = page.locator('[data-test^="file-"]', { hasText: 'to-drag.png' })
    const folderTile = page.locator('[data-test^="folder-"]', { hasText: 'drag-dest' })

    // NOTE: Playwright dragTo fires HTML5 dragstart/dragover/drop via synthetic mouse events
    // and sets the dataTransfer MIME marker ('application/x-kestrel-media') only if the
    // dragstart handler calls e.dataTransfer.setData before the event resolves. Native HTML5
    // DnD is notoriously unreliable in Playwright/Chromium headless — if this test is flaky
    // in CI a CDP-level dispatchEvent approach (manually firing dragstart with a real
    // DataTransfer and then drop) may be needed as a fallback.
    await fileTile.dragTo(folderTile)

    await folderTile.click()
    await page.waitForFunction(() => window.location.href.includes('drag-dest'))

    await page.locator('[data-test^="file-"]', { hasText: 'to-drag.png' }).waitFor()

    await page.goto(url('/admin/media'))
    await page.getByRole('button', { name: 'New folder' }).waitFor()
    await page.locator('[data-test^="file-"]', { hasText: 'to-drag.png' }).waitFor({ state: 'detached' })
  })
})
