import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { registerEndpoint, mountSuspended } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import SecureGallery from './SecureGallery.vue'
import MediaToolbar from '../../../../../layers/media/app/components/MediaToolbar.vue'
import { generatePassphrase } from '../../utils/passphrase'
import { createGallery } from '../../utils/gallery'
import { encodeIndex, type WorkingModel } from '../../utils/index-codec'
import { authenticateIndex } from '../../utils/index-auth'
import { encryptString } from '../../utils/crypto'
import { sealToB64, type SecureGalleryRef } from '../../utils/manifest'

// Recovering from the two ways a write can find the STORED index unusable: another writer got there first
// (409 → merge) and the stored index is not an index at all (422 → deliberate repair). The endpoint below
// stands in for the real pipeline, which is node-tested in `server/pipelines/tree.test.ts`;
// what is under test here is what the WIDGET does with each answer. The other writer's stored index is built
// with the production codecs (sealed + integrity-tagged under the same key), so the widget sees exactly what
// a second tab would have left behind.
const BASE = '/uploads/galleries-secure/test'
const PW = generatePassphrase()

interface PutBody { index: { seq?: number; files?: unknown[]; folders?: unknown[] }; repair?: boolean }

let stored: Record<string, unknown> | null = null
/** Stored index bytes that are readable but not a parseable index (an interrupted/truncated write). */
let rawIndex: string | null = null
let indexStatus = 200
let bodies: PutBody[] = []
let conflict = false
let damaged = false
let blobN = 0

registerEndpoint('/api/secureGalleryTree', {
  method: 'POST',
  handler: async (event) => {
    const body = await readBody(event) as PutBody
    bodies.push(body)
    if (damaged && body?.repair !== true) {
      throw createError({ statusCode: 422, statusMessage: 'stored gallery index is damaged', data: { repairable: true } })
    }
    if (conflict) throw createError({ statusCode: 409, statusMessage: 'gallery index changed elsewhere' })
    stored = body.index as Record<string, unknown>
    rawIndex = null
    damaged = false
    return { ok: true, base: BASE }
  },
})
registerEndpoint('/api/secureGalleryBase', { method: 'GET', handler: () => ({ base: BASE }) })
registerEndpoint('/api/secureGalleryUpload', {
  method: 'POST',
  handler: () => ({ blobId: `b${++blobN}111111-1111-1111-1111-111111111111.bin` }),
})

let gref: SecureGalleryRef
let gkey: CryptoKey
beforeAll(async () => {
  const g = await createGallery(PW)
  gref = g.ref
  gkey = g.key
}, 60_000)

/** Persist `model` at `seq` the way another tab's write would: sealed leaves + a valid whole-index tag. */
async function storeAs(model: WorkingModel, seq: number) {
  const encoded = await encodeIndex(model, async (s) => sealToB64(await encryptString(gkey, s)))
  stored = await authenticateIndex({ ...encoded, seq }, gkey) as unknown as Record<string, unknown>
}

const file = (blobId: string, name: string, dir = '') =>
  ({ blobId, ivB64: 'AAAAAAAAAAAAAAAA', name, mime: 'image/jpeg', size: 3, dir })

