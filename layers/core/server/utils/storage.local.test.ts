import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalDriver } from './storage.local'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-media-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('LocalDriver', () => {
  const d = createLocalDriver({ dir, baseUrl: '/uploads' })
  it('put writes bytes at the key path (creating nested dirs) and exists reports it', async () => {
    await d.put('seite-a/hero.webp', Buffer.from('abc'), 'image/webp')
    expect(readFileSync(join(dir, 'seite-a/hero.webp')).toString()).toBe('abc')
    expect(await d.exists!('seite-a/hero.webp')).toBe(true)
    expect(await d.exists!('nope.webp')).toBe(false)
  })
  it('overwrite replaces the object atomically and leaves no .tmp residue behind', async () => {
    await d.put('atomic/f.bin', Buffer.from('first-version'), 'application/octet-stream')
    await d.put('atomic/f.bin', Buffer.from('v2'), 'application/octet-stream')
    expect(readFileSync(join(dir, 'atomic/f.bin')).toString()).toBe('v2')
    expect(readdirSync(join(dir, 'atomic')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
  it('put accepts (and ignores) an optional options arg — disk files carry no cache headers', async () => {
    await d.put('opt/x.txt', Buffer.from('y'), 'text/plain', { cacheControl: 'public, max-age=0, must-revalidate' })
    expect(readFileSync(join(dir, 'opt/x.txt')).toString()).toBe('y')
  })
  it('publicUrl joins baseUrl + key (no I/O)', () => {
    expect(d.publicUrl('seite-a/hero.webp')).toBe('/uploads/seite-a/hero.webp')
  })
  it('delete removes the object', async () => {
    await d.put('x/y.bin', Buffer.from('1'), 'application/octet-stream')
    await d.delete('x/y.bin')
    expect(await d.exists!('x/y.bin')).toBe(false)
  })
  it('delete with pruneEmptyDirs removes now-empty parents (no orphan folder after unpublish), keeping non-empty ones + the root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-del-'))
    const d = createLocalDriver({ dir, baseUrl: '/u' })
    // Unpublishing a page deletes <path>/index.html — the now-empty <path>/ must not linger.
    await d.put('hello-my-world/index.html', Buffer.from('<h1>'), 'text/html')
    await d.delete('hello-my-world/index.html', { pruneEmptyDirs: true })
    expect(existsSync(join(dir, 'hello-my-world'))).toBe(false)
    expect(existsSync(dir)).toBe(true) // never the root
    // A sibling page keeps the shared parent dir alive.
    await d.put('blog/a/index.html', Buffer.from('a'), 'text/html')
    await d.put('blog/b/index.html', Buffer.from('b'), 'text/html')
    await d.delete('blog/a/index.html', { pruneEmptyDirs: true })
    expect(existsSync(join(dir, 'blog/a'))).toBe(false)
    expect(existsSync(join(dir, 'blog'))).toBe(true) // still holds b/
    expect(existsSync(join(dir, 'blog/b/index.html'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
  it('delete WITHOUT pruneEmptyDirs leaves the folder (media library keeps user folders)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-del2-'))
    const d = createLocalDriver({ dir, baseUrl: '/u' })
    await d.put('pics/only.webp', Buffer.from('x'), 'image/webp')
    await d.delete('pics/only.webp')
    expect(existsSync(join(dir, 'pics/only.webp'))).toBe(false)
    expect(existsSync(join(dir, 'pics'))).toBe(true) // folder preserved
    rmSync(dir, { recursive: true, force: true })
  })
  it('rejects a key that escapes the uploads root (defense in depth)', async () => {
    await expect(d.put('../escape.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow(/escapes/)
  })
  it('get reads back the bytes; a key escaping the uploads root is rejected (path-traversal read)', async () => {
    await d.put('read/back.bin', Buffer.from('roundtrip'), 'application/octet-stream')
    expect((await d.get!('read/back.bin')).toString()).toBe('roundtrip')
    await expect(d.get!('../../etc/passwd')).rejects.toThrow(/escapes/)
  })
  it('copy duplicates an object to a new key (creating subdirs), leaving the source', async () => {
    await d.put('a/src.txt', Buffer.from('hello'), 'text/plain')
    await d.copy('a/src.txt', 'b/c/dst.txt')
    expect(await d.exists!('a/src.txt')).toBe(true)
    expect(await d.exists!('b/c/dst.txt')).toBe(true)
  })
  it('copy rejects a destination key that escapes the uploads root', async () => {
    await d.put('x.txt', Buffer.from('x'), 'text/plain')
    await expect(d.copy('x.txt', '../escape.txt')).rejects.toThrow(/escapes/)
  })
})

describe('LocalDriver probe + delete failure reporting', () => {
  it('exists/stat report a genuinely missing key as absent (including a non-directory parent)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-probe-'))
    const d = createLocalDriver({ dir, baseUrl: '/u' })
    expect(await d.exists!('nope.bin')).toBe(false)
    expect(await d.stat!('nope.bin')).toBe(null)
    await d.put('a-file.bin', Buffer.from('x'), 'application/octet-stream')
    expect(await d.exists!('a-file.bin/child.bin')).toBe(false) // ENOTDIR: it cannot exist
    expect(await d.stat!('a-file.bin/child.bin')).toBe(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('exists/stat REJECT when the probe itself fails, instead of reporting the key absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-probe-fail-'))
    const d = createLocalDriver({ dir, baseUrl: '/u' })
    // A symlink cycle is a deterministic stand-in for the transient faults a network volume raises
    // (ESTALE/EIO): the object may well be there, the driver simply cannot tell. Callers turn a plain
    // false/null into "there is nothing stored" and disarm data-destroying safeguards on it.
    await symlink(join(dir, 'loop-b'), join(dir, 'loop-a'))
    await symlink(join(dir, 'loop-a'), join(dir, 'loop-b'))
    await expect(d.exists!('loop-a')).rejects.toThrow(/ELOOP/)
    await expect(d.stat!('loop-a')).rejects.toThrow(/ELOOP/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('delete is a no-op for an already-gone key but REJECTS when the removal actually fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-del-fail-'))
    const d = createLocalDriver({ dir, baseUrl: '/u' })
    await expect(d.delete('never-existed.bin')).resolves.toBeUndefined()
    await mkdir(join(dir, 'a-dir'))
    // Claiming success for a removal that did not happen lets a caller drop the last reference to bytes
    // that are still on disk (media GC, the gallery orphan reconcile).
    await expect(d.delete('a-dir')).rejects.toThrow()
    expect(existsSync(join(dir, 'a-dir'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('LocalDriver ensureDir/removeDir', () => {
  it('ensureDir creates nested dirs idempotently; removeDir clears a subtree but never the root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-dir-'))
    const d = createLocalDriver({ dir, baseUrl: '/u' })
    await d.ensureDir!('a/b/c')
    expect(existsSync(join(dir, 'a/b/c'))).toBe(true)
    await d.ensureDir!('a/b/c') // idempotent, no throw
    await d.removeDir!('') // root guard → no-op
    expect(existsSync(dir)).toBe(true)
    await d.removeDir!('.') // resolves to root → must NOT rm the uploads root
    await d.removeDir!('a/..') // also resolves to root
    expect(existsSync(join(dir, 'a/b/c'))).toBe(true) // tree untouched by the root-resolving calls
    await d.removeDir!('a/b')
    expect(existsSync(join(dir, 'a/b'))).toBe(false)
    expect(existsSync(join(dir, 'a'))).toBe(true)
    await d.removeDir!('does/not/exist') // absent → no throw (force)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('LocalDriver list', () => {
  it('lists every file as a sorted POSIX-relative key (recursing dirs); [] for an empty/missing root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-list-'))
    const d = createLocalDriver({ dir, baseUrl: '/u' })
    expect(await d.list!()).toEqual([])
    await d.put('_nuxt/app.abc.js', Buffer.from('x'), 'text/javascript')
    await d.put('about/index.html', Buffer.from('<h1>'), 'text/html')
    await d.put('index.html', Buffer.from('<h1>'), 'text/html')
    expect(await d.list!()).toEqual(['_nuxt/app.abc.js', 'about/index.html', 'index.html'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('an uploads root that was never created lists as empty (not an error)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'kestrel-list-missing-'))
    const d = createLocalDriver({ dir: join(parent, 'never-created'), baseUrl: '/u' })
    expect(await d.list!()).toEqual([])
    expect(await d.listPrefix!('photos')).toEqual([])
    rmSync(parent, { recursive: true, force: true })
  })
})
