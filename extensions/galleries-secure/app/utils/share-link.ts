/**
 * Parse the gallery password from a URL fragment like `#key=hunter2` (also tolerates extra params, e.g.
 * `#x=1&key=hunter2`, and a missing leading `#`). The URL fragment is NEVER sent to the server, so a
 * "password-in-link" share stays zero-knowledge. Returns null when no `key` is present. Pure → node-tested.
 */
export function parseHashKey(hash: string): string | null {
  const body = hash.replace(/^#/, '')
  for (const part of body.split('&')) {
    const [name, ...rest] = part.split('=')
    if (name === 'key' && rest.length) {
      const raw = rest.join('=')
      // A password with a literal '%' (which browsers don't auto-encode in the fragment) makes
      // decodeURIComponent throw — fall back to the raw value instead of crashing the viewer on mount.
      try { return decodeURIComponent(raw) } catch { return raw }
    }
  }
  return null
}
