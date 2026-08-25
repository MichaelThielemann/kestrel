import { resolve } from 'node:path'

// The single source of non-auth configuration. Lives in `kestrel.config.ts` (repo root, plain TS so
// it's importable by nuxt.config, drizzle.config AND server utils), surfaced as `kestrel: { … }` in
// nuxt.config. Auth/session settings stay env-only (secrets don't belong in committed config).
/**
 * Non-secret S3 settings (used when `media.driver === 's3'`). The access-key id and secret are
 * deliberately **absent** here — they are env-only (`KESTREL_S3_ACCESS_KEY_ID` /
 * `KESTREL_S3_SECRET_ACCESS_KEY`), read at module setup — unconditionally, whatever the driver — and
 * frozen into `runtimeConfig`, never in committed config.
 * @public
 */
export interface KestrelS3Config {
  /** Target bucket name. */
  bucket?: string
  /** Signing region (default `us-east-1`; use `auto` for Cloudflare R2). */
  region?: string
  /** Custom endpoint origin for S3-compatible services (R2/MinIO); omit for AWS S3. */
  endpoint?: string
  /** Key prefix prepended to every object key (slashes are normalised away). */
  prefix?: string
  /** Public base URL objects are served from (CDN / bucket origin); `publicUrl` joins this + key. */
  publicBaseUrl?: string
}
/** Consumer-facing contract surface: the `kestrel.media` block a consumer declares in `kestrel.config.ts`.
 * @public
 */
export interface KestrelMediaConfig {
  /** Directory uploads are written to AND served from (relative → resolved against the project root). */
  uploadDir?: string
  /** Public URL prefix uploads are served under (default `/uploads`). */
  baseUrl?: string
  driver?: 'local' | 's3'
  maxBytes?: number
  allowedMimes?: string
  s3?: KestrelS3Config
  /** Responsive-image derivation policy. `widths` is the legacy proportional ladder (desugars into
   *  `variants` as `w<width>` webp presets); `variants` is the usage-driven set of named size × format
   *  presets. `variants` is config-only (a structured list doesn't round-trip a scalar/CSV env var); the
   *  quality scalars keep their `KESTREL_MEDIA_IMAGE_*_QUALITY` env overrides. */
  image?: { widths?: number[]; webpQuality?: number; jpegQuality?: number; variants?: VariantSpec[] }
}

/** sharp fit modes for a fixed-box (crop) variant.
 * @public
 */
export type VariantFit = 'cover' | 'contain' | 'inside' | 'outside' | 'fill'
/** Output formats Kestrel emits (WebP + a JPEG fallback).
 * @public
 */
export type VariantFormat = 'webp' | 'jpeg'

/** A single image variant to derive on upload — the authoring shape (config or, later, the registry).
 * @public
 */
export interface VariantSpec {
  /** Stable identifier; the manifest key + object-key stem. Sanitised to `[A-Za-z0-9_-]`. */
  name: string
  /** Target width in px. */
  width: number
  /** Fixed box height (crop). Omitted ⇒ proportional width-only resize (never upscaled). */
  height?: number
  /** Fit for a fixed box (default `cover`). */
  fit?: VariantFit
  /** sharp crop position/gravity for `cover`/`contain` (default `centre`). */
  position?: string
  /** Output formats (default `['webp']`). */
  formats?: VariantFormat[]
}

/** A fully-resolved variant (every field defaulted) threaded to `deriveImage`.
 * @public
 */
export interface ResolvedVariant {
  name: string
  width: number
  /** null ⇒ proportional (no fixed box). */
  height: number | null
  fit: VariantFit
  position: string
  formats: VariantFormat[]
}

/** Resolved responsive-image derivation policy threaded to `deriveImage` on upload.
 * @public
 */
