import { thumbHashToDataURL } from 'thumbhash'

/**
 * Decode a base64 thumbhash (as stored by the media pipeline, `derive.ts`) to a tiny PNG data URL — or
 * null when absent/malformed. Pure + deterministic. Decoded CLIENT-SIDE only (see `useBlurUp`): the
 * ~6 KB PNG data URL must not be inlined in SSR HTML — the ~30-byte thumbhash string ships in the
 * payload and is inflated here after mount. Never throws — bad input degrades to null (no placeholder).
 */
export function thumbhashToDataUrl(thumbhash: string | null | undefined): string | null {
  if (!thumbhash) return null
  try {
    const bin = atob(thumbhash)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return thumbHashToDataURL(bytes)
  } catch {
    return null
  }
}
