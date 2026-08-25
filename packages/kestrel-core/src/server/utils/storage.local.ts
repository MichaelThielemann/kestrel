import { mkdir, writeFile, readFile, unlink, access, copyFile, rm, rmdir, readdir, stat, rename } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StorageDriver } from './storage.js'

function joinURL(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

/** Whether an fs error proves the key is not there (missing, or a path component that is not a directory).
 *  Anything else — EACCES, EIO/ESTALE on a network volume — means the driver could not TELL, and callers key
 *  destructive decisions off that difference (the gallery index guard treats "absent" as licence to skip its
 *  concurrency check and prune unreferenced ciphertext), so it must surface instead of reading as absence. */
function provesMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** A `StorageDriver` backed by the local filesystem, rooted at `opts.dir`.
 * @public
 */
export function createLocalDriver(opts: { dir: string; baseUrl: string }): StorageDriver {
  const root = resolve(opts.dir)
  const abs = (key: string) => {
    const path = resolve(root, key)
    if (path !== root && !path.startsWith(root + sep)) {
      throw new Error(`storage key escapes the uploads root: ${key}`)
    }
    return path
  }
  return {
    async put(key, bytes) {
      const path = abs(key)
      await mkdir(dirname(path), { recursive: true })
      // Write to a temp sibling then atomically rename into place: an overwrite (replace-upload, backfill
      // re-put, republished HTML) never exposes a truncated/partial file to a concurrent reader (nginx / the
      // static host), and a crash mid-write leaves the stale temp file, not a corrupt object at the real key.
      const tmp = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(tmp, bytes)
        await rename(tmp, path)
      } catch (error) {
        await unlink(tmp).catch(() => {})
        throw error
      }
    },
    async copy(srcKey, dstKey) {
      const dst = abs(dstKey)
      await mkdir(dirname(dst), { recursive: true })
      await copyFile(abs(srcKey), dst)
    },
    async delete(key, opts) {
      const path = abs(key)
      try { await unlink(path) } catch (error) { if (!provesMissing(error)) throw error }
      // Opt-in (publisher) only: remove parent dirs left empty (up to — never including — the root), so
      // unpublishing `/a/b` leaves no orphan empty `a/b/`. OFF by default so the media library keeps a
      // user-created folder after its last file is deleted. Stops climbing at the first non-empty dir.
      if (!opts?.pruneEmptyDirs) return
      let dir = dirname(path)
      while (dir !== root && dir.startsWith(root + sep)) {
        try { await rmdir(dir) } catch { break } // ENOTEMPTY (still holds files) or already gone → stop
        dir = dirname(dir)
      }
    },
    publicUrl(key) { return joinURL(opts.baseUrl, key) },
    async get(key) {
      // abs() reapplies the escape-guard: an attacker-influenced key must never read outside the root.
      return readFile(abs(key))
    },
    async exists(key) {
      try { await access(abs(key)); return true } catch (error) { if (provesMissing(error)) return false; throw error }
    },
    async stat(key) {
      try { return { mtimeMs: (await stat(abs(key))).mtimeMs } } catch (error) { if (provesMissing(error)) return null; throw error }
    },
    async ensureDir(folder) {
      await mkdir(abs(folder), { recursive: true })
    },
    async removeDir(folder) {
      if (!folder) return
      const path = abs(folder)
      if (path === root) return // never remove the uploads root ('.', 'a/..', etc. resolve to it)
      await rm(path, { recursive: true, force: true })
    },
    async list() {
      // Every file under the root as a sorted POSIX-relative key (the put/delete key space), so the
      // publish reconciler can set-difference against the keys it just wrote and prune the rest.
      const out: string[] = []
      async function walk(dir: string, prefix: string): Promise<void> {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch (error) {
          // A proven-absent dir (an uploads root not built yet, a subtree deleted concurrently) holds no
          // keys. Anything else means the enumeration could not be performed, and callers that delete on
          // the strength of an empty listing (the media removeDir guards) would read that as "nothing is
          // stored here" and recursively wipe a subtree whose contents merely could not be read.
          if (provesMissing(error)) return
          throw error
        }
        for (const e of entries) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name
          if (e.isDirectory()) await walk(resolve(dir, e.name), rel)
          else if (e.isFile()) out.push(rel)
        }
      }
      await walk(root, '')
      return out.sort()
    },
    async listPrefix(prefix) {
      // A namespace listing: every key under `<prefix>/` (normalised). Filters the full walk — fine for the
      // small per-record namespaces this serves. Empty/`.` prefix → all keys (same as list()).
      const all = await this.list!()
      const p = prefix.replace(/^\/+|\/+$/g, '')
      if (!p) return all
      const under = `${p}/`
      return all.filter((k) => k === p || k.startsWith(under))
    },
  }
}
