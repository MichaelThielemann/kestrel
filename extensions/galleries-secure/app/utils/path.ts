// Folder-path helpers for the gallery's virtual (decrypted) tree. Vendored (not imported from the media
// layer) so the extension's node tests stay self-contained and it composes standalone. Paths are clean
// relative strings ("" = root, "a", "a/b"); these never traverse above the root.

/** Split a path into clean segments: "/a//b/" → ["a","b"]; "" → []. */
export function segments(path: string): string[] {
  return path.split('/').map((s) => s.trim()).filter(Boolean)
}

/** Join parts into a clean relative path, dropping empty segments: joinFolder("a","","b/c") → "a/b/c". */
export function joinFolder(...parts: string[]): string {
  return parts.flatMap((p) => p.split('/')).map((s) => s.trim()).filter(Boolean).join('/')
}

/** Parent of a folder path, or null at/above the root: "" → null, "a" → "", "a/b" → "a". */
export function parentFolder(path: string): string | null {
  if (path === '') return null
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** Whether `path` is `ancestor` itself or nested under it ("a" isAncestorOf "a/b", not "ab"). */
export function isUnder(path: string, ancestor: string): boolean {
  if (ancestor === '') return true
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

/** Immediate child folder paths of `current`, derived from a flat folder list + the dirs files live in.
 *  Synthesizes intermediate ancestors (a file in "a/b/c" implies folders "a", "a/b", "a/b/c"). Sorted. */
export function childFolders(current: string, folderPaths: string[], fileDirs: string[]): string[] {
  const all = new Set<string>()
  for (const p of [...folderPaths, ...fileDirs]) {
    const segs = segments(p)
    for (let i = 1; i <= segs.length; i++) all.add(segs.slice(0, i).join('/'))
  }
  const prefix = current === '' ? '' : `${current}/`
  const depth = current === '' ? 0 : segments(current).length
  const out = new Set<string>()
  for (const p of all) {
    if (!isUnder(p, current) || p === current) continue
    if (segments(p).length !== depth + 1) continue // immediate children only
    if (current === '' ? true : p.startsWith(prefix)) out.add(p)
  }
  return [...out].sort((a, b) => a.localeCompare(b))
}
