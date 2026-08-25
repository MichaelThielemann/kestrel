import { inArray, getTableColumns } from 'drizzle-orm'
import type { MediaDb } from '../db/media-db.js'
import type { ResolvedImagePolicy, VariantFit, StorageDriver  } from '@kestrel/core'
import { media } from '../collections/media.js'
import { deriveImage, RASTER } from './derive.js'

const FITS = new Set<VariantFit>(['cover', 'contain', 'inside', 'outside', 'fill'])

/** The storage key a request addresses, or null when the request is not for media at all: outside the
 *  configured base URL, bare, or carrying a malformed %-escape (which must degrade to a static 404, never
 *  a 500). `baseUrl` is the media base as resolved config holds it — its default is the same `/uploads`.
 * @public
 */
export function variantKeyFromPath(path: string, baseUrl: string | undefined): string | null {
  const base = (baseUrl || '/uploads').replace(/\/+$/, '')
  const clean = path.split('?')[0]!
  if (!clean.startsWith(`${base}/`)) return null
  try {
    return decodeURIComponent(clean.slice(base.length + 1)) || null
  } catch {
    return null
  }
}

/** Inverse of variantName: `w<width>` | `c<w>x<h>[-<fit>]` → the shape to derive, or null for anything else.
 * @public
 */
export function parseVariantName(name: string): { width: number; height: number | null; fit: VariantFit } | null {
  const w = /^w(\d+)$/.exec(name)
  if (w) return { width: +w[1], height: null, fit: 'cover' }
  const c = /^c(\d+)x(\d+)(?:-([a-z]+))?$/.exec(name)
  if (c) {
    const fit = (c[3] ?? 'cover') as VariantFit
    return FITS.has(fit) ? { width: +c[1], height: +c[2], fit } : null
  }
  return null
}

/** A parsed on-demand variant request: which original it derives from, and the requested name/format.
 * @public
 */
export interface VariantRequest { storageKey: string; mime: string; name: string; format: string }

// requestedKey is `<storageKey>-<name>.<format>`; storageKey contains dots and a name may contain '-', so
// resolve the original by trying every '-' split and matching a real media row (longest storageKey wins).
/** Resolves a requested derivative key back to its original media row + the requested name/format.
 * @public
 */
export function resolveVariantRequest(db: MediaDb, requestedKey: string): VariantRequest | null {
  const dot = requestedKey.lastIndexOf('.')
  if (dot < 0) return null
  const format = requestedKey.slice(dot + 1)
  const stem = requestedKey.slice(0, dot)
  const candidates: string[] = []
  for (let i = 1; i < stem.length; i++) if (stem[i] === '-') candidates.push(stem.slice(0, i))
  if (!candidates.length) return null
  const cols = getTableColumns(media) as Record<string, never>
  const rows = db.select({ storageKey: cols.storageKey, mime: cols.mime }).from(media).where(inArray(cols.storageKey, candidates)).all() as { storageKey: string; mime: string }[]
  const match = rows.map((r) => ({ ...r, name: stem.slice(r.storageKey.length + 1), format })).sort((a, b) => b.storageKey.length - a.storageKey.length)[0]
  return match ?? null
}

const MEDIA_CACHE_CONTROL = 'public, max-age=31536000'

// DEV-only: derive one missing variant from the stored original and cache it. Registry-INDEPENDENT (parses
// the name), so a size/format a KestrelImg declares but the scan hasn't registered yet still shows in the
// editor preview without a full publish.
/** Derives one missing variant on the fly from the stored original (dev-only preview path).
 * @public
 */
export async function deriveOnDemand(db: MediaDb, driver: StorageDriver, policy: ResolvedImagePolicy, requestedKey: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const req = resolveVariantRequest(db, requestedKey)
  if (!req || !RASTER.has(req.mime) || (req.format !== 'webp' && req.format !== 'jpeg')) return null
  const shape = parseVariantName(req.name)
  if (!shape || typeof driver.get !== 'function') return null
  const spec = { name: req.name, width: shape.width, height: shape.height, fit: shape.fit, position: 'centre', formats: [req.format] as ('webp' | 'jpeg')[] }
  const v = (await deriveImage(await driver.get(req.storageKey), { ...policy, variants: [spec] })).variants[0]
  if (!v) return null
  await driver.put(requestedKey, v.bytes, v.mime, { cacheControl: MEDIA_CACHE_CONTROL })
  return { bytes: v.bytes, mime: v.mime }
}
