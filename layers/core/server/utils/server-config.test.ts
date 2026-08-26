import { describe, it, expect, afterEach } from 'vitest'
import { resolveServerKestrelConfig } from './server-config'

const ORIG = { ...process.env }
afterEach(() => {
  process.env = { ...ORIG }
  delete (globalThis as Record<string, unknown>).useRuntimeConfig
})

/**
 * Pins the media namespace's merge precedence: `runtimeConfig.media` (what a real Nitro boot already
 * resolved — the kestrel module's build-time `KESTREL_S3_*` write, itself overridable at server start via
 * Nitro's own `NUXT_MEDIA_S3_*` env convention, see docs/guide/configuration.md) must win over
 * `resolveKestrel`'s own raw-env fallback, which `useStorageDriver` (`@michaelthielemann/kestrel-media`) only reaches when
 * no runtimeConfig was ever seeded (a package test, a script).
 */
describe('resolveServerKestrelConfig — media namespace precedence', () => {
  it('prefers runtimeConfig.media.s3 (the NUXT_-override-resolved value) over raw process.env', () => {
    process.env.KESTREL_S3_ACCESS_KEY_ID = 'raw-env-value'
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({
      media: {
        driver: 's3', maxUploadBytes: 999, allowedMimes: '',
        local: { dir: '/nuxt-dir', baseUrl: '/nuxt-uploads' },
        s3: { bucket: 'nuxt-bucket', region: 'nuxt-region', endpoint: '', prefix: '', publicBaseUrl: 'https://nuxt.example.com', accessKeyId: 'nuxt-resolved-value', secretAccessKey: 'nuxt-secret' },
      },
    })
    const resolved = resolveServerKestrelConfig()
    expect(resolved.media.s3.accessKeyId).toBe('nuxt-resolved-value')
    expect(resolved.media.driver).toBe('s3')
    expect(resolved.media.dir).toBe('/nuxt-dir')
    expect(resolved.media.baseUrl).toBe('/nuxt-uploads')
  })

  it('falls through to the pure resolveKestrel() base — no S3 credentials — when runtimeConfig carries no media namespace', () => {
    delete (globalThis as Record<string, unknown>).useRuntimeConfig
    const resolved = resolveServerKestrelConfig()
    expect(resolved.media.s3.accessKeyId).toBeUndefined()
  })
})
