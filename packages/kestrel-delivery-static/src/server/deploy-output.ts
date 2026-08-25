import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { setTimeout as sleepFor } from 'node:timers/promises'
import { resolveS3Settings, contentTypeFor, cacheControlFor } from '@kestrel/core'
import type { StorageDriver } from '@kestrel/core'

/** A boolean env flag is on for any of the common truthy spellings (case-insensitive, trimmed).
 * @public */
export function isEnvTrue(value: string | undefined): boolean {
  const t = value?.trim().toLowerCase()
  return t === 'true' || t === '1' || t === 'yes' || t === 'on'
}

/**
 * Decide what the deploy hook should do, kept pure so the trigger guard is unit-testable. Returns
 * `'skip'` when this isn't a static `nuxt generate` — a plain `nuxt build` (or dev) must never deploy,
 * even with `driver: s3` configured — and when `output.auto` hands publishing to the running server
 * (see `autoPublish`). For a real (non-dry-run) static generate it throws when the
 * bucket or `KESTREL_S3_*` credentials are missing, so a misconfigured deploy fails the generate
 * loudly instead of warning and exiting 0 with a stale live bucket. A dry-run needs neither.
 */
/** Strip leading/trailing slashes so prefixes compare on bare path segments. */
const normPrefix = (p: string): string => p.replace(/^\/+|\/+$/g, '')

/**
 * Do two S3 key prefixes share keyspace on a path-segment boundary — i.e. is one equal to, or nested
 * under, the other? Catches both nesting directions: a prune of `a` reaches everything under `a/b`, and
 * a prune of `a/b` reaches the `a/b/…` slice of media stored under `a`. A pure-string collision like
 * `site` vs `siteother` is *not* an overlap. Empty prefixes never overlap (handled by their own guards).
 */
function prefixesOverlap(a: string, b: string): boolean {
  const x = normPrefix(a)
  const y = normPrefix(b)
  if (!x || !y) return false
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/** @public */
export function planS3Deploy(opts: {
  isStaticGenerate: boolean
  dryRun: boolean
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  prefix?: string
  /**
   * `output.auto` — the running server publishes to this bucket/prefix itself. Build-time route seeding is
   * then disabled (a prerendered file would shadow the live route), so `.output/public` holds only what
   * Nitro's crawler reached: shipping it would reconcile the server's live pages, sitemap and robots away.
   */
  autoPublish?: boolean
  /** Bucket the S3 media driver writes live uploads to (empty when media isn't on S3 — then irrelevant). */
  mediaBucket?: string
  /** Key prefix of those live media objects, to keep the reconcile from deleting them. */
  mediaPrefix?: string
}): 'skip' | 'deploy' {
  if (!opts.isStaticGenerate) return 'skip'
  if (opts.autoPublish) return 'skip'
  if (!opts.dryRun) {
    const missing: string[] = []
    if (!opts.bucket) missing.push('bucket (KESTREL_OUTPUT_S3_BUCKET)')
    if (!opts.accessKeyId) missing.push('KESTREL_OUTPUT_S3_ACCESS_KEY_ID / KESTREL_S3_ACCESS_KEY_ID')
    if (!opts.secretAccessKey) missing.push('KESTREL_OUTPUT_S3_SECRET_ACCESS_KEY / KESTREL_S3_SECRET_ACCESS_KEY')
    if (missing.length) {
      throw new Error(
        `[kestrel] output.driver=s3 but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing`
        + ' — refusing to finish `nuxt generate` with a broken S3 deploy.',
      )
    }
    // The deploy always reconciles (deletes every remote object under the prefix not in this generate —
    // output ≡ DB). With an empty prefix that's the whole bucket root, which may hold the media bucket's
    // objects too. Refuse rather than risk wiping it: an S3 deploy must target a dedicated prefix.
    if (!opts.prefix) {
      throw new Error(
        '[kestrel] output.s3.prefix is empty — refusing to deploy (the always-on reconcile would delete the'
        + ' whole bucket root, and a shared/media bucket could be wiped). Set KESTREL_OUTPUT_S3_PREFIX to a'
        + ' prefix dedicated to the generated site.',
      )
    }
    // Same bucket as the S3 media driver AND overlapping prefixes → the reconcile would delete live uploads.
    if (opts.mediaBucket && opts.mediaBucket === opts.bucket
      && opts.mediaPrefix && prefixesOverlap(opts.prefix, opts.mediaPrefix)) {
      throw new Error(
        `[kestrel] the output reconcile would delete live media: output prefix "${opts.prefix}" overlaps the`
        + ` S3 media prefix "${opts.mediaPrefix}" in the same bucket "${opts.bucket}". Give the generated`
        + ' site its own bucket or a non-overlapping KESTREL_OUTPUT_S3_PREFIX.',
      )
    }
  }
  return 'deploy'
}

/** @public */
export interface OutputTarget {
  driver: 'local' | 's3'
  /** Non-secret S3 settings; credentials are resolved separately by `resolveOutputCreds`. */
  s3: { bucket: string; region: string; endpoint: string; prefix: string }
}

/** @public */
export type OutputConfig = { driver?: string; s3?: { bucket?: string; region?: string; endpoint?: string; prefix?: string } }
const clean = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * Resolve where `nuxt generate`'s static output is shipped: a local directory (default) or an S3
 * bucket. Precedence per setting: `KESTREL_OUTPUT_*` env → config → default (the documented Kestrel
 * order, same as the runtime publisher). Pure, so the precedence is unit-testable; secrets are resolved
 * by `resolveOutputCreds`, never here.
 * @public
 */
export function resolveOutputTarget(out: OutputConfig = {}, env: Record<string, string | undefined> = {}): OutputTarget {
  const driver = (clean(env.KESTREL_OUTPUT_DRIVER) ?? clean(out.driver))?.toLowerCase() === 's3' ? 's3' : 'local'
  // Same non-secret resolver media uses, under the KESTREL_OUTPUT_S3_* prefix (own bucket, own creds).
  return { driver, s3: resolveS3Settings(out.s3, env, 'KESTREL_OUTPUT_S3') }
}

/**
 * S3 credentials for the output deploy: the output-specific `KESTREL_OUTPUT_S3_*`, falling back to the
 * shared media `KESTREL_S3_*` so a single S3 account "just works" — identical to the runtime publisher's
 * resolution. Required keys default to '' (not undefined) so `planS3Deploy` detects a missing credential.
 * @public
 */
export function resolveOutputCreds(env: Record<string, string | undefined> = {}): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } {
  return {
    accessKeyId: clean(env.KESTREL_OUTPUT_S3_ACCESS_KEY_ID) ?? clean(env.KESTREL_S3_ACCESS_KEY_ID) ?? '',
    secretAccessKey: clean(env.KESTREL_OUTPUT_S3_SECRET_ACCESS_KEY) ?? clean(env.KESTREL_S3_SECRET_ACCESS_KEY) ?? '',
    sessionToken: clean(env.KESTREL_OUTPUT_S3_SESSION_TOKEN) ?? clean(env.KESTREL_S3_SESSION_TOKEN),
  }
}

