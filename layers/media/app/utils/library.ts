import type { LibraryFolder } from '../../server/utils/library'

// Re-exported from the server util that produces it (`GET /api/media/library`) so the wire shape is
// single-sourced.
export type { LibraryFolder }

export interface LibraryFile {
  id: number; filename: string; mime: string; folder: string; size: number
  width?: number; height?: number; thumbhash?: string; src: string; srcset?: string; alt?: string
  createdAt?: string
}
export type LibraryItem =
  | { type: 'folder'; folder: LibraryFolder }
  | { type: 'file'; file: LibraryFile }

export function itemKey(item: LibraryItem): string {
  return item.type === 'folder' ? `folder:${item.folder.path}` : `file:${item.file.id}`
}

/** Inclusive range between the anchor and target keys (by position in `orderedKeys`), unioned
 *  onto `current`. If the anchor is not found, selects only the target. */
export function computeRange(orderedKeys: string[], anchorKey: string, targetKey: string, current: Set<string>): Set<string> {
  const out = new Set(current)
  const t = orderedKeys.indexOf(targetKey)
  if (t < 0) return out
  const a = orderedKeys.indexOf(anchorKey)
  if (a < 0) { out.add(targetKey); return out }
  for (let i = Math.min(a, t); i <= Math.max(a, t); i++) out.add(orderedKeys[i])
  return out
}

export function humanizeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** The parent of an internal folder path, or `null` at the root — never above it (no path traversal).
 *  `''` → null (root); `'a'` → `''`; `'a/b'` → `'a'`. */
export function parentFolder(folder: string): string | null {
  if (folder === '') return null
  const i = folder.lastIndexOf('/')
  return i === -1 ? '' : folder.slice(0, i)
}

/** Split a typed folder path into the existing-parent part and the trailing fragment being typed. */
export function splitPathInput(input: string): { parent: string; fragment: string } {
  const i = input.lastIndexOf('/')
  return i === -1 ? { parent: '', fragment: input } : { parent: input.slice(0, i), fragment: input.slice(i + 1) }
}

/** Join folder parts into a clean relative path (drops empty segments). Also parses a typed display
 *  path back to the internal form: `joinFolder('/test123/')` → `'test123'`, `joinFolder('/')` → `''`. */
export function joinFolder(...parts: string[]): string {
  return parts.flatMap((p) => p.split('/')).filter(Boolean).join('/')
}

/** Internal folder path → the slash-delimited path shown to the user, rooted at the media directory:
 *  `''` → `'/'`, `'test123'` → `'/test123/'`, `'a/b'` → `'/a/b/'`. Tolerant of stray slashes in input. */
export function displayFolderPath(folder: string): string {
  const clean = joinFolder(folder)
  return clean === '' ? '/' : `/${clean}/`
}

/** Longest common FOLDER of clean relative paths; '' (root) when they diverge at root or none given.
 *  Keeps only equal leading segments and drops empties, so it can never emit '..' or escape root. */
export function commonFolder(folders: string[]): string {
  if (!folders.length) return ''
  const split = folders.map((f) => f.split('/').filter(Boolean))
  let prefix = split[0]!
  for (const segs of split.slice(1)) {
    let i = 0
    while (i < prefix.length && prefix[i] === segs[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix.length) break
  }
  return prefix.join('/')
}
