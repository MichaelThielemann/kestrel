import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StorageDriver } from './storage'
import { createLocalDriver } from './storage.local'
import { createS3Driver } from './storage.s3'

// A tiny in-memory S3 (path-style, flat keyspace) so the S3 driver can be exercised against the SAME
// behavioural contract as the local driver — proving the two are interchangeable for the media subsystem.
function s3Emulator() {
  const store = new Map<string, Buffer>()
  const fetchImpl = (async (req: Request): Promise<Response> => {
    const u = new URL(req.url)
    const segs = u.pathname.split('/').filter(Boolean)
    segs.shift() // bucket
    const key = segs.map(decodeURIComponent).join('/')

    if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') ?? ''
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix))
      const xml = '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>'
        + keys.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')
        + '</ListBucketResult>'
      return new Response(xml, { status: 200 })
    }
    if (req.method === 'POST' && u.searchParams.has('delete')) {
      const body = await req.text()
      for (const m of body.matchAll(/<Key>([^<]*)<\/Key>/g)) store.delete(m[1].replace(/&amp;/g, '&'))
      return new Response('<DeleteResult/>', { status: 200 })
    }
    if (req.method === 'PUT') {
      const copySrc = req.headers.get('x-amz-copy-source')
      if (copySrc) {
        const src = copySrc.split('/').filter(Boolean).slice(1).map(decodeURIComponent).join('/')
        const data = store.get(src)
        if (!data) return new Response('NoSuchKey', { status: 404 })
        store.set(key, data)
        return new Response('<CopyObjectResult/>', { status: 200 })
      }
      store.set(key, Buffer.from(await req.arrayBuffer()))
      return new Response('', { status: 200 })
    }
    if (req.method === 'GET') {
      const data = store.get(key)
      return data ? new Response(data, { status: 200 }) : new Response('NoSuchKey', { status: 404 })
    }
    // Real S3 answers HEAD with Last-Modified; the driver derives the object age from it.
    if (req.method === 'HEAD') {
      return store.has(key)
        ? new Response(null, { status: 200, headers: { 'last-modified': new Date().toUTCString() } })
        : new Response(null, { status: 404 })
    }
    if (req.method === 'DELETE') { store.delete(key); return new Response(null, { status: 204 }) }
    return new Response('unexpected', { status: 400 })
  }) as typeof fetch
  return { store, fetchImpl }
}