const realFetch = globalThis.fetch
beforeEach(() => {
  stored = null
  rawIndex = null
  indexStatus = 200
  bodies = []
  conflict = false
  damaged = false
  blobN = 0
  window.prompt = () => 'Folder'
  window.confirm = () => true // the rebuild is destructive and asks first
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String((input as Request)?.url ?? input)
    if (url === `${BASE}/index.json`) {
      if (indexStatus !== 200) return new Response('', { status: indexStatus })
      if (rawIndex !== null) return new Response(rawIndex, { status: 200, headers: { 'content-type': 'application/json' } })
      return stored
        ? new Response(JSON.stringify(stored), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })
    }
    if (url.startsWith(BASE)) return new Response('', { status: 404 }) // blob previews — not under test
    return realFetch(input, init)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>

async function click(w: Wrapper, label: string) {
  const btn = w.findAll('button').find((b) => b.text().trim().toLowerCase().includes(label.toLowerCase()))
  expect(btn, `button "${label}"`).toBeTruthy()
  await btn!.trigger('click')
}

const lastBody = () => bodies.at(-1)!

/** Mount on the existing gallery ref and enter its password (the widget starts in the `locked` phase). */
async function mountLocked() {
  const w = await mountSuspended(SecureGallery, { props: { name: 'Gallery', modelValue: gref } })
  await w.find('input[type="password"]').setValue(PW)
  await click(w, 'Unlock')
  return w
}

async function mountUnlocked() {
  const w = await mountLocked()
  await vi.waitFor(() => expect(w.find('input[type="password"]').exists()).toBe(false), { timeout: 30_000 })
  return w
}

/** Encrypt + add one file (the `File[]` the toolbar's input emits) and wait for its index write attempt. */
async function upload(w: Wrapper, filename: string, expectWrites: number) {
  const toolbar = w.findComponent(MediaToolbar)
  expect(toolbar.exists()).toBe(true)
  toolbar.vm.$emit('upload', [new File([new Uint8Array([1, 2, 3])], filename, { type: 'image/jpeg' })])
  await vi.waitFor(() => expect(bodies.length).toBe(expectWrites), { timeout: 20_000 })
}

async function newFolder(w: Wrapper, expectWrites: number) {
  await click(w, 'folder')
  await vi.waitFor(() => expect(bodies.length).toBe(expectWrites), { timeout: 20_000 })
}

describe('SecureGallery merge after a conflict', () => {
  it('re-applies only what this tab minted — an entry deleted elsewhere stays deleted', async () => {
    await storeAs({ files: [file('gone.bin', 'gone.jpg')], folders: [] }, 5)
    const w = await mountUnlocked()
    expect(w.text()).toContain('gone.jpg')
    // The other tab deletes that photo: its entry leaves the stored index and its ciphertext goes with it.
    await storeAs({ files: [], folders: [] }, 6)

    conflict = true
    await upload(w, 'kept.jpg', 1) // 409 — this entry's ivB64 + sealed name exist only in this tab
    await vi.waitFor(() => expect(w.text()).toMatch(/changed elsewhere/i), { timeout: 20_000 })

    conflict = false
    await click(w, 'merge')
    await vi.waitFor(() => expect(bodies.length).toBe(2), { timeout: 20_000 })
    expect(lastBody().index.files).toHaveLength(1) // the unsaved upload only — no resurrected deletion
    expect(w.text()).toContain('kept.jpg')
    expect(w.text()).not.toContain('gone.jpg')
  }, 90_000)

  it('a folder deleted elsewhere is not resurrected by the merge', async () => {
    await storeAs({ files: [], folders: ['Gone'] }, 5)
    const w = await mountUnlocked()
    expect(w.text()).toContain('Gone')
    await storeAs({ files: [], folders: [] }, 6)

    conflict = true
    await upload(w, 'kept.jpg', 1)
    await vi.waitFor(() => expect(w.text()).toMatch(/changed elsewhere/i), { timeout: 20_000 })

    conflict = false
    await click(w, 'merge')
    await vi.waitFor(() => expect(bodies.length).toBe(2), { timeout: 20_000 })
    expect(lastBody().index.folders).toHaveLength(0)
    expect(w.text()).not.toContain('Gone')
  }, 90_000)
})

describe('SecureGallery damaged-index recovery', () => {
  const hasButton = (w: Wrapper, label: RegExp) => w.findAll('button').some((b) => label.test(b.text()))

  it('a merge that finds the stored index damaged routes to the restore, not to a dead end', async () => {
    await storeAs({ files: [], folders: [] }, 5)
    const w = await mountUnlocked()
    conflict = true
    await upload(w, 'kept.jpg', 1)
    await vi.waitFor(() => expect(w.text()).toMatch(/changed elsewhere/i), { timeout: 20_000 })

    // Whatever the other writer left behind is truncated, so there is nothing to merge with.
    conflict = false
    rawIndex = ''
    damaged = true
    await click(w, 'merge')
    await vi.waitFor(() => expect(hasButton(w, /restore/i)).toBe(true), { timeout: 20_000 })
    expect(bodies).toHaveLength(1) // the merge never wrote

    await click(w, 'Restore')
    await vi.waitFor(() => expect(bodies.length).toBe(2), { timeout: 20_000 })
    expect(lastBody().repair).toBe(true)
    expect(lastBody().index.files).toHaveLength(1) // the unsaved upload survived the detour
  }, 90_000)

  it('offers a deliberate rebuild instead of a dead end, and stays locked until it is taken', async () => {
    rawIndex = '' // an interrupted write left a 0-byte index.json
    damaged = true
    const w = await mountLocked()
    await vi.waitFor(() => expect(w.text()).toMatch(/damaged/i), { timeout: 30_000 })
    expect(w.find('input[type="password"]').exists()).toBe(true) // no silent overwrite
    expect(bodies).toHaveLength(0)

    window.confirm = () => false
    await click(w, 'Rebuild')
    expect(bodies).toHaveLength(0) // declining writes nothing
    window.confirm = () => true
    await click(w, 'Rebuild')
    await vi.waitFor(() => expect(bodies.length).toBe(1), { timeout: 20_000 })
    expect(lastBody().repair).toBe(true)
    expect(lastBody().index.seq).toBe(1)
    await vi.waitFor(() => expect(w.find('input[type="password"]').exists()).toBe(false), { timeout: 20_000 })
  }, 90_000)

  it('never offers the rebuild for a TRANSIENT index failure', async () => {
    indexStatus = 500
    const w = await mountLocked()
    await vi.waitFor(() => expect(w.text()).toMatch(/index 500|could not open/i), { timeout: 30_000 })
    expect(w.text()).not.toMatch(/rebuild/i)
    expect(w.find('input[type="password"]').exists()).toBe(true)
  }, 90_000)

  it('an unlocked tab restores ITS OWN model over a damaged stored index', async () => {
    await storeAs({ files: [], folders: [] }, 1)
    const w = await mountUnlocked()
    await upload(w, 'kept.jpg', 1)
    expect(lastBody().index.files).toHaveLength(1)

    damaged = true
    await newFolder(w, 2) // 422 — the stored index is not an index any more
    await vi.waitFor(() => expect(w.text()).toMatch(/damaged/i), { timeout: 20_000 })
    expect(bodies[1]!.repair).toBeUndefined() // never repaired without being asked

    await click(w, 'Restore')
    await vi.waitFor(() => expect(bodies.length).toBe(3), { timeout: 20_000 })
    expect(lastBody().repair).toBe(true)
    expect(lastBody().index.files).toHaveLength(1) // this tab's model, not an empty index
  }, 90_000)
})