export interface ResolvedImagePolicy {
  /** Legacy proportional widths (kept until every consumer reads `variants`); each is clamped to the source. */
  widths: number[]
  /** WebP encode quality, 1–100. */
  webpQuality: number
  /** JPEG encode quality, 1–100. */
  jpegQuality: number
  /** The variant set to derive: named config presets unioned with the desugared legacy widths (name-deduped). */
  variants: ResolvedVariant[]
  /** The config-authored named presets only (`image.variants`). Explicit, name-referenced declarations that
   *  stay active through usage-driven narrowing — kept separate from the discardable legacy-width ladder. */
  presets: ResolvedVariant[]
}

/** @public */
export const DEFAULT_IMAGE_POLICY: ResolvedImagePolicy = {
  widths: [320, 640, 960, 1280, 1920],
  webpQuality: 78,
  jpegQuality: 80,
  variants: [320, 640, 960, 1280, 1920].map((w): ResolvedVariant => ({
    name: `w${w}`, width: w, height: null, fit: 'cover', position: 'centre', formats: ['webp'],
  })),
  presets: [],
}
/** @public */
export interface KestrelConfig {
  /** SQLite path (relative → resolved against root; `:memory:` passes through). */
  db?: string
  /** Absolute site origin for sitemap `<loc>` + robots `Sitemap:`. */
  siteUrl?: string
  /** Human site name + one-line description for the generated `llms.txt` (AI-agent site map). The name
   *  falls back to the `siteUrl` host. Env: `KESTREL_SITE_NAME` / `KESTREL_SITE_DESCRIPTION`. */
  siteName?: string
  siteDescription?: string
  /** Website/content locales. */
  locales?: string[]
  primaryLocale?: string
  /** Prefix the PRIMARY locale in URLs too (`/en/about` instead of `/about`); default false. When on, the
   *  bare `/` has no page — redirect it to `/<primary>` at the edge. */
  prefixPrimaryLocale?: boolean
  media?: KestrelMediaConfig
  /** Where the published static site is written — both the build-time `nuxt generate` deploy AND the
   *  runtime incremental publisher write here: a local dir (default) or an S3 bucket. S3 credentials are
   *  env-only (`KESTREL_OUTPUT_S3_*`), never in committed config. Separate from `media` (uploads) so the
   *  pages tree and the uploads can target different dirs/buckets. */
  output?: {
    driver?: 'local' | 's3'
    /** Local dir the published static tree (HTML + synced `_nuxt`) is written to (relative → root).
     *  Default `.data/published`. Separate from `media.uploadDir` by design. */
    dir?: string
    /** On-disk source of the built client bundle the publisher mirrors into the output (the running
     *  build's `_nuxt/**` + public assets, relative → root). Default `.output/public`. */
    publicDir?: string
    /** Auto-publish affected pages on every content write (default true). */
    auto?: boolean
    /** Opt out of the save/publish split (ADR-0008): `true` makes every content write republish the pages
     *  it affects — the editor's Publish button then has nothing left to do and is hidden.
     *  Default false: saving writes the DB, publishing writes the static files.
     *  Env `KESTREL_OUTPUT_PUBLISH_ON_SAVE`. */
    publishOnSave?: boolean
    /** Run a FULL reconcile every N minutes (default 0 = off) — self-heals a missed invalidation. */
    reconcileMinutes?: number
    /** Verbose publish logging: emit a timestamped per-route line (rendered / pruned) on each incremental
     *  republish, on top of the summary line. Default false (`KESTREL_OUTPUT_VERBOSE`). */
    verbose?: boolean
    s3?: { bucket?: string; region?: string; endpoint?: string; prefix?: string }
  }
  /** Disable Kestrel's built-in collections (default on). Set in `kestrel: {}` (consumer nuxt.config) or
   *  `kestrel.config.ts`; per-setting env `KESTREL_COLLECTIONS_PAGES` / `_MEDIA` overrides. */
  collections?: { pages?: boolean; media?: boolean }
  /** Search / answer-engine surface. Both flags default to **false** and stay off until a consumer turns
   *  them on: each one publishes something the site did not publish before, and an upgrade must never
   *  start disclosing it. Everything else on this surface (canonical, OG, hreflang, sitemap, robots,
   *  llms.txt, the WebSite/WebPage JSON-LD graph) is unconditional — it only restates what the page head
   *  already says. */
  seo?: {
    /** Offer editors `author` / `publishedDate` / `keywords` on the SEO panel and publish them as
     *  schema.org `author` / `datePublished` / `keywords` (which also promotes the page's JSON-LD node
     *  from `WebPage` to `Article`). Some consumers must not attribute content at all — internal
     *  authorship, confidentiality — so nothing is emitted and the fields are not even shown unless this
     *  is on. Env `KESTREL_SEO_ARTICLE_META`. */
    articleMeta?: boolean
    /** Serve and publish `/llms-full.txt`: the full Markdown body of every published, indexable page in
     *  one file (the llmstxt.org long form). Off by default — it aggregates the whole site into a single
     *  scrapeable artifact, and it reads every page's block content on every publish, which the link-only
     *  `llms.txt` deliberately avoids. Env `KESTREL_SEO_LLMS_FULL`. */
    llmsFull?: boolean
  }
  /** Admin page-builder live preview. `desktopWidth` is the reference viewport width (px) the "Desktop"
   *  preset renders at before the editor's scale-to-fit shrinks it to the pane; default 1440. Env:
   *  `KESTREL_PREVIEW_DESKTOP_WIDTH`. */
  preview?: { desktopWidth?: number }
  /** EU AI Act Art. 50 disclosure fields on media assets — OFF by default. Kestrel only stores/manages
   *  this metadata; it never burns a label/watermark into an image and never auto-emits it into public
   *  output — see docs/guide/ai-disclosure.md. Env: `KESTREL_AI_DISCLOSURE`. */
  aiDisclosure?: { enabled?: boolean }
  /** Revision retention. Default `{ keep: 'all' }` — nothing pruned. `keep` and `maxAgeDays` combine as a
   *  UNION of prunability when both are set (a revision beyond `keep` OR older than `maxAgeDays` is
   *  prunable); the last revision and a tombstone last revision are never pruned, whatever the policy. */
  revisions?: { keep?: number | 'all'; maxAgeDays?: number }
  /** Which DeliveryPort adapter serves published content: `'static'` writes/reads pre-rendered files
   *  (the runtime publisher + build deploy), `'live'` serves published snapshots at request time.
   *  Default `'static'`. Env `KESTREL_DELIVERY` — like every env lever resolved in this file, it is read
   *  once at boot (module setup), not per request: flipping it at runtime needs a restart, not a
   *  request-scoped override.
   *
   *  Switching this does NOT change what the publisher writes: static file generation (`output.*`)
   *  keeps running under `'live'` too — the snapshot store stays the source of truth either way, so
   *  the static output stays cheap to keep around and byte-comparable against the live adapter (see
   *  the delivery parity e2e) whichever mode actually serves traffic. */
  delivery?: 'static' | 'live'
  /** Extra path prefixes the `'live'` catch-all must never answer, beyond its own built-in exemptions
   *  (the admin app, `/api/`, Nitro internals, the preview ticket page, the meta routes). For a consumer
   *  runtime route mounted at the app origin — `/health`, `/feed.xml` — that would otherwise be shadowed
   *  by the catch-all once `delivery: 'live'` is on. Each entry is normalized to a leading AND trailing
   *  slash (`health` and `/health` and `/health/` all become `/health/`) so a prefix match can never
   *  partially match a sibling path the way a bare `/admin` once did (`/admin-guide`). Env
   *  `KESTREL_DELIVERY_EXEMPT`, comma-separated. */
  deliveryExempt?: string[]
}