/** Every file under `dir` as `{ abs, key }`, the key being its POSIX-relative path (stable order). */
function listFiles(dir: string): Array<{ abs: string; key: string }> {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const abs = join(e.parentPath, e.name)
      return { abs, key: relative(dir, abs).split(sep).join('/') }
    })
}

/**
 * A `*.gz`/`*.br` file is a pre-compressed sidecar (from `nitro.compressPublicAssets`) when its
 * uncompressed base is also in the output. On a plain static S3 host these are dead weight — the host
 * does no `Accept-Encoding` negotiation, so nobody fetches `index.html.gz`, and storing it *as*
 * `index.html` with `Content-Encoding` would collide with the real file — so the deploy skips them.
 * A standalone `*.gz` archive (no base file) is genuine content and is kept.
 * @public
 */
export function isCompressedSidecar(key: string, all: Set<string>): boolean {
  const m = /\.(?:gz|br)$/.exec(key)
  return m ? all.has(key.slice(0, m.index)) : false
}

/** @public */
export interface DeployResult { pruned: number; keys: string[] }

/**
 * What build-time route discovery enumerated for this generate, plus WHY that enumeration is known to be
 * short of the site's pages (`incomplete` unset ⇒ it is complete). The runtime publisher's
 * `{ routes, failed }` is the same contract: an enumeration that came up short must never be the
 * authority for what gets deleted.
 */
/** @public */
export interface RouteDiscovery { routes: string[]; incomplete?: string }

interface DiscoveryHost { _kestrelRouteDiscovery?: RouteDiscovery }

/** The prerender and deploy modules are loaded separately and share no module scope — but they are handed
 *  the same Nuxt instance, so that object is what carries the signal from the one to the other.
 *  @public */
export function recordRouteDiscovery(nuxt: object, discovery: RouteDiscovery): void {
  (nuxt as DiscoveryHost)._kestrelRouteDiscovery = discovery
}

/** `undefined` ⇒ discovery never reported anything, which is not itself evidence of a degraded build.
 * @public */
export function readRouteDiscovery(nuxt: object): RouteDiscovery | undefined {
  return (nuxt as DiscoveryHost)._kestrelRouteDiscovery
}

/** The deploy needs `put` always, and `list`+`delete` for the reconcile; both are optional on the driver.
 * @public */
export type DeployDriver = Pick<StorageDriver, 'put'> & Partial<Pick<StorageDriver, 'list' | 'delete'>>

