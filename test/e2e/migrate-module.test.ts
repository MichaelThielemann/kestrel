import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, afterAll } from 'vitest'
import { setup, fetch as testFetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '@kestrel/auth'

const dbPath = join(tmpdir(), `kestrel-migrate-module-e2e-${process.pid}.sqlite`)
const PW = 'e2e-migrate-module-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('db:migrate-module task (e2e, dev task route)', async () => {
  await setup({ rootDir: fileURLToPath(new URL('../../', import.meta.url)), dev: true })

  afterAll(() => {
    for (const suffix of ['', '-wal', '-shm']) { try { rmSync(dbPath + suffix) } catch {} }
  })

  async function runTask(payload: Record<string, unknown> = {}): Promise<Response> {
    return testFetch('/_nitro/tasks/db:migrate-module', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload }),
    })
  }

  it('with no module given, migrates content, then media, then publishing, then unmanaged — in that order', async () => {
    const res = await runTask({ check: true })
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { module: string }[] }
    expect(body.result.map((r) => r.module)).toEqual(['content', 'media', 'publishing', 'unmanaged'])
  })

  it('scopes to a single named module and reports it well-formed', async () => {
    const res = await runTask({ check: true, module: 'media' })
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { module: string; check: boolean; pending: string[]; destructive: string[] }[] }
    expect(body.result).toHaveLength(1)
    expect(body.result[0]).toMatchObject({ module: 'media', check: true })
    expect(Array.isArray(body.result[0]!.pending)).toBe(true)
    expect(Array.isArray(body.result[0]!.destructive)).toBe(true)
  })

  it('accepts the "unmanaged" catch-all as an explicit module name', async () => {
    const res = await runTask({ check: true, module: 'unmanaged' })
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { module: string }[] }
    expect(body.result).toEqual([{ module: 'unmanaged', check: true, pending: [], destructive: [] }])
  })

  it('rejects an unknown module name', async () => {
    const res = await runTask({ module: 'nope' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json() as { message: string }
    expect(body.message).toMatch(/unknown module "nope"/)
  })
})
