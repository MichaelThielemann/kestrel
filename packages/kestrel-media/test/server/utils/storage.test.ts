import { describe, it, expect, afterEach } from 'vitest'
import { DEFAULT_IMAGE_POLICY, getResolvedKestrelConfig, setResolvedKestrelConfig } from '@michaelthielemann/kestrel-core'
import { useStorageDriver } from '../../../src/server/utils/storage.js'

const ORIG_CONFIG = getResolvedKestrelConfig()
const ORIG_ENV = { ...process.env }

function s3Media(s3: Record<string, unknown> = {}) {
  return {
    ...getResolvedKestrelConfig(),
    media: {
      dir: '.data/uploads', baseUrl: '/uploads', driver: 's3' as const,
      maxUploadBytes: 10_000_000, allowedMimes: '', imagePolicy: DEFAULT_IMAGE_POLICY,
      s3: { bucket: 'b', region: 'auto', endpoint: '', prefix: '', publicBaseUrl: 'https://cdn.example.com', ...s3 },
    },
  }
}

afterEach(() => {
  setResolvedKestrelConfig(ORIG_CONFIG)
  process.env = { ...ORIG_ENV }
})

describe('useStorageDriver — S3 credential resolution', () => {
  // The credentials on the config-provider seam's `media.s3` are what a real Nitro boot seeds from
  // `useRuntimeConfig().media.s3` (resolveServerKestrelConfig's merge) — build-time KESTREL_S3_* baked in
  // by the kestrel module, itself overridable at server start via Nitro's NUXT_MEDIA_S3_* convention
  // (docs/guide/configuration.md). This is the pinning test for that precedence: the seam MUST win over a raw
  // process.env read, or an operator's NUXT_MEDIA_S3_* server-start override would be silently ignored.
  it('the seam alone is sufficient — no process.env involvement needed once seeded (the real-boot shape)', () => {
    delete process.env.KESTREL_S3_ACCESS_KEY_ID
    delete process.env.KESTREL_S3_SECRET_ACCESS_KEY
    setResolvedKestrelConfig(s3Media({ accessKeyId: 'seeded-key', secretAccessKey: 'seeded-secret' }))
    expect(() => useStorageDriver()).not.toThrow()
  })

  // The env-var names + fallback path: unset on the seam (the non-Nitro shape — a package test/script,
  // where resolveServerKestrelConfig's runtimeConfig merge never ran) falls back to raw process.env reads
  // under the SAME KESTREL_S3_* names the driver's own error message and docs/guide/configuration.md name.
  it('falls back to process.env.KESTREL_S3_* when the seam carries no credentials', () => {
    setResolvedKestrelConfig(s3Media()) // accessKeyId/secretAccessKey left undefined
    expect(() => useStorageDriver()).toThrowError(/S3 media driver is not configured/)
    process.env.KESTREL_S3_ACCESS_KEY_ID = 'env-key'
    process.env.KESTREL_S3_SECRET_ACCESS_KEY = 'env-secret'
    expect(() => useStorageDriver()).not.toThrow()
  })

  it('reads KESTREL_S3_SESSION_TOKEN as the optional session-token fallback too', () => {
    setResolvedKestrelConfig(s3Media())
    process.env.KESTREL_S3_ACCESS_KEY_ID = 'env-key'
    process.env.KESTREL_S3_SECRET_ACCESS_KEY = 'env-secret'
    process.env.KESTREL_S3_SESSION_TOKEN = 'env-token'
    expect(() => useStorageDriver()).not.toThrow()
  })

  // Empty credentials (seam AND env both absent) must fail closed with the documented 500 — never a
  // driver that silently signs requests with blank keys.
  it('throws "not configured" naming KESTREL_S3_ACCESS_KEY_ID/_SECRET_ACCESS_KEY when both are empty', () => {
    delete process.env.KESTREL_S3_ACCESS_KEY_ID
    delete process.env.KESTREL_S3_SECRET_ACCESS_KEY
    setResolvedKestrelConfig(s3Media())
    expect(() => useStorageDriver()).toThrowError(
      expect.objectContaining({ statusCode: 500, statusMessage: expect.stringContaining('KESTREL_S3_ACCESS_KEY_ID') as unknown as string }),
    )
  })

  it('the seam empty string ("configured but blank") is treated as unconfigured, not masked by a stale env var', () => {
    // A real boot always seeds SOME string (possibly '') once resolveServerKestrelConfig has run — an
    // empty seam value must still fail closed, and must not silently accept a leftover process.env value
    // from a previous test/process (the seam, once seeded, is authoritative; process.env is the fallback
    // for an UNSEEDED seam only, not a second-guess of a seeded-but-empty one).
    process.env.KESTREL_S3_ACCESS_KEY_ID = 'env-key'
    process.env.KESTREL_S3_SECRET_ACCESS_KEY = 'env-secret'
    setResolvedKestrelConfig(s3Media({ accessKeyId: '', secretAccessKey: '' }))
    expect(() => useStorageDriver()).toThrowError(/S3 media driver is not configured/)
  })
})
