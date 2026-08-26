import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, mkdtempSync, existsSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch as testFetch } from '@nuxt/test-utils/e2e'
import sharp from 'sharp'
import { hashPassword } from '@michaelthielemann/kestrel-auth'

const dbPath = join(tmpdir(), `kestrel-media-e2e-${process.pid}.sqlite`)
const uploads = mkdtempSync(join(tmpdir(), 'kestrel-media-up-'))
const PW = 'media-e2e-pw'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_MEDIA_LOCAL_DIR = uploads
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('media API (e2e)', async () => {
  await setup({ rootDir: fileURLToPath(new URL('../../', import.meta.url)), dev: true })

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

  it('uploads an image (multipart), lists it, and GETs it directly', async () => {
    const png = await sharp({
      create: { width: 700, height: 400, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    }).png().toBuffer()
    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), 'pic.png')
    form.append('folder', 'seite-a')
    form.append('alt', 'A cat')

    const created = await $fetch('/api/media/upload', {
      method: 'POST',
      headers: { cookie },
      body: form,
    }) as { id: number; url: string; storageKey: string }

    expect(created.id).toBeTypeOf('number')
    expect(created.url).toContain('/uploads/seite-a/pic.png')
    expect(created.storageKey).toBe('seite-a/pic.png')

    const listed = await $fetch('/api/media/readMany', { headers: { cookie } }) as { total: number; data: unknown[] }
    expect(listed.total).toBeGreaterThanOrEqual(1)

    const got = await $fetch(`/api/media/readOne/${created.id}`, { headers: { cookie } }) as { storageKey: string }
    expect(got.storageKey).toBe(created.storageKey)

    // the upload ensured a folder row; the library lists it (root) and the file (inside it)
    const root = await $fetch('/api/media/library', { headers: { cookie }, query: { folder: '' } }) as { folders: { path: string }[] }
    expect(root.folders.map((f) => f.path)).toContain('seite-a')
    const inFolder = await $fetch('/api/media/library', { headers: { cookie }, query: { folder: 'seite-a' } }) as { files: { filename: string }[] }
    expect(inFolder.files.map((f) => f.filename)).toContain('pic.png')
  })

  it('reports usages (empty for an unreferenced upload)', async () => {
    const svgBlob = new Blob(
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')],
      { type: 'image/svg+xml' },
    )
    const form = new FormData()
    form.append('file', svgBlob, 'i.svg')

    const created = await $fetch('/api/media/upload', {
      method: 'POST',
      headers: { cookie },
      body: form,
    }) as { id: number }

    const u = await $fetch(`/api/media/usages/${created.id}`, { headers: { cookie } }) as { usages: unknown[] }
    expect(Array.isArray(u.usages)).toBe(true)
  })

  it('409s on a colliding upload without overwrite', async () => {
    const svgBlob = () => new Blob(
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')],
      { type: 'image/svg+xml' },
    )
    const mk = () => {
      const f = new FormData()
      f.append('file', svgBlob(), 'dup.svg')
      f.append('folder', 'c')
      return f
    }

    await $fetch('/api/media/upload', { method: 'POST', headers: { cookie }, body: mk() })
    await expect(
      $fetch('/api/media/upload', { method: 'POST', headers: { cookie }, body: mk() }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('rejects an unauthenticated upload with 401', async () => {
    const f = new FormData()
    f.append('file', new Blob([Buffer.from('x')], { type: 'image/png' }), 'x.png')
    await expect(
      $fetch('/api/media/upload', { method: 'POST', body: f }),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an unauthenticated move with 401', async () => {
    await expect(
      $fetch('/api/media/move', { method: 'POST', body: { items: [{ type: 'folder', path: 'x' }], dest: 'y' } }),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('empty folder materializes on disk and is removed on delete', async () => {
    await $fetch('/api/media/folders', {
      method: 'POST',
      headers: { cookie },
      body: { path: 'disk-test' },
    })
    expect(existsSync(join(uploads, 'disk-test'))).toBe(true)

    await $fetch('/api/media/delete', {
      method: 'POST',
      headers: { cookie },
      body: { items: [{ type: 'folder', path: 'disk-test' }] },
    })
    expect(existsSync(join(uploads, 'disk-test'))).toBe(false)
  })

  it('moves a file between folders (round-trip through the engine)', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 9, g: 8, b: 7, alpha: 1 } },
    }).png().toBuffer()
    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), 'pic.png')
    form.append('folder', 'mv-src')

    const { id } = await $fetch('/api/media/upload', {
      method: 'POST', headers: { cookie }, body: form,
    }) as { id: number }

    const moved = await $fetch('/api/media/move', {
      method: 'POST', headers: { cookie },
      body: { items: [{ type: 'file', id }], dest: 'mv-dst' },
    }) as { item: unknown; status: string; newPath?: string }[]
    expect(moved[0].status).toBe('moved')

    const dst = await $fetch('/api/media/library', { headers: { cookie }, query: { folder: 'mv-dst' } }) as { files: { filename: string }[] }
    expect(dst.files.map((f) => f.filename)).toContain('pic.png')
    const src = await $fetch('/api/media/library', { headers: { cookie }, query: { folder: 'mv-src' } }) as { files: { filename: string }[] }
    expect(src.files.map((f) => f.filename)).not.toContain('pic.png')
  })
})
