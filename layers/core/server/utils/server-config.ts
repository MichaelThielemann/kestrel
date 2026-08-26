import kestrelConfig from '../../../../kestrel.config'
import { resolveKestrel, type ResolvedKestrel } from '@michaelthielemann/kestrel-core'

/**
 * The Nitro runtimeConfig, or `undefined` for non-Nitro callers (node scripts, build) so they don't
 * throw on `useRuntimeConfig()`. Server utils prefer the values the kestrel module put here (from the
 * consumer's `kestrel: {}`), falling back to `resolveServerKestrel()` when it isn't populated.
 */
export function serverRuntimeConfig(): { kestrel?: Record<string, unknown>; media?: Record<string, unknown>; public?: Record<string, unknown> } | undefined {
  return typeof useRuntimeConfig === 'function'
    ? (useRuntimeConfig() as { kestrel?: Record<string, unknown>; media?: Record<string, unknown>; public?: Record<string, unknown> })
    : undefined
}

/** Resolve Kestrel's own config file + env — the fallback when runtimeConfig isn't populated. */
export function resolveServerKestrel(): ReturnType<typeof resolveKestrel> {
  return resolveKestrel(kestrelConfig, process.env, process.cwd())
}

/**
 * The full `ResolvedKestrel` shape, merging every server util's own `runtimeConfig ?? resolveServerKestrel()`
 * precedence into ONE call — the boot-time config-wiring plugin (`00.config.ts`) calls this once and
 * pushes the result into the (eventually package-side) config provider, so package code never calls
 * `useRuntimeConfig()` itself. Per-field precedence matches each field's existing reader exactly (the
 * kestrel module writes a CLOSED set of fields into `runtimeConfig.kestrel`/`.public` — see
 * `layers/core/modules/kestrel/index.ts`; anything it doesn't write there falls through to the
 * `resolveServerKestrel()` base for every reader, unchanged from before this function existed).
 */
export function resolveServerKestrelConfig(): ResolvedKestrel {
  const rc = serverRuntimeConfig()
  const fallback = resolveServerKestrel()
  const srv = (rc?.kestrel ?? {}) as Partial<Record<string, unknown>>
  const pub = rc?.public as { locales?: string[]; primaryLocale?: string; prefixPrimary?: boolean } | undefined
  // `runtimeConfig.media` is a TOP-LEVEL key (sibling to `.kestrel`/`.public`, not nested under `.kestrel`
  // — see `layers/core/modules/kestrel/index.ts`'s `rc.media = {...}`), and it is the ONLY place the S3
  // credentials + every Nitro `NUXT_MEDIA_*`/`NUXT_MEDIA_S3_*` env override (docs/guide/configuration.md) ever
  // land — `resolveKestrel`'s own pure computation never sees them. Merged in wholesale (undefined ⇒ the
  // module never ran ⇒ fall through to the pure fallback), mirroring `output`'s existing merge below.
  const rcMedia = rc?.media as {
    driver?: string
    maxUploadBytes?: number
    allowedMimes?: string
    imagePolicy?: ResolvedKestrel['media']['imagePolicy']
    local?: { dir?: string; baseUrl?: string }
    s3?: { bucket?: string; region?: string; endpoint?: string; prefix?: string; publicBaseUrl?: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }
  } | undefined
  // The locale trio is populated together or not at all (see `locale.ts`'s original `resolved()`) — a
  // partial `runtimeConfig.public` (e.g. `locales` present but `primaryLocale` absent) falls through to
  // the fallback for all three rather than mixing sources mid-trio.
  const locale = pub?.locales?.length && pub.primaryLocale
    ? { supportedLocales: pub.locales, primaryLocale: pub.primaryLocale, prefixPrimary: pub.prefixPrimary === true }
    : { supportedLocales: fallback.supportedLocales, primaryLocale: fallback.primaryLocale, prefixPrimary: fallback.prefixPrimary }
  return {
    ...fallback,
    ...locale,
    dbPath: (srv.dbPath as string | undefined) ?? fallback.dbPath,
    siteUrl: (srv.siteUrl as string | undefined) ?? fallback.siteUrl,
    siteName: (srv.siteName as string | undefined) ?? fallback.siteName,
    siteDescription: (srv.siteDescription as string | undefined) ?? fallback.siteDescription,
    media: rcMedia ? {
      dir: rcMedia.local?.dir ?? fallback.media.dir,
      baseUrl: rcMedia.local?.baseUrl ?? fallback.media.baseUrl,
      driver: (rcMedia.driver as 'local' | 's3' | undefined) ?? fallback.media.driver,
      maxUploadBytes: rcMedia.maxUploadBytes ?? fallback.media.maxUploadBytes,
      allowedMimes: rcMedia.allowedMimes ?? fallback.media.allowedMimes,
      imagePolicy: rcMedia.imagePolicy ?? fallback.media.imagePolicy,
      s3: { ...fallback.media.s3, ...rcMedia.s3 },
    } : fallback.media,
    collections: (srv.collections as ResolvedKestrel['collections'] | undefined) ?? fallback.collections,
    aiDisclosure: (srv.aiDisclosure as ResolvedKestrel['aiDisclosure'] | undefined) ?? fallback.aiDisclosure,
    seo: (srv.seo as ResolvedKestrel['seo'] | undefined) ?? fallback.seo,
    delivery: (srv.delivery as ResolvedKestrel['delivery'] | undefined) ?? fallback.delivery,
    deliveryExempt: (srv.deliveryExempt as string[] | undefined) ?? fallback.deliveryExempt,
    output: (srv.output as ResolvedKestrel['output'] | undefined) ?? fallback.output,
    // `revisions` is NOT written into `runtimeConfig.kestrel` by the module today (pre-existing —
    // unrelated to this seam), so this reads as `fallback.revisions` in every real boot right now; kept
    // symmetric with every other field rather than special-cased, so a future module fix (writing
    // `srv.revisions`) is picked up here for free.
    revisions: (srv.revisions as ResolvedKestrel['revisions'] | undefined) ?? fallback.revisions,
  }
}
