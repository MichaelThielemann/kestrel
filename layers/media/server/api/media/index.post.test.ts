import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createError } from 'h3'
import sharp from 'sharp'
import { createTestDb } from '../../../../../test/helpers/db'
import { DEFAULT_IMAGE_POLICY } from '../../../../core/server/utils/kestrel-config'
import { registerWriteListener, clearWriteListeners, type WriteEvent } from '../../../../core/server/utils/write-events'

interface Part { name: string; filename?: string; data: Buffer }
interface FakeEvent { headers: Record<string, string>; parts: Part[]; status?: number }

let db: ReturnType<typeof createTestDb>
let uploadsDir: string
let runtime: Record<string, unknown>

// The handler is a Nitro route: its auto-imported helpers are plain globals in a node test.
Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  requireAdmin: () => {},
  createError,
  getRequestHeader: (event: FakeEvent, name: string) => event.headers[name],
  readMultipartFormData: async (event: FakeEvent) => event.parts,
  setResponseStatus: (event: FakeEvent, status: number) => { event.status = status },
  useDb: () => db,
  useRuntimeConfig: () => runtime,
})

const handler = (await import('./index.post')).default as unknown as (event: FakeEvent) => Promise<Record<string, unknown>>

const png = (width: number) => sharp({ create: { width, height: 40, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()

const upload = (bytes: Buffer, extra: Record<string, string> = {}, filename = 'hero.png') => {
  const parts: Part[] = [{ name: 'file', filename, data: bytes }]
  for (const [name, value] of Object.entries(extra)) parts.push({ name, data: Buffer.from(value) })
  return handler({ headers: { 'content-length': String(bytes.length) }, parts })
}

beforeEach(() => {
  db = createTestDb()
  uploadsDir = mkdtempSync(join(tmpdir(), 'kestrel-upload-'))
  runtime = {
    media: {
      driver: 'local',
      maxUploadBytes: 10_000_000,
      allowedMimes: '',
      imagePolicy: DEFAULT_IMAGE_POLICY,
      local: { dir: uploadsDir, baseUrl: '/uploads' },
      s3: {},
    },
    kestrel: {},
  }
  clearWriteListeners()
})
afterEach(() => {
  clearWriteListeners()
  rmSync(uploadsDir, { recursive: true, force: true })
})

describe('POST /api/media', () => {
  it('emits no media write event for a brand-new upload (no published page can reference it yet)', async () => {
    const events: WriteEvent[] = []
    registerWriteListener((e) => events.push(e))
    await upload(await png(60))
    expect(events).toEqual([])
  })

  it('emits no media write event when overwrite is requested but no row exists (still a create)', async () => {
    const events: WriteEvent[] = []
    registerWriteListener((e) => events.push(e))
    await upload(await png(60), { overwrite: 'true' })
    expect(events).toEqual([])
  })

  it('emits a media write event for an overwrite (replace) so stale derivative URLs are re-rendered', async () => {
    const row = await upload(await png(60))
    const events: WriteEvent[] = []
    registerWriteListener((e) => events.push(e))
    const replaced = await upload(await png(30), { overwrite: 'true' })
    expect(replaced.id).toBe(row.id)
    expect(events).toHaveLength(1)
    expect(events[0].before).toMatchObject({ id: row.id })
    expect(events[0].after).toMatchObject({ id: row.id })
  })

  it('404s instead of querying a missing table when the media built-in is disabled', async () => {
    runtime.kestrel = { collections: { media: false } }
    await expect(upload(await png(60))).rejects.toThrowError(expect.objectContaining({ statusCode: 404 }))
  })

  it('wraps a sharp derive failure (a corrupt-but-signature-valid raster) into a clean 4xx, not a bare 500', async () => {
    const real = await png(100)
    const truncated = real.subarray(0, Math.floor(real.length / 3)) // still sniffs as image/png; unprocessable
    try {
      await upload(truncated)
      expect.unreachable()
    } catch (e) {
      const statusCode = (e as { statusCode?: number }).statusCode
      expect(statusCode).toBeGreaterThanOrEqual(400)
      expect(statusCode).toBeLessThan(500)
    }
  })

  it('refuses an upload whose OWN derivative key would collide with an unrelated media row already at that key', async () => {
    // A real webp, named exactly the way a `pic.png` original's own `w320` webp derivative would be keyed.
    const impostor = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).webp().toBuffer()
    await upload(impostor, { folder: 'a' }, 'pic.png-w320.webp')
    // Now upload the real original whose derive would write exactly that same key.
    const err = await upload(await png(800), { folder: 'a' }, 'pic.png').then(() => undefined, (e) => e as { statusCode?: number; statusMessage?: string })
    // The refusal is about the file the user actually dropped, so it has to name that file. It must NOT
    // reuse 409: the uploader reads 409 as the rename/overwrite/skip name-conflict contract, and neither
    // "overwrite" (same key → same derivative → refused again) nor a suggestion-less "rename" ends it.
    expect(err?.statusCode).not.toBe(409)
    expect(err?.statusMessage).toContain('pic.png')
    expect(err?.statusMessage).toMatch(/generated|resized/i)
    // The impostor file must be untouched — no derivative write ever landed on top of it.
    const stored = readFileSync(join(uploadsDir, 'a/pic.png-w320.webp'))
    expect(stored.equals(impostor)).toBe(true)
  })

  it('sanitizes an SVG upload before it is stored — the object on disk is not the raw client bytes', async () => {
    const dirty = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>')
    const row = await upload(dirty, {}, 'evil.svg')
    const stored = readFileSync(join(uploadsDir, row.storageKey as string), 'utf8')
    expect(stored).not.toContain('<script')
    expect(stored).toContain('<rect')
  })
})
