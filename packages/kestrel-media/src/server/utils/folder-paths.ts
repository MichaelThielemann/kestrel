/** Parent folder path; '' for a top-level folder; null for the root itself. */
export function parentOf(path: string): string | null {
  if (path === '') return null
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** Every ancestor folder (excluding the path itself and the root ''), root-first. */
export function ancestorsOf(path: string): string[] {
  const out: string[] = []
  const segs = path.split('/').filter(Boolean)
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join('/'))
  return out
}

/** The path plus all its ancestors (excluding root ''), root-first. */
export function selfAndAncestors(path: string): string[] {
  return path === '' ? [] : [...ancestorsOf(path), path]
}

/** True when `path` is exactly one level below `parent`. */
export function isImmediateChild(parent: string, path: string): boolean {
  return parentOf(path) === parent
}

/** Last path segment. */
export function childName(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/** True when `path` is `prefix` itself or a descendant of it (anchored on a '/' boundary). */
export function isUnder(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** Re-base `path` from the `from` subtree onto `to` (path unchanged if not under `from`). */
export function rewritePrefix(path: string, from: string, to: string): string {
  if (path === from) return to
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length)
  return path
}
