import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch as testFetch, createPage, url } from '@nuxt/test-utils/e2e'
import { hashPassword } from '../../layers/auth/server/utils/password'

const dbPath = join(tmpdir(), `kestrel-admin-editor-e2e-${process.pid}.sqlite`)
const PW = 'admin-editor-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)
// Pid-scoped epoch file: the default lands NEXT TO the DB, i.e. a SHARED tmpdir file that suites
// would leak into each other (and leave behind). Same isolation idea as the pid-scoped DB.
process.env.KESTREL_SESSION_EPOCH_FILE = `${dbPath}.epoch`

// CI ships a Playwright-managed browser; locally pass a system binary via the env var.
const launch = process.env.KESTREL_E2E_BROWSER_PATH ? { executablePath: process.env.KESTREL_E2E_BROWSER_PATH } : {}

describe('admin record editor (e2e, browser)', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('../../', import.meta.url)),
    dev: true,
    browser: true,
    browserOptions: { type: 'chromium', launch },
  })

  let cookie = ''
  let postId = 0
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

    const created = await $fetch('/api/posts', {
      method: 'POST',
      headers: { cookie },
      body: { title: 'Seed Post', body: '<p>seeded</p>' },
    }) as { id: number }
    postId = created.id
  })

  afterAll(() => {
    for (const s of ['', '-wal', '-shm', '.epoch']) { try { rmSync(dbPath + s) } catch {} }
  })

  async function authedPage(path: string) {
    const name = cookie.slice(0, cookie.indexOf('='))
    const value = cookie.slice(cookie.indexOf('=') + 1)
    const page = await createPage()
    await page.context().addCookies([{ name, value, url: url('/') }])
    page.on('dialog', (d) => d.accept())
    await page.goto(url(path))
    return page
  }

  const onList = (u: string) => new URL(u).pathname === '/admin/posts'

  it('opens an existing record with the form populated', async () => {
    const page = await authedPage(`/admin/posts/${postId}`)
    await page.getByLabel('title').waitFor()
    await expect.poll(async () => page.getByLabel('title').inputValue()).toBe('Seed Post')
  })

  it('renders a blank create form for the "new" sentinel', async () => {
    const page = await authedPage('/admin/posts/new')
    await page.getByLabel('title').waitFor()
    await expect.poll(async () => page.getByLabel('title').inputValue()).toBe('')
    // `exact`: an accessible name matches by SUBSTRING and case-insensitively, so a bare 'Save' also
    // hits the preview button's "Preview unsaved changes in a new tab".
    await page.getByRole('button', { name: 'Save', exact: true }).waitFor()
  })

  it('drives the full create -> list -> edit -> delete loop through the UI', async () => {
    const page = await authedPage('/admin/posts/new')

    // create — a brand-new record saves into its OWN editor URL (not back to the list); the
    // post-save navigation to /admin/posts/<id> only happens once the create succeeds.
    await page.getByLabel('title').fill('Loop Alpha')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForURL(/\/admin\/posts\/\d+/)

    // the list shows the new row
    await page.goto(url('/admin/posts'))
    await page.getByText('Loop Alpha').waitFor()

    // edit — open via the row's Edit quick-action; change the title and save (stays in its editor)
    await page.getByRole('link', { name: 'Edit Loop Alpha' }).click()
    await page.waitForURL(/\/admin\/posts\/\d+/)
    await expect.poll(async () => page.getByLabel('title').inputValue()).toBe('Loop Alpha')
    await page.getByLabel('title').fill('Loop Beta')
    // wait for the save to round-trip (the toast text "Saved" collides with the editor-status ampel label)
    const savedEdit = page.waitForResponse((r) => /\/api\/posts\/\d+/.test(r.url()) && r.request().method() === 'PATCH')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await savedEdit
    await page.goto(url('/admin/posts'))
    await page.getByText('Loop Beta').waitFor()

    // delete — the editor's Delete opens the shared confirm dialog; confirming returns to the list.
    // `exact` matters: the list's row actions are labelled "Delete <row>", so a substring match would
    // also hit those while the list is still mounted mid-transition.
    await page.getByRole('link', { name: 'Edit Loop Beta' }).click()
    await page.waitForURL(/\/admin\/posts\/\d+/)
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await page.waitForURL(onList)
    await expect.poll(async () => page.getByText('Loop Beta').count()).toBe(0)
  })

  it('duplicates via the row quick-action and bulk-deletes via the selection bar', async () => {
    await $fetch('/api/posts', {
      method: 'POST',
      headers: { cookie },
      body: { title: 'Bulk Seed', body: '<p>x</p>' },
    })
    const page = await authedPage('/admin/posts')

    // row quick-action: Duplicate → a "(copy)" row appears after the refetch
    await page.getByRole('button', { name: 'Duplicate Bulk Seed', exact: true }).click()
    await page.getByText('Bulk Seed (copy)').waitFor()

    // select both rows → the bulk bar shows the count; bulk Delete drives the shared confirm dialog
    await page.getByRole('checkbox', { name: 'Select Bulk Seed', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Select Bulk Seed (copy)', exact: true }).check()
    // Scoped to the bulk bar's own count: the permanent .list__sr-status live region announces the same
    // string, so a bare getByText would match both.
    await page.locator('.list__bulk-count', { hasText: '2 selected' }).waitFor()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect.poll(async () => page.getByText('Bulk Seed').count()).toBe(0)
  })

  it('keeps the list view state in the URL: a deep-linked filter applies, sorting updates the URL, reload preserves both', async () => {
    const page = await authedPage('/admin/posts?filter[title][contains]=Seed')
    await page.getByText('Seed Post').waitFor() // the deep-linked filter matched the seed row
    // sorting writes itself into the URL (shareable view state). `exact` keeps this off the active
    // filter chip's "Remove Title filter" button.
    await page.getByRole('button', { name: 'Title', exact: true }).click()
    await page.waitForURL((u) => new URL(u).search.includes('sort='))
    await page.reload()
    await page.getByText('Seed Post').waitFor()
    expect(new URL(page.url()).search).toContain('sort=')
    expect(decodeURIComponent(new URL(page.url()).search)).toContain('filter[title][contains]=Seed')
  })

  it('edits the settings singleton and persists across a reload', async () => {
    const page = await authedPage('/admin/settings')
    await page.getByLabel('Site Name', { exact: true }).fill('Acme Co')
    // wait for the PUT to round-trip (the toast text "Saved" collides with the editor-status ampel label)
    const saved = page.waitForResponse((r) => /\/api\/settings/.test(r.url()) && r.request().method() === 'PUT')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await saved

    // a fresh load reads the persisted singleton back through GET /api/settings
    await page.goto(url('/admin/settings'))
    await page.getByLabel('Site Name', { exact: true }).waitFor()
    await expect.poll(async () => page.getByLabel('Site Name', { exact: true }).inputValue()).toBe('Acme Co')
  })

  it('remounts on in-app navigation between collections (no stale route params)', async () => {
    const page = await authedPage('/admin/posts')
    await page.locator('a.list__new').waitFor() // the posts list is showing
    // navigate to the settings singleton via the sidebar nav (same [collection] route record)
    await page.locator('a.admin-nav__link[href="/admin/settings"]').click()
    await page.waitForURL((u) => new URL(u).pathname === '/admin/settings')
    // the singleton editor (a `Site Name` field), NOT the stale posts list, must render
    await page.getByLabel('Site Name', { exact: true }).waitFor()
    expect(await page.locator('a.list__new').count()).toBe(0)
  })

  it('links to every collection from the dashboard', async () => {
    const page = await authedPage('/admin')
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor()
    await page.locator('a.dash__card[href="/admin/posts"]').waitFor()
    await page.locator('a.dash__card[href="/admin/settings"]').waitFor()
  })

  it('edits page block content: adds a hero block, saves, and persists across reload', async () => {
    const created = await $fetch('/api/pages', {
      method: 'POST',
      headers: { cookie },
      body: { title: 'Block Page', path: '/block-page', status: 'published' },
    }) as { id: number }

    const page = await authedPage(`/admin/pages/${created.id}`)
    // Open the "+ Add block" type picker, then pick Hero.
    await page.getByRole('button', { name: 'Add block' }).click()
    await page.getByRole('button', { name: 'Add Hero' }).click()
    // Adding a block auto-selects it, so its fields show in the right-hand fields pane. `heading` is
    // required, so its label carries a trailing `*` — match by substring (not exact).
    await page.getByLabel('Heading').fill('My Hero')
    // wait for the PATCH to round-trip (the toast text "Saved" collides with the editor-status ampel label)
    const savedPage = page.waitForResponse((r) => /\/api\/pages\/\d+/.test(r.url()) && r.request().method() === 'PATCH')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await savedPage

    const reopened = await authedPage(`/admin/pages/${created.id}`)
    // On reopen the page root is selected; click the hero node in the tree to edit its fields. Aim at the
    // node NAME, not the label button: hovering the row reveals the actions overlay over the padding the
    // label reserves for it, and that padding contains the button box's centre — where a bare click lands.
    await reopened.getByRole('button', { name: 'Hero' }).locator('.block-tree__node-name').click()
    await expect.poll(async () => reopened.getByLabel('Heading').inputValue()).toBe('My Hero')
  })

  // The feature ADR-0008 exists for: look at work in progress on the real page, in a real tab, without
  // saving it and without publishing it.
  it('previews unsaved changes in a new tab through a ticket — no save, no publish', async () => {
    const created = await $fetch('/api/pages', {
      method: 'POST',
      headers: { cookie },
      body: { title: 'Ticket Page', path: '/ticket-page', status: 'published' },
    }) as { id: number }

    const page = await authedPage(`/admin/pages/${created.id}`)
    // The page editor also carries an SEO "Title", so take the first match — the page field — and prove
    // it is the right one before typing into it.
    const titleField = page.getByLabel('title').first()
    await expect.poll(async () => titleField.inputValue()).toBe('Ticket Page')
    await titleField.fill('Only in the preview')

    // Any write here would be the bug this feature removes.
    let wrote = false
    page.on('request', (r) => {
      if (/\/api\/pages/.test(r.url()) && ['PATCH', 'POST', 'PUT'].includes(r.method())) wrote = true
    })

    const [preview] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByRole('button', { name: 'Preview unsaved changes in a new tab' }).click(),
    ])
    // The tab opens blank (synchronously, so no popup blocker) and is redirected once the ticket is minted.
    await preview.waitForURL(/kestrel-preview-token=/)
    await preview.waitForLoadState('domcontentloaded')
    await expect.poll(async () => preview.title()).toContain('Only in the preview')
    await preview.getByText('Preview — unsaved changes, not published').waitFor()
    expect(wrote).toBe(false)

    // …and the stored record is untouched.
    const stored = await $fetch(`/api/pages/${created.id}`, { headers: { cookie } }) as { title: string }
    expect(stored.title).toBe('Ticket Page')
  })
})
