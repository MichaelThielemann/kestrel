import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearPipelines, registerPipeline, createLocalDriver  } from '@kestrel/core'
import { runPipelineForEventAsync } from '@kestrel/access'
import { secureGalleryTreePipeline } from './tree'

// The pipeline calls `useStorageDriver()` (an explicit import from core/utils/storage), so the module is
// mocked to hand back the test's in-memory (or real local) driver.
const GID = '11111111-1111-1111-1111-111111111111'
const NS = `galleries-secure/${GID}`
const A = 'aaaaaaaa-1111-1111-1111-111111111111.bin'
const B = 'bbbbbbbb-2222-2222-2222-222222222222.bin'

interface StoredObject { bytes: Buffer; mtimeMs: number }

let store: Map<string, StoredObject>
let driver: Record<string, unknown>

function makeDriver(overrides: Record<string, unknown> = {}) {
  return {
    async put(key: string, bytes: Buffer | Uint8Array) { store.set(key, { bytes: Buffer.from(bytes), mtimeMs: Date.now() }) },
    async get(key: string) {
      const o = store.get(key)
      if (!o) throw new Error(`ENOENT ${key}`)
      return o.bytes
    },
    async delete(key: string) { store.delete(key) },
    publicUrl: (key: string) => `/uploads/${key}`,
    async exists(key: string) { return store.has(key) },
    async listPrefix(prefix: string) { return [...store.keys()].filter((k) => k.startsWith(prefix)) },
    async stat(key: string) { const o = store.get(key); return o ? { mtimeMs: o.mtimeMs } : null },
    ...overrides,
  }
}

vi.mock('@kestrel/media', () => ({
  useStorageDriver: () => driver,
  mediaRuntimeConfig: () => ({ maxUploadBytes: 10_000_000 }),
}))

function eventFor(body: unknown): H3Event {
  const json = JSON.stringify(body)
  const event = createEvent(
    {
      method: 'POST',
      url: '/api/secureGalleryTree',
      headers: { 'sec-fetch-site': 'same-origin', 'content-length': String(json.length) },
      socket: { remoteAddress: '203.0.113.9' },
    } as never,
    { setHeader() {} } as never,
  )
  event.context.principal = { userId: 'admin', role: 'admin' } as never
  ;(event as unknown as { _requestBody: string })._requestBody = json
  return event
}

const run = (body: unknown) => runPipelineForEventAsync(eventFor(body), { op: 'secureGalleryTree' })

beforeAll(() => {
  clearPipelines()
  registerPipeline(secureGalleryTreePipeline)
})

beforeEach(() => {
  store = new Map()
  driver = makeDriver()
})

const storedIndex = () => JSON.parse(store.get(`${NS}/index.json`)!.bytes.toString())
const putStored = (index: unknown) => store.set(`${NS}/index.json`, { bytes: Buffer.from(JSON.stringify(index)), mtimeMs: Date.now() })
const fileEntry = (blobId: string) => ({ blobId, ivB64: 'iv', name: { iv: 'i', data: 'd' }, mime: 'image/jpeg', size: 1 })

