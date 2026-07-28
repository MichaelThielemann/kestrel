import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { registerEndpoint, mountSuspended } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import SecureGallery from './SecureGallery.vue'
import MediaToolbar from '../../../../../layers/media/app/components/MediaToolbar.vue'
import { generatePassphrase } from '../../utils/passphrase'

// The index is written WHOLE from the in-memory model, so a second tab holding a stale model must not be
// able to overwrite it. The widget carries the loaded index's `seq` and every write advances it; the server
// refuses a non-advancing write with 409.
const BASE = '/uploads/galleries-secure/test'
const PW = generatePassphrase()

let stored: Record<string, unknown> | null = null
const seqs: unknown[] = []
let conflict = false

registerEndpoint('/api/galleries-secure/tree', {
  method: 'PUT',
  handler: async (event) => {
    const body = await readBody(event)
    seqs.push(body?.index?.seq)
    if (conflict) throw createError({ statusCode: 409, statusMessage: 'gallery index changed elsewhere' })
    stored = body.index
    return { ok: true, base: BASE }
  },
})
registerEndpoint('/api/galleries-secure/base', { method: 'GET', handler: () => ({ base: BASE }) })
registerEndpoint('/api/galleries-secure/upload', { method: 'POST', handler: () => ({ blobId: 'b1111111-1111-1111-1111-111111111111.bin' }) })

const realFetch = globalThis.fetch
beforeEach(() => {
  stored = null
  seqs.length = 0
  conflict = false
  window.prompt = () => 'Folder'
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String((input as Request)?.url ?? input)
    if (url === `${BASE}/index.json`) {
      return stored
        ? new Response(JSON.stringify(stored), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })
    }
    if (url.startsWith(BASE)) return new Response('', { status: 404 }) // blob previews — not under test
    return realFetch(input, init)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

/** Mount, fill the create form with a strong passphrase, and wait for the initial index write. */
async function createGallery() {
  const w = await mountSuspended(SecureGallery, { props: { name: 'Gallery', modelValue: null } })
  const inputs = w.findAll('input[type="password"]')
  await inputs[0]!.setValue(PW)
  await inputs[1]!.setValue(PW)
  await click(w, 'Create')
  await vi.waitFor(() => expect(seqs.length).toBe(1), { timeout: 20_000 })
  return w
}

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
async function click(w: Wrapper, label: string) {
  const btn = w.findAll('button').find((b) => b.text().trim().toLowerCase().includes(label.toLowerCase()))
  expect(btn, `button "${label}"`).toBeTruthy()
  await btn!.trigger('click')
}

/** Encrypt + add one file, the same `File[]` payload the toolbar's file input emits. Its `ivB64` + sealed
 *  name are minted here and exist ONLY in the widget's memory until an index write lands. */
function upload(w: Wrapper, filename: string) {
  const toolbar = w.findComponent(MediaToolbar)
  expect(toolbar.exists()).toBe(true)
  toolbar.vm.$emit('upload', [new File([new Uint8Array([1, 2, 3])], filename, { type: 'image/jpeg' })])
}

/** Persist once more via the "New folder" toolbar action (window.prompt is stubbed). */
async function newFolder(w: Wrapper, expectWrites: number) {
  await click(w, 'folder')
  await vi.waitFor(() => expect(seqs.length).toBe(expectWrites), { timeout: 20_000 })
}

describe('SecureGallery index versioning', () => {
  it('the first index write carries seq 1 and each further write advances it', async () => {
    const w = await createGallery()
    expect(seqs[0]).toBe(1)
    await newFolder(w, 2)
    expect(seqs[1]).toBe(2)
    await newFolder(w, 3)
    expect(seqs[2]).toBe(3)
  })

  it('unlocking an existing gallery resumes from the STORED seq (never restarts at 1)', async () => {
    const w = await createGallery()
    await newFolder(w, 2)
    await newFolder(w, 3)
    await click(w, 'Lock')
    const input = w.find('input[type="password"]')
    await input.setValue(PW)
    await click(w, 'Unlock')
    await vi.waitFor(() => expect(w.find('input[type="password"]').exists()).toBe(false), { timeout: 20_000 })
    await newFolder(w, 4)
    expect(seqs[3]).toBe(4)
  }, 30_000)

  it('a 409 reports the conflict without retrying/clobbering — and without dropping the in-memory model', async () => {
    const w = await createGallery()
    conflict = true
    upload(w, 'kept.jpg')
    await vi.waitFor(() => expect(w.text()).toMatch(/changed elsewhere/i), { timeout: 20_000 })
    expect(seqs.length).toBe(2) // no retry with a bumped seq
    // The rejected write is the ONLY place this upload's ivB64 + sealed name exist. Discarding them (as
    // locking does) leaves its ciphertext permanently undecryptable and due for the orphan prune.
    expect(w.find('input[type="password"]').exists()).toBe(false) // still unlocked
    expect(w.text()).toContain('kept.jpg')
  })

  it('the conflict is resolved by merging the stored index with what only this tab holds', async () => {
    const w = await createGallery()
    conflict = true
    upload(w, 'kept.jpg')
    await vi.waitFor(() => expect(w.text()).toMatch(/changed elsewhere/i), { timeout: 20_000 })
    conflict = false
    await click(w, 'merge')
    await vi.waitFor(() => expect(seqs.length).toBe(3), { timeout: 20_000 })
    expect(seqs[2]).toBe(2) // resumes from the seq the reloaded index actually carries
    expect((stored as { files?: unknown[] } | null)?.files).toHaveLength(1)
    await vi.waitFor(() => expect(w.text()).not.toMatch(/changed elsewhere/i))
  })
})
