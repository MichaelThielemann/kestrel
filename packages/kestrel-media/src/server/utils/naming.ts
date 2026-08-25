/** Strips path segments and unsafe characters from a client-supplied filename, falling back to `'file'`.
 * @public
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/ /g, '_').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 120)
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file'
  return cleaned
}

/** The last extension of a filename (no leading dot), or '' when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

/** Sanitize `name` and force its extension to `ext` (drops any client-supplied extension).
 *  The stored extension must follow the authenticated content type, never the upload filename. */
export function withExtension(name: string, ext: string): string {
  const cleaned = sanitizeFilename(name)
  const dot = cleaned.lastIndexOf('.')
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
  return ext ? `${stem}.${ext}` : stem
}

/** Safe relative folder: drops `.`/`..` segments (no traversal) and cleans each segment.
 *  Deliberately NOT length-capped: truncating would silently map two distinct folders onto one
 *  storage path. An unusable path is caught where it is created — folders.post.ts runs `ensureDir`
 *  before committing the row, so an over-long name fails there instead of stranding a row. */
export function sanitizeFolder(folder: string): string {
  return folder
    .split(/[/\\]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => seg.replace(/ /g, '_').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_'))
    .filter((seg) => seg.length > 0)
    .join('/')
}

/** Joins a sanitized folder and filename into a storage key.
 * @public
 */
export function buildKey(folder: string, filename: string): string {
  const f = sanitizeFolder(folder)
  return f ? `${f}/${filename}` : filename
}

/** Finds a free filename by appending `-2`, `-3`, ... before the extension until `isFree` accepts one.
 * @public
 */
export function suggestFreeName(filename: string, isFree: (name: string) => boolean): string {
  if (isFree(filename)) return filename
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  for (let i = 2; i < 10000; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (isFree(candidate)) return candidate
  }
  throw new Error('no free filename found')
}
