import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, fetch } from '@nuxt/test-utils/e2e'
import vitestOpenAPI from 'vitest-openapi'
import { hashPassword } from '@michaelthielemann/kestrel-auth'

const dbPath = join(tmpdir(), `kestrel-openapi-contract-${process.pid}.sqlite`)
const PW = 'openapi-contract-test-password'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

interface ShapedResponse {
  status: number
  data: unknown
  request: { path: string, method: string }
}

/** Builds the axios-shaped object `vitest-openapi` recognizes (`'data' in res`), matched against the live
 *  document by `request.path`/`request.method` alone — the query string plays no part in path matching. */
async function shaped(method: string, path: string, options: { cookie?: string, body?: unknown } = {}): Promise<ShapedResponse> {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  let data: unknown
  try { data = await res.json() } catch { data = undefined }
  return { status: res.status, data, request: { path, method } }
}

describe('OpenAPI contract (e2e)', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('../../', import.meta.url)),
    dev: true,
  })

  let cookie = ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any

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

    const docRes = await fetch('/api/_openapi', { headers: { cookie } })
    expect(docRes.status, 'GET /api/_openapi must succeed for an admin session').toBe(200)
    doc = await docRes.json()
    vitestOpenAPI(doc)
  }, 60000)

  afterAll(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(dbPath + suffix) } catch {}
    }
  })

  it('GET /api/_openapi is denied for an anonymous caller', async () => {
    const res = await fetch('/api/_openapi')
    expect([401, 403]).toContain(res.status)
  })

  it('POST /api/login satisfies the spec', async () => {
    const res = await shaped('POST', '/api/login', { body: { password: PW } })
    expect(res.status).toBe(200)
    expect(res).toSatisfyApiSpec()
  })

  it('POST /api/pages/createOne satisfies the spec', async () => {
    const res = await shaped('POST', '/api/pages/createOne', {
      cookie,
      body: { title: 'OpenAPI contract', path: '/openapi-contract' },
    })
    expect(res.status).toBe(201)
    expect(res).toSatisfyApiSpec()
  })

  it('the eight standard ops + a tooling read satisfy the spec', async () => {
    const a = await shaped('POST', '/api/pages/createOne', { cookie, body: { title: 'A', path: '/openapi-a' } })
    expect(a).toSatisfyApiSpec()
    const aId = (a.data as { id: number }).id

    const b = await shaped('POST', '/api/pages/createOne', { cookie, body: { title: 'B', path: '/openapi-b' } })
    expect(b).toSatisfyApiSpec()
    const bId = (b.data as { id: number }).id

    const createMany = await shaped('POST', '/api/pages/createMany', {
      cookie,
      body: [{ title: 'C', path: '/openapi-c' }, { title: 'D', path: '/openapi-d' }],
    })
    expect(createMany).toSatisfyApiSpec()
    const createdIds = (createMany.data as { id: number }[]).map((r) => r.id)

    const readOne = await shaped('GET', `/api/pages/readOne/${aId}`, { cookie })
    expect(readOne).toSatisfyApiSpec()

    const readMany = await shaped('GET', '/api/pages/readMany', { cookie })
    expect(readMany).toSatisfyApiSpec()

    const updateOne = await shaped('POST', `/api/pages/updateOne/${aId}`, { cookie, body: { title: 'A updated' } })
    expect(updateOne).toSatisfyApiSpec()

    const updateMany = await shaped('POST', '/api/pages/updateMany', { cookie, body: { ids: [bId], patch: { title: 'B updated' } } })
    expect(updateMany).toSatisfyApiSpec()

    const schema = await shaped('GET', '/api/pages/schema', { cookie })
    expect(schema).toSatisfyApiSpec()

    const deleteOne = await shaped('POST', `/api/pages/deleteOne/${aId}`, { cookie })
    expect(deleteOne).toSatisfyApiSpec()

    const deleteMany = await shaped('POST', '/api/pages/deleteMany', { cookie, body: { ids: createdIds } })
    expect(deleteMany).toSatisfyApiSpec()
  })
})