/** @public */
export interface ResolvedKestrel {
  dbPath: string
  siteUrl: string
  siteName: string
  siteDescription: string
  supportedLocales: string[]
  primaryLocale: string
  prefixPrimary: boolean
  media: {
    dir: string; baseUrl: string; driver: 'local' | 's3'; maxUploadBytes: number; allowedMimes: string
    // Credentials are optional here ON PURPOSE: `resolveKestrel` (this interface's pure computation) never
    // sets them — they are env-only and NUXT_-override-aware, so only the runtimeConfig-merging seed
    // (`resolveServerKestrelConfig`) ever populates them. A package reading this seam falls back to a raw
    // `process.env.KESTREL_S3_*` read for the non-Nitro case (scripts, package tests) where that merge
    // never ran — see @kestrel/media's `useStorageDriver`.
    s3: { bucket: string; region: string; endpoint: string; prefix: string; publicBaseUrl: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }
    imagePolicy: ResolvedImagePolicy
  }
  /** Resolved static-publish target (runtime publisher + build deploy). */
  output: {
    driver: 'local' | 's3'
    dir: string
    publicDir: string
    auto: boolean
    publishOnSave: boolean
    reconcileMinutes: number
    verbose: boolean
    s3: ResolvedS3Settings
  }
  /** Resolved built-in-collection toggles (default on). The register plugin skips a built-in whose flag is false. */
  collections: { pages: boolean; media: boolean }
  /** Resolved answer-engine toggles, both default-off (see `KestrelConfig.seo`). */
  seo: { articleMeta: boolean; llmsFull: boolean }
  /** Resolved admin-preview settings (surfaced to the client via `runtimeConfig.public`). */
  preview: { desktopWidth: number }
  /** Gates the media-disclosure UI in the admin ONLY. `ResolvedMedia.aiDisclosure` is always resolved from
   *  the columns, so turning this off hides the editor controls without touching existing data. */
  aiDisclosure: { enabled: boolean }
  /** Resolved revision retention policy (see `KestrelConfig.revisions`). No env override — config-only,
   *  like `image.variants`: a structured `keep: number | 'all'` doesn't round-trip a scalar env var. */
  revisions: { keep: number | 'all'; maxAgeDays?: number }
  /** Resolved DeliveryPort selection (see `KestrelConfig.delivery`). The seam the live adapter plugs
   *  into: `'static'` selects today's file-backed delivery, `'live'` selects the runtime snapshot server. */
  delivery: 'static' | 'live'
  /** Resolved extra exemptions for the live catch-all (see `KestrelConfig.deliveryExempt`) — always
   *  slash-terminated, `[]` when unset. */
  deliveryExempt: string[]
}

