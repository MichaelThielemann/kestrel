import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, afterAll } from 'vitest'
import { setup, fetch as testFetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '@michaelthielemann/kestrel-auth'

// Thin wiring smoke test — the actual seeding/transaction/resumability contract is unit-tested directly
// against the core function in `test/architecture/migrate-revisions.test.ts` (defineTask/useDb() are
// Nitro-runtime globals unreachable from plain vitest). This file only pins that a `db:migrate-revisions`
// task is registered, and that it is gated exactly like `db:migrate`/`db:migrate-module` (explicit flag),
// same shape as `test/e2e/migrate-module.test.ts`.
const dbPath = join(tmpdir(), `kestrel-migrate-revisions-e2e-${process.pid}.sqlite`)
const PW = 'e2e-migrate-revisions-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('db:migrate-revisions task (e2e, dev task route)', async () => {
  await setup({ rootDir: fileURLToPath(new URL('../../', import.meta.url)), dev: true })

  afterAll(() => {
    for (const suffix of ['', '-wal', '-shm']) { try { rmSync(dbPath + suffix) } catch {} }
  })

  async function runTask(payload: Record<string, unknown> = {}): Promise<Response> {
    return testFetch('/_nitro/tasks/db:migrate-revisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload }),
    })
  }

  it('refuses to run without the explicit force flag, naming it in the refusal', async () => {
    const res = await runTask({})
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json() as { message: string }
    expect(body.message).toMatch(/force/i)
  })

  it('runs when {"force":true} is given', async () => {
    const res = await runTask({ force: true })
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { collection: string; seeded: number; skipped: number }[] }
    expect(Array.isArray(body.result)).toBe(true)
  })
})