describe('secureGalleryTree pipeline — index write concurrency guard', () => {
  it('accepts a write whose seq advances the stored one', async () => {
    putStored({ v: 1, seq: 4, files: [], folders: [] })
    await run({ galleryId: GID, index: { v: 1, seq: 5, files: [fileEntry(A)], folders: [] } })
    expect(storedIndex().seq).toBe(5)
    expect(storedIndex().files).toHaveLength(1)
  })

  it('rejects (409) a stale write whose seq does not advance, leaving the stored index untouched', async () => {
    // Tab A wrote seq 5 with two blobs; tab B still holds the pre-upload model (seq 4) and would otherwise
    // overwrite it — destroying the only copy of those entries' IVs + sealed names.
    putStored({ v: 1, seq: 5, files: [fileEntry(A), fileEntry(B)], folders: [] })
    await expect(run({ galleryId: GID, index: { v: 1, seq: 4, files: [], folders: [] } }))
      .rejects.toMatchObject({ statusCode: 409 })
    await expect(run({ galleryId: GID, index: { v: 1, seq: 5, files: [], folders: [] } }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(storedIndex().files).toHaveLength(2)
  })

  it('rejects (409) a write with no seq once the stored index carries one', async () => {
    putStored({ v: 1, seq: 2, files: [fileEntry(A)], folders: [] })
    await expect(run({ galleryId: GID, index: { v: 1, files: [], folders: [] } }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(storedIndex().files).toHaveLength(1)
  })

  it('a rejected write never reaches the orphan reconcile (the ciphertext survives)', async () => {
    store.set(`${NS}/${A}`, { bytes: Buffer.from('cipher'), mtimeMs: Date.now() - 24 * 60 * 60 * 1000 })
    putStored({ v: 1, seq: 3, files: [fileEntry(A)], folders: [] })
    await expect(run({ galleryId: GID, index: { v: 1, seq: 1, files: [], folders: [] } }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(store.has(`${NS}/${A}`)).toBe(true)
  })

  it('legacy: a stored index without seq is still writable (no guard to enforce)', async () => {
    putStored({ v: 1, files: [], folders: [] })
    await run({ galleryId: GID, index: { v: 1, seq: 1, files: [fileEntry(A)], folders: [] } })
    expect(storedIndex().seq).toBe(1)
  })

  it('a gallery with no stored index yet accepts the first write', async () => {
    await run({ galleryId: GID, index: { v: 1, seq: 1, files: [], folders: [] } })
    expect(storedIndex().seq).toBe(1)
  })

  it('a driver without `get` still writes (the guard degrades, it never blocks)', async () => {
    driver = makeDriver({ get: undefined })
    putStored({ v: 1, seq: 9, files: [], folders: [] })
    await run({ galleryId: GID, index: { v: 1, seq: 1, files: [], folders: [] } })
    expect(storedIndex().seq).toBe(1)
  })

  it('refuses the write when the stored index exists but the read FAILS (not the same as "no index")', async () => {
    // Stale tab B (seq 2) saves while the storage GET of index.json 503s. Reading that as "no stored index"
    // would disarm both guards at once: the seq check is skipped AND the reconcile sees an empty stored file
    // list, so it deletes blob B — whose ivB64 + sealed name live only in the other tab's memory.
    store.set(`${NS}/${B}`, { bytes: Buffer.from('cipher'), mtimeMs: Date.now() - 24 * 60 * 60 * 1000 })
    putStored({ v: 1, seq: 9, files: [fileEntry(A), fileEntry(B)], folders: [] })
    driver = makeDriver({ get: async () => { throw new Error('503 Service Unavailable') } })
    await expect(run({ galleryId: GID, index: { v: 1, seq: 2, files: [fileEntry(A)], folders: [] } }))
      .rejects.toMatchObject({ statusCode: 503 })
    expect(storedIndex().seq).toBe(9)
    expect(storedIndex().files).toHaveLength(2)
    expect(store.has(`${NS}/${B}`)).toBe(true)
  })

  it('refuses the write when the presence probe itself fails (doubt is not absence)', async () => {
    putStored({ v: 1, seq: 9, files: [fileEntry(A)], folders: [] })
    driver = makeDriver({
      get: async () => { throw new Error('timeout') },
      exists: async () => { throw new Error('S3 head failed (500)') },
    })
    await expect(run({ galleryId: GID, index: { v: 1, seq: 2, files: [], folders: [] } }))
      .rejects.toMatchObject({ statusCode: 503 })
    expect(storedIndex().seq).toBe(9)
  })

  it('refuses the write on the SHIPPED local driver when its index read + probe both fail', async () => {
    // The guard above is only as good as the driver under it: a driver that answers "not there" to a failed
    // probe collapses `unreadable` into `absent`, disarming the seq check and arming the orphan prune in the
    // same request. Exercised against the real local driver, with a symlink cycle standing in for the
    // transient ESTALE/EIO a network volume raises.
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-tree-'))
    await mkdir(join(dir, NS), { recursive: true })
    await symlink(join(dir, NS, 'index.other'), join(dir, NS, 'index.json'))
    await symlink(join(dir, NS, 'index.json'), join(dir, NS, 'index.other'))
    driver = createLocalDriver({ dir, baseUrl: '/uploads' }) as unknown as Record<string, unknown>
    await expect(run({ galleryId: GID, index: { v: 1, seq: 2, files: [], folders: [] } }))
      .rejects.toMatchObject({ statusCode: 503 })
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts the first write on the SHIPPED local driver when the index is genuinely absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-tree-ok-'))
    driver = createLocalDriver({ dir, baseUrl: '/uploads' }) as unknown as Record<string, unknown>
    await expect(run({ galleryId: GID, index: { v: 1, seq: 1, files: [], folders: [] } }))
      .resolves.toMatchObject({ ok: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts the first write when the index is genuinely absent and the driver has no `exists`', async () => {
    driver = makeDriver({ exists: undefined }) // falls back to `stat`, which the reconcile already requires
    await run({ galleryId: GID, index: { v: 1, seq: 1, files: [], folders: [] } })
    expect(storedIndex().seq).toBe(1)
  })
})

describe('secureGalleryTree pipeline — a damaged stored index', () => {
  const GARBLED = '{ truncated'
  const damaged = (bytes: Buffer) => store.set(`${NS}/index.json`, { bytes, mtimeMs: Date.now() })

  it('refuses an ordinary write as REPAIRABLE, not as a transient read failure', async () => {
    // The bytes came back fine — they are simply not an index (an interrupted/truncated put). Answering the
    // transient 503 forever leaves the gallery unwritable with no in-app way out.
    damaged(Buffer.from(GARBLED))
    await expect(run({ galleryId: GID, index: { v: 1, seq: 2, files: [], folders: [] } }))
      .rejects.toMatchObject({ statusCode: 422, data: { repairable: true } })
    expect(store.get(`${NS}/index.json`)!.bytes.toString()).toBe(GARBLED)
  })

  it('classifies a 0-byte index as damaged too (the interrupted-write shape)', async () => {
    damaged(Buffer.alloc(0))
    await expect(run({ galleryId: GID, index: { v: 1, seq: 2, files: [], folders: [] } }))
      .rejects.toMatchObject({ statusCode: 422, data: { repairable: true } })
  })

  it('an explicit repair write replaces the damaged index', async () => {
    damaged(Buffer.from(GARBLED))
    await run({ galleryId: GID, index: { v: 1, seq: 1, files: [], folders: [] }, repair: true })
    expect(storedIndex().seq).toBe(1)
  })

  it('a repair write leaves the namespace ciphertext alone', async () => {
    // Nothing readable said which blobs the damaged index referenced, so the reconcile has no stored side to
    // compare against — pruning off the replacement index would delete blobs on the strength of a guess.
    store.set(`${NS}/${A}`, { bytes: Buffer.from('cipher'), mtimeMs: Date.now() - 24 * 60 * 60 * 1000 })
    damaged(Buffer.from(GARBLED))
    await run({ galleryId: GID, index: { v: 1, seq: 1, files: [], folders: [] }, repair: true })
    expect(store.has(`${NS}/${A}`)).toBe(true)
  })

  it('repair is inert against a READABLE stored index — it never bypasses the seq guard', async () => {
    putStored({ v: 1, seq: 5, files: [fileEntry(A)], folders: [] })
    await expect(run({ galleryId: GID, index: { v: 1, seq: 4, files: [], folders: [] }, repair: true }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(storedIndex().seq).toBe(5)
    expect(storedIndex().files).toHaveLength(1)
  })

  it('repair is inert when the read itself FAILED — doubt still refuses', async () => {
    putStored({ v: 1, seq: 9, files: [fileEntry(A)], folders: [] })
    driver = makeDriver({
      get: async () => { throw new Error('timeout') },
      exists: async () => { throw new Error('S3 head failed (500)') },
    })
    await expect(run({ galleryId: GID, index: { v: 1, seq: 2, files: [], folders: [] }, repair: true }))
      .rejects.toMatchObject({ statusCode: 503 })
    expect(storedIndex().seq).toBe(9)
  })
})

describe('secureGalleryTree pipeline — orphan reconcile', () => {
  const old = () => Date.now() - 24 * 60 * 60 * 1000

  it('prunes a stale unreferenced blob when the index does not shrink', async () => {
    store.set(`${NS}/${A}`, { bytes: Buffer.from('live'), mtimeMs: old() })
    store.set(`${NS}/${B}`, { bytes: Buffer.from('stray'), mtimeMs: old() })
    putStored({ v: 1, seq: 1, files: [fileEntry(A)], folders: [] })
    await run({ galleryId: GID, index: { v: 1, seq: 2, files: [fileEntry(A)], folders: [] } })
    expect(store.has(`${NS}/${B}`)).toBe(false)
    expect(store.has(`${NS}/${A}`)).toBe(true)
  })

  it('skips the prune when the incoming index references FEWER blobs than the stored one', async () => {
    // A shrinking index is exactly the clobber signature; deletes remove their own ciphertext explicitly, so
    // sparing the strays here costs nothing but keeps an unnoticed overwrite recoverable.
    store.set(`${NS}/${A}`, { bytes: Buffer.from('a'), mtimeMs: old() })
    store.set(`${NS}/${B}`, { bytes: Buffer.from('b'), mtimeMs: old() })
    putStored({ v: 1, seq: 1, files: [fileEntry(A), fileEntry(B)], folders: [] })
    await run({ galleryId: GID, index: { v: 1, seq: 2, files: [fileEntry(A)], folders: [] } })
    expect(store.has(`${NS}/${B}`)).toBe(true)
  })

  it('skips the prune on a driver that cannot read the index back (the shrink guard has nothing to compare)', async () => {
    driver = makeDriver({ get: undefined })
    store.set(`${NS}/${A}`, { bytes: Buffer.from('a'), mtimeMs: old() })
    store.set(`${NS}/${B}`, { bytes: Buffer.from('b'), mtimeMs: old() })
    putStored({ v: 1, seq: 1, files: [fileEntry(A), fileEntry(B)], folders: [] })
    await run({ galleryId: GID, index: { v: 1, seq: 2, files: [fileEntry(A)], folders: [] } })
    expect(storedIndex().seq).toBe(2)
    expect(store.has(`${NS}/${B}`)).toBe(true)
  })
})