type Env = Record<string, string | undefined>

/**
 * Gate the layer's OWN committed `kestrel.config.ts` so it is contributed to Nuxt only when Kestrel runs
 * in-repo — NOT when it is consumed as a dependency. Why: Nuxt/c12 merges layer config with `defu`, which
 * CONCATENATES array options, so the engine's demo `locales: ['en','de']` would merge back into a consumer
 * that set `locales: ['de']` (→ `['de','en','de']`). Scalars overwrite cleanly (consumer wins), but any
 * array field leaks. Detected via the module URL: a consumed package is loaded from `node_modules`, so it
 * contributes `{}` and the consumer's own `kestrel: {}` (resolved by `resolveKestrel`: env → config →
 * default) is the sole source. In-repo, the file is contributed as-is (the unified DX: nuxt/drizzle/runtime
 * @public
 * all derive the same values from the one file). Pure + tested so `nuxt.config` stays declarative. */
export function layerKestrelOption(config: KestrelConfig, moduleUrl: string): KestrelConfig {
  return moduleUrl.includes('/node_modules/') ? {} : config
}

/** Slash-terminate a `deliveryExempt` entry both ways — `health`, `/health`, `/health/` all become
 *  `/health/` — so a prefix match can only ever match at a path segment boundary, never a sibling with a
 * @public
 *  shared prefix (`/admin` matching `/admin-guide`). Blank in, blank out (filtered by the caller). */
export function normalizeExemptPrefix(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}

