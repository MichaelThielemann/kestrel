import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEvent } from 'h3'
import { Effect } from 'effect'
import sharp from 'sharp'
import type { ValidationFailed } from '@michaelthielemann/kestrel-contracts'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { runStepAsync } from '../../../../../test/helpers/run-effect.js'
import { DEFAULT_IMAGE_POLICY, clearPipelines, createPipelineContext, eventsOf, registerAfterStep, getResolvedKestrelConfig, setResolvedKestrelConfig } from '@michaelthielemann/kestrel-core'
import type { WriteEvent } from '@michaelthielemann/kestrel-core'
import { buildMediaUploadPipeline } from '../../../src/server/pipelines/media-upload.js'

interface Part { name: string; filename?: string; data: Buffer }

// The multipart stream is the one thing a hand-built event cannot supply; everything else — the
// Content-Length pre-checks, the response status — runs against the real h3 helpers.
vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('h3')>()),
  readMultipartFormData: async (event: { context: { parts?: Part[] } }) => event.context.parts,
}))

let db: ReturnType<typeof createTestDb>
let uploadsDir: string

const ORIG_CONFIG = getResolvedKestrelConfig()

const step = buildMediaUploadPipeline().steps![0]!

const png = (width: number) => sharp({ create: { width, height: 40, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()

const upload = async (bytes: Buffer, extra: Record<string, string> = {}, filename = 'hero.png') => {
  const parts: Part[] = [{ name: 'file', filename, data: bytes }]
  for (const [name, value] of Object.entries(extra)) parts.push({ name, data: Buffer.from(value) })
  const event = createEvent(
    { method: 'POST', url: '/api/media/upload', headers: { 'content-length': String(bytes.length) }, socket: {} } as never,
    { setHeader() {} } as never,
  )
  event.context.parts = parts
  const ctx = createPipelineContext({ op: 'upload', db, event })
  await runStepAsync(step.fn(ctx))
  return ctx.output as Record<string, unknown>
}

/** Probes `emitMediaWrite`'s after-step-only bypass path — the upload pipeline never runs the full write
 *  pipeline, so this registers a plain observer after-step instead of mirroring one specific plugin. */
const probeEvents = (events: WriteEvent[]) => {
  clearPipelines()
  registerAfterStep({ critical: false, step: { name: 'probe', fn: (ctx) => Effect.sync(() => { events.push(...eventsOf(ctx)) }) } })
}

beforeEach(() => {
  db = createTestDb()
  uploadsDir = mkdtempSync(join(tmpdir(), 'kestrel-upload-'))
  setResolvedKestrelConfig({
    ...ORIG_CONFIG,
    media: { dir: uploadsDir, baseUrl: '/uploads', driver: 'local', maxUploadBytes: 10_000_000, allowedMimes: '', s3: { bucket: '', region: '', endpoint: '', prefix: '', publicBaseUrl: '' }, imagePolicy: DEFAULT_IMAGE_POLICY },
    collections: { pages: true, media: true },
    aiDisclosure: { enabled: false },
  })
  clearPipelines()
})
afterEach(() => {
  clearPipelines()
  rmSync(uploadsDir, { recursive: true, force: true })
  setResolvedKestrelConfig(ORIG_CONFIG)
})

describe('POST /api/media/upload', () => {
  it('emits no media write event for a brand-new upload (no published page can reference it yet)', async () => {
    const events: WriteEvent[] = []
    probeEvents(events)
    await upload(await png(60))
    expect(events).toEqual([])
  })

  it('emits no media write event when overwrite is requested but no row exists (still a create)', async () => {
    const events: WriteEvent[] = []
    probeEvents(events)
    await upload(await png(60), { overwrite: 'true' })
    expect(events).toEqual([])
  })

  it('emits a media write event for an overwrite (replace) so stale derivative URLs are re-rendered', async () => {
    const row = await upload(await png(60))
    const events: WriteEvent[] = []
    probeEvents(events)
    const replaced = await upload(await png(30), { overwrite: 'true' })
    expect(replaced.id).toBe(row.id)
    expect(events).toHaveLength(1)
    expect(events[0]!.before).toMatchObject({ id: row.id })
    expect(events[0]!.after).toMatchObject({ id: row.id })
  })

  it('404s instead of querying a missing table when the media built-in is disabled', async () => {
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), collections: { pages: true, media: false } })
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

describe('POST /api/media/upload — EU AI Act signal scan', () => {
  // A PNG carrying a Stable-Diffusion-style `parameters` text chunk.
  const generated = async () => {
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#123456' } }).png().toBuffer()
    const data = Buffer.from('parameters\0masterpiece, Steps: 20', 'latin1')
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), data])
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
    let c = 0xFFFFFFFF
    for (const b of body) c = table[(c ^ b) & 0xFF]! ^ (c >>> 8)
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xFFFFFFFF) >>> 0)
    const iend = png.lastIndexOf(Buffer.from('IEND', 'latin1')) - 4
    return Buffer.concat([png.subarray(0, iend), len, body, crc, png.subarray(iend)])
  }

  it('pre-fills aiNote with the evidence, and NEVER the aiSourceType classification', async () => {
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), aiDisclosure: { enabled: true } })
    const row = await upload(await generated())
    expect(row.aiNote).toContain('parameters')
    expect(row.aiSourceType).toBeNull() // the legal classification stays a human decision
  })

  it('does not scan at all while the flag is off — no cost for consumers not using the feature', async () => {
    const row = await upload(await generated())
    expect(row.aiNote).toBeNull()
    expect(row.aiSourceType).toBeNull()
  })

  it('never overwrites a note the uploader supplied', async () => {
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), aiDisclosure: { enabled: true } })
    const row = await upload(await generated(), { aiNote: 'checked by hand' })
    expect(row.aiNote).toBe('checked by hand')
  })

  it('leaves a clean photo alone (no evidence ⇒ no note)', async () => {
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), aiDisclosure: { enabled: true } })
    const row = await upload(await png(60))
    expect(row.aiNote).toBeNull()
  })

  it('accepts an uploader-supplied classification but rejects an unknown one with a 400', async () => {
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), aiDisclosure: { enabled: true } })
    const ok = await upload(await png(60), { aiSourceType: 'algorithmicallyEnhanced' }, 'ok.png')
    expect(ok.aiSourceType).toBe('algorithmicallyEnhanced')
    await expect(upload(await png(60), { aiSourceType: 'nonsense' }, 'bad.png'))
      .rejects.toThrowError(expect.objectContaining({ _tag: 'ValidationFailed' }) as ValidationFailed)
  })

  it('a re-upload does not silently wipe an existing disclosure', async () => {
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), aiDisclosure: { enabled: true } })
    const first = await upload(await png(60), { aiSourceType: 'trainedAlgorithmicMedia', aiNote: 'Midjourney v7' })
    const replaced = await upload(await png(30), { overwrite: 'true' })
    expect(replaced.id).toBe(first.id)
    expect(replaced).toMatchObject({ aiSourceType: 'trainedAlgorithmicMedia', aiNote: 'Midjourney v7' })
  })
})
