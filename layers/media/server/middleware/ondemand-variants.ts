import type { H3Event } from 'h3'
import { clientIp } from '@kestrel/auth'
import { allowlistMode, ipAllowed, parseAllowlist } from '@kestrel/access'
import { deriveOnDemand, variantKeyFromPath, useStorageDriver, mediaRuntimeConfig, useMediaDb } from '@kestrel/media'
import { DEFAULT_IMAGE_POLICY } from '@kestrel/core'

/**
 * Whether the IP allow-list would deny this request, checked directly rather than relied on by ordering:
 * Nitro sorts middleware by layer scan dir first, and media's precedes access's, so the real
 * access/00.ip-allowlist gate has NOT run yet when this middleware short-circuits with a derived response.
 */
export function deniedByAllowlist(event: H3Event): boolean {
  const mode = allowlistMode(process.env.KESTREL_IP_ALLOWLIST_MODE, process.env.KESTREL_IP_ALLOWLIST)
  if (mode !== 'enforce') return false
  return !ipAllowed(clientIp(event), parseAllowlist(process.env.KESTREL_IP_ALLOWLIST))
}

// Dev only: a GET for a not-yet-generated variant under the media baseUrl derives it from the original and
// serves it, so a newly-declared size/format shows in the editor preview without a full publish. On a hit
// this is a no-op — the static /uploads handler serves the cached file.
export default defineEventHandler(async (event) => {
  if (!import.meta.dev || event.method !== 'GET') return
  if (deniedByAllowlist(event)) return
  const cfg = mediaRuntimeConfig()
  const key = variantKeyFromPath(event.path, cfg.baseUrl)
  if (key == null) return
  const driver = useStorageDriver()
  if (await driver.exists?.(key)) return
  // Dev is the diagnosis environment, so surface a real derive failure (missing original, sharp reject)
  // instead of silently 404ing — a broken preview <img> with no log violates the fail-loud convention.
  const result = await deriveOnDemand(useMediaDb().db, driver, cfg.imagePolicy ?? DEFAULT_IMAGE_POLICY, key).catch((error) => {
    console.warn(`[kestrel] on-demand variant derive failed for ${key}:`, (error as Error)?.message ?? error)
    return null
  })
  if (!result) return
  setResponseHeader(event, 'content-type', result.mime)
  return result.bytes
})