/** Parse a comma-separated locale list (trim + lowercase + dedupe, first-seen order); fall back when blank.
 * @public
 */
export function parseLocaleList(raw: string | undefined, fallback: string[]): string[] {
  const list = (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return list.length ? [...new Set(list)] : fallback
}

function clean(value: string | undefined): string | undefined {
  const t = value?.trim()
  return t ? t : undefined
}

/**
 * Normalise + validate the media driver. Case-insensitive (so `S3`/`Local` are accepted), but an unknown
 * value is a fail-loud misconfig — NOT a silent fall-through to local. Without this, the `=== 'local'`
 * guard in the kestrel module (which registers `/uploads`) and the `!== 's3'` branch in the storage
 * resolver (which returns the local driver) disagree, so a typo writes uploads to disk that are never served.
 */
function resolveDriver(value: string | undefined): 'local' | 's3' {
  const driver = (value ?? 'local').toLowerCase()
  if (driver !== 'local' && driver !== 's3') {
    throw new Error(`kestrel: unknown media driver "${value}" — expected "local" or "s3"`)
  }
  return driver
}

/** The four non-secret S3 settings, used by `bucket`/`region`/`endpoint`/`prefix`.
 * @public
 */
export interface ResolvedS3Settings { bucket: string; region: string; endpoint: string; prefix: string }

/**
 * Resolve the non-secret S3 block (bucket/region/endpoint/prefix), precedence **`<PREFIX>_*` env → config
 * → default**. Shared by media uploads (`KESTREL_S3_*`) and the generate-output deploy
 * (`KESTREL_OUTPUT_S3_*`) so both buckets resolve identically; secrets are never read here.
 * @public
 */
export function resolveS3Settings(
  cfg: { bucket?: string; region?: string; endpoint?: string; prefix?: string } | undefined,
  env: Env,
  envPrefix: string,
): ResolvedS3Settings {
  const s = cfg ?? {}
  return {
    bucket: clean(env[`${envPrefix}_BUCKET`]) ?? clean(s.bucket) ?? '',
    region: clean(env[`${envPrefix}_REGION`]) ?? clean(s.region) ?? 'us-east-1',
    endpoint: clean(env[`${envPrefix}_ENDPOINT`]) ?? clean(s.endpoint) ?? '',
    prefix: clean(env[`${envPrefix}_PREFIX`]) ?? clean(s.prefix) ?? '',
  }
}

function resolveMaybe(rootDir: string, value: string): string {
  return value === ':memory:' ? value : resolve(rootDir, value)
}

/** Boolean-ish env var: true/1/yes/on → true, false/0/no/off → false, undefined/garbage → fallback. */
function envBool(raw: string | undefined, fallback: boolean): boolean {
  const v = raw?.trim().toLowerCase()
  if (!v) return fallback
  if (['true', '1', 'yes', 'on'].includes(v)) return true
  if (['false', '0', 'no', 'off'].includes(v)) return false
  return fallback
}

/** Non-negative integer (e.g. minutes); env wins over config; invalid → fall through (env→config→0). Routes
 *  the env value through `clean()` like every sibling resolver: `Number('')`/`Number(' ')` is 0 (finite,
 *  \>= 0) and would otherwise override a configured value with a blank `KEY=` env-file line. */
function resolveNonNegInt(cfg: number | undefined, env: string | undefined): number {
  const raw = clean(env)
  const n = raw !== undefined ? Number(raw) : NaN
  if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  if (typeof cfg === 'number' && Number.isFinite(cfg) && cfg >= 0) return Math.floor(cfg)
  return 0
}

/** Positive integer (e.g. a px width); env wins over config; invalid or ≤0 → fall through (env→config→fallback). */
function resolvePosInt(cfg: number | undefined, env: string | undefined, fallback: number): number {
  const n = env !== undefined ? Number(env) : NaN
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  if (typeof cfg === 'number' && Number.isFinite(cfg) && cfg > 0) return Math.floor(cfg)
  return fallback
}

/** Floor to ints first, then keep only widths \>= 1 (so a sub-1 fraction is dropped, not floored to 0); dedupe, sort. */
function sanitizeWidths(list: readonly number[]): number[] {
  const clean = list.map((n) => Math.floor(n)).filter((n) => Number.isFinite(n) && n >= 1)
  return [...new Set(clean)].sort((a, b) => a - b)
}

/** widths: KESTREL_MEDIA_IMAGE_WIDTHS (csv) → config array → default; each level used only if non-empty after sanitising. */
function resolveWidths(cfg: number[] | undefined, env: string | undefined): number[] {
  const fromEnv = sanitizeWidths((env ?? '').split(',').map(Number))
  if (fromEnv.length) return fromEnv
  const fromCfg = sanitizeWidths(cfg ?? [])
  return fromCfg.length ? fromCfg : [...DEFAULT_IMAGE_POLICY.widths]
}

/** A quality is valid only as an integer in [1, 100]; anything else is ignored at that level. */
function validQuality(n: number | undefined): number | undefined {
  return n !== undefined && Number.isFinite(n) && n >= 1 && n <= 100 ? Math.round(n) : undefined
}

function resolveQuality(cfg: number | undefined, env: string | undefined, fallback: number = DEFAULT_IMAGE_POLICY.webpQuality): number {
  return validQuality(env !== undefined ? Number(env) : undefined) ?? validQuality(cfg) ?? fallback
}

const VARIANT_FITS = new Set<VariantFit>(['cover', 'contain', 'inside', 'outside', 'fill'])

/** Keep only `[A-Za-z0-9_-]`; collapse runs to a single `-`; trim edge `-`. Empty ⇒ the spec is dropped. */
function sanitizeVariantName(raw: unknown): string {
  return String(raw ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

/** Keep only known formats, first-seen deduped; an empty result falls back to `['webp']`. */
function sanitizeFormats(raw: unknown): VariantFormat[] {
  const arr = Array.isArray(raw) ? raw : []
  const out = [...new Set(arr.filter((f): f is VariantFormat => f === 'webp' || f === 'jpeg'))]
  return out.length ? out : ['webp']
}

/** Validate + default each authored spec; drop those with no usable name or a width \< 1; dedupe by name. */
function sanitizeVariants(list: readonly VariantSpec[]): ResolvedVariant[] {
  const out: ResolvedVariant[] = []
  const seen = new Set<string>()
  for (const v of list) {
    const name = sanitizeVariantName(v?.name)
    const width = Math.floor(Number(v?.width))
    if (!name || seen.has(name) || !Number.isFinite(width) || width < 1) continue
    const hn = Math.floor(Number(v?.height))
    const height = v?.height === undefined || v?.height === null || !Number.isFinite(hn) || hn < 1 ? null : hn
    const fit = v?.fit && VARIANT_FITS.has(v.fit) ? v.fit : 'cover'
    const position = typeof v?.position === 'string' && v.position.trim() ? v.position.trim() : 'centre'
    seen.add(name)
    out.push({ name, width, height, fit, position, formats: sanitizeFormats(v?.formats) })
  }
  return out
}

/** Legacy proportional widths → `w<width>` single-webp presets (the back-compat bridge into `variants`). */
function desugarWidths(widths: number[]): ResolvedVariant[] {
  return widths.map((w): ResolvedVariant => ({ name: `w${w}`, width: w, height: null, fit: 'cover', position: 'centre', formats: ['webp'] }))
}

/**
 * The variant set to derive: named config presets (config-only — no env) unioned with the desugared legacy
 * `widths` (which still honour `KESTREL_MEDIA_IMAGE_WIDTHS`). A named preset WINS a `w<width>` name collision.
 * @public
 */
export function resolveVariants(cfg: VariantSpec[] | undefined, cfgWidths: number[] | undefined, envWidths: string | undefined): ResolvedVariant[] {
  const byName = new Map<string, ResolvedVariant>()
  for (const v of sanitizeVariants(cfg ?? [])) byName.set(v.name, v)
  for (const v of desugarWidths(resolveWidths(cfgWidths, envWidths))) if (!byName.has(v.name)) byName.set(v.name, v)
  return [...byName.values()]
}

/**
 * Resolve every non-auth setting from one place, precedence **`KESTREL_*` (env) → `kestrel.*` (config) →
 * built-in default**. The committed `kestrel.config.ts` is the normal source of truth; an explicit
 * `KESTREL_*` env var OVERRIDES it — the test/deploy escape-hatch (an isolated test DB, a per-env path),
 * so the e2e suite isolates by setting `KESTREL_DB`/`KESTREL_MEDIA_LOCAL_DIR`/`KESTREL_SITE_URL` per run.
 * Normal dev / build / drizzle-kit set no `KESTREL_*`, so config wins and they never drift. (Auth/session
 * settings are env-ONLY and resolved elsewhere; they never appear here.) Pure (only `node:path`), so
 * nuxt.config / the kestrel module / drizzle.config / server utils all derive identical values. Relative
 * paths resolve against `rootDir`; `siteUrl` is returned raw (the caller normalises it).
 * @public
 */
export function resolveKestrel(config: KestrelConfig | undefined, env: Env, rootDir: string): ResolvedKestrel {
  const c = config ?? {}

  const dbPath = resolveMaybe(rootDir, clean(env.KESTREL_DB) ?? clean(c.db) ?? '.data/db.sqlite')

  const supportedLocales = parseLocaleList(
    clean(env.KESTREL_LOCALES) ?? (c.locales?.length ? c.locales.join(',') : undefined),
    ['en', 'de'],
  )
  const wantedPrimary = clean(env.KESTREL_PRIMARY_LOCALE)?.toLowerCase() ?? clean(c.primaryLocale)?.toLowerCase()
  const primaryLocale = wantedPrimary && supportedLocales.includes(wantedPrimary) ? wantedPrimary : (supportedLocales[0] ?? 'en')
  const prefixPrimary = envBool(env.KESTREL_PREFIX_PRIMARY_LOCALE, c.prefixPrimaryLocale ?? false)

  const siteUrl = clean(env.KESTREL_SITE_URL) ?? clean(c.siteUrl) ?? ''
  const siteName = clean(env.KESTREL_SITE_NAME) ?? clean(c.siteName) ?? ''
  const siteDescription = clean(env.KESTREL_SITE_DESCRIPTION) ?? clean(c.siteDescription) ?? ''

  const m = c.media ?? {}
  // maxBytes: a valid env count wins, else a valid config count, else the default (a garbage env falls through).
  const validBytes = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined)
  const maxUploadBytes = validBytes(env.KESTREL_MEDIA_MAX_BYTES !== undefined ? Number(env.KESTREL_MEDIA_MAX_BYTES) : undefined)
    ?? validBytes(m.maxBytes) ?? 26214400
  // Non-secret S3 settings only — secrets (access key id / secret) are env-only and read by the driver.
  const s = m.s3 ?? {}
  const s3 = {
    ...resolveS3Settings(s, env, 'KESTREL_S3'),
    publicBaseUrl: clean(env.KESTREL_S3_PUBLIC_BASE_URL) ?? clean(s.publicBaseUrl) ?? '',
  }
  const img = m.image ?? {}
  const media = {
    dir: resolveMaybe(rootDir, clean(env.KESTREL_MEDIA_LOCAL_DIR) ?? clean(m.uploadDir) ?? '.data/uploads'),
    baseUrl: clean(env.KESTREL_MEDIA_BASE_URL) ?? clean(m.baseUrl) ?? '/uploads',
    driver: resolveDriver(clean(env.KESTREL_MEDIA_DRIVER) ?? clean(m.driver)),
    maxUploadBytes,
    allowedMimes: clean(env.KESTREL_MEDIA_ALLOWED_MIME) ?? clean(m.allowedMimes) ?? '',
    s3,
    imagePolicy: {
      widths: resolveWidths(img.widths, env.KESTREL_MEDIA_IMAGE_WIDTHS),
      webpQuality: resolveQuality(img.webpQuality, env.KESTREL_MEDIA_IMAGE_WEBP_QUALITY),
      jpegQuality: resolveQuality(img.jpegQuality, env.KESTREL_MEDIA_IMAGE_JPEG_QUALITY, DEFAULT_IMAGE_POLICY.jpegQuality),
      variants: resolveVariants(img.variants, img.widths, env.KESTREL_MEDIA_IMAGE_WIDTHS),
      presets: sanitizeVariants(img.variants ?? []),
    },
  }

  const o = c.output ?? {}
  const output = {
    driver: resolveDriver(clean(env.KESTREL_OUTPUT_DRIVER) ?? clean(o.driver)),
    dir: resolveMaybe(rootDir, clean(env.KESTREL_OUTPUT_DIR) ?? clean(o.dir) ?? '.data/published'),
    publicDir: resolveMaybe(rootDir, clean(env.KESTREL_OUTPUT_PUBLIC_DIR) ?? clean(o.publicDir) ?? '.output/public'),
    auto: envBool(env.KESTREL_OUTPUT_AUTO, o.auto ?? true),
    publishOnSave: envBool(env.KESTREL_OUTPUT_PUBLISH_ON_SAVE, o.publishOnSave ?? false),
    reconcileMinutes: resolveNonNegInt(o.reconcileMinutes, env.KESTREL_OUTPUT_RECONCILE_MINUTES),
    verbose: envBool(env.KESTREL_OUTPUT_VERBOSE, o.verbose ?? false),
    s3: resolveS3Settings(o.s3, env, 'KESTREL_OUTPUT_S3'),
  }

  const collections = {
    pages: envBool(env.KESTREL_COLLECTIONS_PAGES, c.collections?.pages ?? true),
    media: envBool(env.KESTREL_COLLECTIONS_MEDIA, c.collections?.media ?? true),
  }

  const seo = {
    articleMeta: envBool(env.KESTREL_SEO_ARTICLE_META, c.seo?.articleMeta ?? false),
    llmsFull: envBool(env.KESTREL_SEO_LLMS_FULL, c.seo?.llmsFull ?? false),
  }

  const preview = { desktopWidth: resolvePosInt(c.preview?.desktopWidth, env.KESTREL_PREVIEW_DESKTOP_WIDTH, 1440) }

  const aiDisclosure = { enabled: envBool(env.KESTREL_AI_DISCLOSURE, c.aiDisclosure?.enabled ?? false) }

  const revisionsCfg = c.revisions ?? {}
  const revisions: { keep: number | 'all'; maxAgeDays?: number } = {
    keep: typeof revisionsCfg.keep === 'number' || revisionsCfg.keep === 'all' ? revisionsCfg.keep : 'all',
  }
  if (typeof revisionsCfg.maxAgeDays === 'number') revisions.maxAgeDays = revisionsCfg.maxAgeDays

  // Garbage (neither 'static' nor 'live') fails safe to the default rather than passing through unnormalized.
  const wantedDelivery = clean(env.KESTREL_DELIVERY) ?? clean(c.delivery)
  const delivery: 'static' | 'live' = wantedDelivery === 'live' ? 'live' : 'static'

  const exemptRaw = env.KESTREL_DELIVERY_EXEMPT !== undefined
    ? env.KESTREL_DELIVERY_EXEMPT.split(',')
    : (c.deliveryExempt ?? [])
  const deliveryExempt = [...new Set(exemptRaw.map(normalizeExemptPrefix).filter(Boolean))]

  return { dbPath, siteUrl, siteName, siteDescription, supportedLocales, primaryLocale, prefixPrimary, media, output, collections, seo, preview, aiDisclosure, revisions, delivery, deliveryExempt }
}