/** @public */
export interface DeployOptions {
  dryRun?: boolean
  log?: (msg: string) => void
  /** Max operations in flight at once (default 8). Bounded so a large tree never opens thousands of sockets. */
  concurrency?: number
  /** Total attempts per operation before giving up (default 3); retries ride out transient S3 errors. */
  retries?: number
  /** Sleep between retries (exponential backoff); injectable so tests run without real delay. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Why a build step REPORTED that this output tree is short of pages (routes that failed to prerender,
   * route discovery that could not read the DB). Set ⇒ upload but never reconcile: pages missing from the
   * input are indistinguishable from pages removed from the CMS, so the prune would delete live ones.
   * Only a step's own failure report belongs here: the SHAPE of the output cannot tell a degraded build
   * from a small site, so inferring it would strand the pages an editor deleted.
   */
  incomplete?: string
}

async function runPool<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      await task(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

/** HTTP statuses the S3 driver surfaces in its error message (e.g. `S3 put failed (403) for x`). */
function statusFromError(err: unknown): number | undefined {
  const m = /\((\d{3})\)/.exec((err as Error)?.message ?? '')
  return m ? Number(m[1]) : undefined
}

/**
 * A permanent client error — bad/forbidden credentials, missing bucket, denied access (400/401/403/404).
 * These never become successful on a later attempt, so retrying only delays the inevitable loud failure.
 * @public
 */
export function isPermanentError(err: unknown): boolean {
  const s = statusFromError(err)
  return s === 400 || s === 401 || s === 403 || s === 404
}

/** Retry `fn` with exponential backoff up to `retries` total attempts, surfacing the last error. */
async function withRetry(fn: () => Promise<void>, label: string, retries: number, sleep: (ms: number) => Promise<void>, log?: (msg: string) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fn()
      return
    } catch (err) {
      // A permanent 4xx can't be ridden out — re-throw at once so the deploy fails loudly, not slowly.
      if (isPermanentError(err) || attempt >= retries) throw err
      log?.(`retry ${attempt}/${retries - 1} for ${label}: ${(err as Error).message}`)
      await sleep(100 * 2 ** (attempt - 1))
    }
  }
}

/**
 * Upload every file under `dir` to `driver`, keyed by its POSIX-relative path, with a content type
 * inferred from the extension — the S3 equivalent of `aws s3 sync` (overwrites). Then reconciles: deletes
 * remote objects under the prefix that this generate didn't produce (`--delete`), so pages removed from
 * the CMS stop being served (output ≡ DB, no toggle). The reconcile is skipped when the driver can't
 * list+delete and when the caller flagged the tree `incomplete` — a build step reported it is short of
 * pages, so their absence says nothing about the CMS. Uploads still run then: shipping the pages that did
 * render is safe, deleting on their absence is not.
 * Uploads and deletes run with bounded concurrency and each is retried with
 * backoff, so a transient 5xx/throttle/dropped-connection no longer aborts the deploy mid-way and
 * half-updates the bucket; only an operation that fails every attempt rejects (true rollback isn't
 * possible on S3). With `dryRun`, walks/lists and reports without writing.
 * @public
 */
export async function deployStaticOutput(
  dir: string,
  driver: DeployDriver,
  opts: DeployOptions = {},
): Promise<DeployResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 8)
  const retries = Math.max(1, opts.retries ?? 3)
  const sleep = opts.sleep ?? ((ms: number) => sleepFor(ms))
  const all = listFiles(dir)
  const allKeys = new Set(all.map((f) => f.key))
  const files = all.filter((f) => !isCompressedSidecar(f.key, allKeys))
  const skipped = all.length - files.length
  if (skipped) opts.log?.(`skipping ${skipped} pre-compressed sidecar(s) (.gz/.br)`)
  const keys = files.map((f) => f.key)

  if (!opts.dryRun) {
    // `files` already excludes pre-compressed sidecars (above), so anything ending `.gz`/`.br` here is a
    // standalone archive shipped with no `Content-Encoding` — keep its own extension in the type lookup.
    await runPool(files, concurrency, (f) =>
      withRetry(() => driver.put(f.key, readFileSync(f.abs), contentTypeFor(f.key, false), { cacheControl: cacheControlFor(f.key) }), f.key, retries, sleep, opts.log))
  }
  opts.log?.(`${opts.dryRun ? 'Would deploy' : 'Deployed'} ${keys.length} file(s)`)

  // Reconcile (output ≡ DB) — skipped when the driver lacks list/delete (e.g. a put-only target) and when
  // a build step reported that this generate is short of pages.
  let pruned = 0
  if (!driver.list || !driver.delete) {
    opts.log?.('driver cannot list/delete — skipping reconcile')
  } else if (opts.incomplete) {
    opts.log?.(`skipping reconcile — ${opts.incomplete}; the missing pages would read as stale and be deleted`)
  } else {
    const keep = new Set(keys)
    const stale = (await driver.list()).filter((k) => !keep.has(k))
    if (!opts.dryRun) {
      const del = driver.delete
      await runPool(stale, concurrency, (k) => withRetry(() => del(k), `delete ${k}`, retries, sleep, opts.log))
      pruned = stale.length
    }
    opts.log?.(`${opts.dryRun ? 'Would prune' : 'Pruned'} ${stale.length} stale object(s)`)
  }
  return { pruned, keys }
}