const tmpDirs: string[] = []
/** Dirs made unreadable by a fixture — readable again before the tree is removed. */
const lockedDirs: string[] = []
afterAll(() => {
  lockedDirs.forEach((d) => { try { chmodSync(d, 0o700) } catch { /* already gone */ } })
  tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const s3Opts = { bucket: 'b', publicBaseUrl: 'https://cdn.example.com', accessKeyId: 'AK', secretAccessKey: 'SK' }

/** A driver whose probe of `key` FAILS at the storage layer — the object may well be there, the driver just
 *  cannot tell. Local: a symlink cycle (ELOOP from access/stat). S3: a bucket answering 500 to the HEAD. */
type FaultyProbe = () => Promise<{ d: StorageDriver; key: string }>

/** A driver whose ENUMERATION of `prefix` fails at the storage layer — objects are stored under it, the
 *  driver just cannot list them. Local: an unreadable directory (EACCES). S3: a bucket answering 500 to LIST. */
type FaultyList = () => Promise<{ d: StorageDriver; prefix: string }>

const txt = (s: string) => Buffer.from(s)

const drivers: Array<[string, () => StorageDriver, FaultyProbe, FaultyList]> = [
  ['local', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-contract-'))
    tmpDirs.push(dir)
    return createLocalDriver({ dir, baseUrl: '/uploads' })
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-contract-fault-'))
    tmpDirs.push(dir)
    await symlink(join(dir, 'loop-b'), join(dir, 'loop-a'))
    await symlink(join(dir, 'loop-a'), join(dir, 'loop-b'))
    return { d: createLocalDriver({ dir, baseUrl: '/uploads' }), key: 'loop-a' }
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-contract-list-fault-'))
    tmpDirs.push(dir)
    const d = createLocalDriver({ dir, baseUrl: '/uploads' })
    await d.put('photos/not-a-media-row.bin', txt('x'), 'application/octet-stream')
    await chmod(join(dir, 'photos'), 0o000)
    lockedDirs.push(join(dir, 'photos'))
    return { d, prefix: 'photos' }
  }],
  ['s3', () => createS3Driver(s3Opts, s3Emulator().fetchImpl), async () => {
    const { fetchImpl } = s3Emulator()
    const faulty = (async (req: Request) =>
      new URL(req.url).pathname.endsWith('/boom.txt') ? new Response(null, { status: 500 }) : fetchImpl(req)) as typeof fetch
    return { d: createS3Driver(s3Opts, faulty), key: 'boom.txt' }
  }, async () => {
    const { store, fetchImpl } = s3Emulator()
    store.set('photos/not-a-media-row.bin', Buffer.from('x'))
    const faulty = (async (req: Request) =>
      new URL(req.url).searchParams.get('list-type') === '2' ? new Response('boom', { status: 500 }) : fetchImpl(req)) as typeof fetch
    return { d: createS3Driver(s3Opts, faulty), prefix: 'photos' }
  }],
]

for (const [label, make, makeFaultyProbe, makeFaultyList] of drivers) {
  describe(`StorageDriver contract — ${label}`, () => {
    it('exists is false before put, true after', async () => {
      const d = make()
      expect(await d.exists!('x/a.txt')).toBe(false)
      await d.put('x/a.txt', txt('hi'), 'text/plain')
      expect(await d.exists!('x/a.txt')).toBe(true)
    })

    it('delete removes the object; deleting a missing key is a no-op', async () => {
      const d = make()
      await d.put('x/a.txt', txt('hi'), 'text/plain')
      await d.delete('x/a.txt')
      expect(await d.exists!('x/a.txt')).toBe(false)
      await expect(d.delete('never-existed.txt')).resolves.toBeUndefined()
    })

    it('copy duplicates the object, leaving the source intact', async () => {
      const d = make()
      await d.put('a/src.txt', txt('hi'), 'text/plain')
      await d.copy('a/src.txt', 'b/c/dst.txt')
      expect(await d.exists!('a/src.txt')).toBe(true)
      expect(await d.exists!('b/c/dst.txt')).toBe(true)
    })

    it('removeDir clears a subtree but spares prefix-collision siblings and outside keys', async () => {
      const d = make()
      await d.put('a/1.txt', txt('1'), 'text/plain')
      await d.put('a/b/2.txt', txt('2'), 'text/plain')
      await d.put('ab/3.txt', txt('3'), 'text/plain') // prefix collision: 'ab' starts with 'a' but is a sibling
      await d.put('c/4.txt', txt('4'), 'text/plain')
      await d.removeDir!('a')
      expect(await d.exists!('a/1.txt')).toBe(false)
      expect(await d.exists!('a/b/2.txt')).toBe(false)
      expect(await d.exists!('ab/3.txt')).toBe(true)
      expect(await d.exists!('c/4.txt')).toBe(true)
    })

    it('removeDir("") removes nothing', async () => {
      const d = make()
      await d.put('a/1.txt', txt('1'), 'text/plain')
      await d.removeDir!('')
      expect(await d.exists!('a/1.txt')).toBe(true)
    })

    it('listPrefix returns only keys under the prefix (relative to root), sparing siblings', async () => {
      const d = make()
      await d.put('a/1.txt', txt('1'), 'text/plain')
      await d.put('a/b/2.txt', txt('2'), 'text/plain')
      await d.put('ab/3.txt', txt('3'), 'text/plain') // prefix-collision sibling
      await d.put('c/4.txt', txt('4'), 'text/plain')
      const under = (await d.listPrefix!('a')).sort()
      expect(under).toEqual(['a/1.txt', 'a/b/2.txt'])
    })

    it('put accepts an optional cache-control without changing the stored object', async () => {
      const d = make()
      await d.put('cc/a.txt', txt('hi'), 'text/plain', { cacheControl: 'public, max-age=0, must-revalidate' })
      expect(await d.exists!('cc/a.txt')).toBe(true)
    })

    it('get returns the exact bytes that were put (byte-read for backfill/GC re-derive)', async () => {
      const d = make()
      await d.put('g/a.bin', txt('hello-bytes'), 'application/octet-stream')
      const got = await d.get!('g/a.bin')
      expect(Buffer.isBuffer(got)).toBe(true)
      expect(got.toString()).toBe('hello-bytes')
    })

    it('get of a missing key rejects (a read has no object to fall back to, unlike idempotent delete)', async () => {
      const d = make()
      await expect(d.get!('g/missing.bin')).rejects.toThrow()
    })

    it('exists/stat REJECT a failed probe rather than reporting the key absent', async () => {
      // Callers read a plain false/null as proof that nothing is stored (the gallery index guard skips its
      // seq check and lets the orphan prune run on it), so "I could not tell" must stay distinguishable.
      const { d, key } = await makeFaultyProbe()
      await expect(d.exists!(key)).rejects.toThrow()
      await expect(d.stat!(key)).rejects.toThrow()
    })

    it('list/listPrefix REJECT a failed enumeration rather than reporting the store empty', async () => {
      // The media delete/relocate guards read an empty listing as "nothing unmanaged lives under this path"
      // and follow it with a recursive removeDir, so an enumeration that could not be performed must never
      // be indistinguishable from one that found nothing.
      const { d, prefix } = await makeFaultyList()
      await expect(d.listPrefix!(prefix)).rejects.toThrow()
      await expect(d.list!()).rejects.toThrow()
    })

    it('list/listPrefix report a store that holds nothing as empty', async () => {
      const d = make()
      expect(await d.list!()).toEqual([])
      expect(await d.listPrefix!('photos')).toEqual([])
    })

    it('stat of a stored object reports its age; an age the store cannot supply is null, never epoch 0', async () => {
      // The gallery orphan prune spares blobs younger than a grace window. A 0 reads as 1970 — i.e. ancient —
      // and would delete a just-uploaded blob whose plaintext exists only in the uploading tab.
      const d = make()
      await d.put('age/a.bin', txt('x'), 'application/octet-stream')
      const s = await d.stat!('age/a.bin')
      expect(s).not.toBeNull()
      expect(s!.mtimeMs === null || s!.mtimeMs > Date.now() - 60_000).toBe(true)
    })

    it('publicUrl returns a string containing the key', () => {
      expect(make().publicUrl('a/b.webp')).toContain('a/b.webp')
    })
  })
}
