import { createError } from 'h3'
import { createLocalDriver, createS3Driver, getResolvedKestrelConfig } from '@kestrel/core'
import type { ResolvedImagePolicy, StorageDriver } from '@kestrel/core'

/** The resolved `media` namespace this package reads — the SAME config-provider seam every other package
 *  extraction uses (`@kestrel/core`'s `getResolvedKestrelConfig`), consumed via its own `media` namespace
 *  rather than a second provider. `s3`'s credential fields are optional: they are populated ONLY by a real
 *  Nitro boot's seed (`resolveServerKestrelConfig`, which merges `useRuntimeConfig().media.s3` — the kestrel
 *  module's `KESTREL_S3_*`-at-build-time write, itself overridable at server start via Nitro's
 *  `NUXT_MEDIA_S3_*` env convention, see docs/guide/configuration.md). `resolveKestrel`'s own pure computation
 *  never sets them, so a non-Nitro seed (a package test, a script) leaves them undefined — see
 *  `useStorageDriver`'s fallback below.
 * @public
 */
export interface MediaRuntimeConfig {
  dir: string
  baseUrl: string
  driver: 'local' | 's3'
  maxUploadBytes: number
  allowedMimes: string
  s3: { bucket: string; region: string; endpoint: string; prefix: string; publicBaseUrl: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }
  imagePolicy: ResolvedImagePolicy
}

/** Reads the resolved `media` namespace.
 * @public
 */
export function mediaRuntimeConfig(): MediaRuntimeConfig {
  return getResolvedKestrelConfig().media as MediaRuntimeConfig
}

/** Builds the configured media storage driver (local or S3) from the resolved `media` namespace.
 *
 * S3 credentials: read off the seam's `s3.accessKeyId`/`secretAccessKey`/`sessionToken` first — on a real
 * Nitro boot these are `useRuntimeConfig().media.s3`'s values (build-time `KESTREL_S3_*`, overridable at
 * server start via `NUXT_MEDIA_S3_*`, exactly as docs/guide/configuration.md documents). A raw
 * `process.env.KESTREL_S3_*` read is the fallback ONLY for a seam that never got the runtimeConfig merge
 * (a package test, a script) — it does not, and must not, take precedence over the seeded value on a real
 * boot, or an operator's `NUXT_MEDIA_S3_*` server-start override would be silently ignored.
 * @public
 */
export function useStorageDriver(): StorageDriver {
  const media = mediaRuntimeConfig()
  if (media.driver === 's3') {
    const s = media.s3
    const accessKeyId = s?.accessKeyId ?? process.env.KESTREL_S3_ACCESS_KEY_ID ?? ''
    const secretAccessKey = s?.secretAccessKey ?? process.env.KESTREL_S3_SECRET_ACCESS_KEY ?? ''
    const sessionToken = s?.sessionToken ?? process.env.KESTREL_S3_SESSION_TOKEN
    // publicBaseUrl is required too: without it publicUrl() would emit relative `/key` URLs that resolve
    // against the app origin (which serves no uploads on S3) instead of the bucket/CDN — breaking media.
    if (!s?.bucket || !s.publicBaseUrl || !accessKeyId || !secretAccessKey) {
      throw createError({ statusCode: 500, statusMessage: 'S3 media driver is not configured: bucket, publicBaseUrl, and credentials (KESTREL_S3_ACCESS_KEY_ID / _SECRET_ACCESS_KEY) are required' })
    }
    return createS3Driver({
      bucket: s.bucket,
      region: s.region,
      endpoint: s.endpoint || undefined,
      prefix: s.prefix,
      publicBaseUrl: s.publicBaseUrl,
      accessKeyId,
      secretAccessKey,
      sessionToken: sessionToken || undefined,
    })
  }
  return createLocalDriver({ dir: media.dir, baseUrl: media.baseUrl })
}
