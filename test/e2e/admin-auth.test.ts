import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, afterAll } from 'vitest'
import { setup, createPage, fetch as testFetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '../../layers/auth/server/utils/password'
import { e2eBrowserOptions } from '../helpers/e2e-browser'

const dbPath = join(tmpdir(), `kestrel-admin-e2e-${process.pid}.sqlite`)
const PW = 'e2e-admin-password'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)
// Pid-scoped epoch file: the default lands NEXT TO the DB, i.e. a SHARED tmpdir file that suites
// would leak into each other (and leave behind). Same isolation idea as the pid-scoped DB.
process.env.KESTREL_SESSION_EPOCH_FILE = `${dbPath}.epoch`

describe('admin auth flow (e2e, browser)', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('../../', import.meta.url)),
    dev: true,
    browser: true,
    browserOptions: e2eBrowserOptions,
  })

  afterAll(() => {
    for (const suffix of ['', '-wal', '-shm', '.epoch']) {
      try { rmSync(dbPath + suffix) } catch {}
    }
  })

  async function login(): Promise<string> {
    const res = await testFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    })
    const set = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean) as string[]
    return set.map((c) => c.split(';')[0]).join('; ')
  }

  async function sessionState(cookie: string): Promise<boolean> {
    const res = await testFetch('/api/auth/session', { headers: { cookie } })
    return ((await res.json()) as { authenticated?: boolean }).authenticated === true
  }

  it('gates /admin, rejects a wrong password, logs in, lands, and logs out', async () => {
    const page = await createPage('/admin')

    // the client gate bounces an unauthenticated visitor to the login page
    await page.waitForURL(/\/admin\/login/)

    // wrong password → inline error, still on the login page
    await page.getByLabel('Password', { exact: true }).fill('definitely-wrong')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByText('Invalid credentials').waitFor()
    expect(new URL(page.url()).pathname).toBe('/admin/login')

    // correct password → lands on the dashboard
    await page.getByLabel('Password', { exact: true }).fill(PW)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL((u) => new URL(u).pathname === '/admin')
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor()

    // logout → open the rail's account menu, then Sign out (a Reka dropdown menuitem) → login page
    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await page.waitForURL(/\/admin\/login/)
  })

  it('serves /admin/login directly (explicit route beats the public catch-all)', async () => {
    const page = await createPage('/admin/login')
    await page.getByRole('heading', { name: 'Sign in' }).waitFor()
  })

  it('logout hard-revokes EVERY outstanding session (epoch bump), and a fresh login works again', async () => {
    // two independently issued sessions (e.g. two browsers)
    const first = await login()
    const second = await login()
    expect(await sessionState(first)).toBe(true)
    expect(await sessionState(second)).toBe(true)

    // logging out with the FIRST session must revoke the SECOND too — the epoch folds into the
    // signing key, so every token issued before the bump fails verification, not just this one.
    const out = await testFetch('/api/auth/logout', { method: 'POST', headers: { cookie: first } })
    expect(out.status).toBeLessThan(400)
    expect(await sessionState(first)).toBe(false)
    expect(await sessionState(second)).toBe(false)

    // post-revocation logins issue verifiable tokens under the bumped epoch
    const fresh = await login()
    expect(await sessionState(fresh)).toBe(true)
  })
})
