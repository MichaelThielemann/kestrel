import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { getTableColumns } from 'drizzle-orm'
import { contentTypeFor, cacheControlFor, precompressedEncoding, META_KEYS, isMetaKey, localePath, pageRowHref, withReadCapture, withResolveScope, useDb, primaryLocale, prefixPrimaryLocale, allCollections, createLocalDriver, createS3Driver, getResolvedKestrelConfig } from '@michaelthielemann/kestrel-core'
import type { StorageDriver } from '@michaelthielemann/kestrel-core'
import { isPubliclyReadable, publicReadableResources } from '@michaelthielemann/kestrel-access'
import { usePublishingDb } from '../../db/publishing-db.js'
import { recordSnapshot, currentSnapshot, retractSnapshot } from '../../db/snapshots.js'
import { htmlKeyForRoute } from './route-keys.js'
import { staleRoutes, type DepsStore } from './deps.js'
import { recordPublishStatus, clearPublishStatus, renderOutcome, lastPublishedAt } from './publish-status.js'
import { renderRouteLive } from './render-seam.js'
import { routesToPrune, type Invalidation } from './invalidation.js'
import { pendingRoutes, heldRoutes } from './pending.js'

/**
 * The runtime static publisher: producer + delivery-static, wired together. The PRODUCER
 * (`renderRouteLive` + `recordSnapshot`) renders public routes from the LIVE server (`localFetch`, the
 * same handler `nuxt generate` uses) and records their published state; the DELIVERY side
 * (`@michaelthielemann/kestrel-delivery-static`'s `render-route.ts`'s `renderRoute`) reads that recorded state back
 * and writes it — plus the built `_nuxt` bundle + assets — through the configured output StorageDriver
 * (local dir or S3). This is the engine the manual `publish:run` task and (later) the auto-trigger queue
 * both drive. NOT unit-tested (needs a running build); the pure pieces it composes (route-keys,
 * invalidation, deps, queue) are.
 */

/** The resolved `output` namespace, as `outputConfig()`/`outputDriver()` consume it.
 * @public
 */
export interface OutputRc {
  driver: 'local' | 's3'
  dir: string
  publicDir: string
  auto: boolean
  publishOnSave: boolean
  reconcileMinutes: number
  verbose: boolean
  s3: { bucket: string; region: string; endpoint: string; prefix: string; accessKeyId: string; secretAccessKey: string; sessionToken: string }
}

/** Reads the resolved `output` namespace off the config-provider seam (`@michaelthielemann/kestrel-core`'s
 *  `getResolvedKestrelConfig`) instead of `useRuntimeConfig()` — a package cannot reach the latter (it is a
 *  Nuxt/Nitro auto-import, unavailable outside a layer's own build graph). `resolveServerKestrelConfig()`
 *  already merges `runtimeConfig.kestrel.output` wholesale (S3 credentials included — the kestrel module's
 *  `KESTREL_OUTPUT_S3_*`-at-setup write, itself overridable at server start via Nitro's documented
 *  `NUXT_KESTREL_OUTPUT_S3_*` convention, see docs/guide/configuration.md), so this seam read is functionally
 *  identical to the direct `useRuntimeConfig()` read it replaces — the merge happens once at boot
 *  (`00.config.ts`), AFTER Nitro's own env-substitution has already applied. The cast is required because
 *  `ResolvedKestrel['output'].s3` (packages/kestrel-core) only types the NON-secret fields
 *  (`bucket`/`region`/`endpoint`/`prefix` — shared with the build-time deploy's `resolveOutputTarget`,
 *  which never sees secrets); the secret fields are present on the actual object at runtime regardless.
 * @public
 */
export function outputConfig(): OutputRc {
  return getResolvedKestrelConfig().output as unknown as OutputRc
}

/** Build the output driver from runtimeConfig (local dir or S3 bucket) — separate from the media driver.
 * @public
 */
export function outputDriver(cfg: OutputRc = outputConfig()): StorageDriver {
  if (cfg.driver === 's3') {
    return createS3Driver({
      bucket: cfg.s3.bucket, region: cfg.s3.region, endpoint: cfg.s3.endpoint || undefined, prefix: cfg.s3.prefix,
      publicBaseUrl: '', accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey, sessionToken: cfg.s3.sessionToken || undefined,
    })
  }
  return createLocalDriver({ dir: cfg.dir, baseUrl: '/' })
}

/** The enumerated published routes plus the collections whose query failed. `failed` is non-empty ⇒ the
 *  route set is INCOMPLETE, so it must never be used as the authority for what to delete.
 * @public
 */
export interface PublishedRoutes {
  routes: string[]
  /** Each route's record `updatedAt` in ms — the "last saved" half of the saved-vs-published comparison. */
  savedAt: Map<string, number>
  /** Each route's owning record as its deps tag (`<coll>:<id>`) — route strings move on a rename, records
   *  do not, so withholding a renamed page needs the identity behind the route. */
  recordTag: Map<string, string>
  /** Each route's resolved locale (the same value `pageRowHref` used to build the route), `null` for a
   *  non-translatable collection — the identity `recordSnapshot`'s payload carries. */
  localeOf: Map<string, string | null>
  /** Names of collections whose route query threw (drifted schema, locked DB) — routes are missing. */
  failed: string[]
}

/** Every published, publicly-readable page-like route (across collections) + the site root — the
 *  runtime analogue of the prerender/sitemap route enumeration. noindex pages ARE published (real
 *  reachable pages); only the sitemap omits them.
 * @public
 */
export function allPublishedRoutes(): PublishedRoutes {
  const db = useDb()
  const primary = primaryLocale()
  const prefixPrimary = prefixPrimaryLocale()
  const pub = publicReadableResources()
  const rootRoute = localePath('/', primary, primary, prefixPrimary) // `/` or `/<primary>`
  const routes = new Set<string>([rootRoute])
  const savedAt = new Map<string, number>()
  const recordTag = new Map<string, string>()
  const localeOf = new Map<string, string | null>([[rootRoute, primary]])
  const failed: string[] = []
  for (const c of allCollections()) {
    if (!c.def.pageLike || !isPubliclyReadable(c.def.name, pub)) continue
    // Project ONLY the columns the route rule + status gate need — never SELECT *, which would pull every
    // row's block-content JSON (and every other field) into memory on each full publish just to read `path`.
    // `locale` exists ONLY on a translatable collection (buildTable adds no locale column otherwise); a bare
    // `cols.locale` would be undefined and make the select throw, dropping every one of this NON-translatable
    // collection's live pages (then pruning them). Guard it exactly like findRouteConflict does.
    const cols = getTableColumns(c.table) as Record<string, never>
    const proj: Record<string, unknown> = { path: cols.path }
    if (c.def.translatable) proj.locale = cols.locale
    if (c.def.status) proj.status = cols.status
    // `updatedAt` is a system column on every built collection, but this projection also runs against
    // hand-rolled tables in tests — guard it exactly like `locale`, or its absence throws the select.
    if (Object.hasOwn(cols, 'updatedAt')) proj.updatedAt = cols.updatedAt
    if (Object.hasOwn(cols, 'id')) proj.id = cols.id
    let rows: Record<string, unknown>[]
    try { rows = db.select(proj as never).from(c.table).all() as Record<string, unknown>[] }
    catch (error) {
      // Report the gap instead of contributing zero routes: an unreadable collection is NOT an empty one,
      // and a caller that can't tell them apart would treat every live page of it as stale.
      failed.push(c.def.name)
      console.error(`[kestrel] allPublishedRoutes: skipped collection ${c.def.name}:`, (error as Error)?.message ?? error)
      continue
    }
    for (const row of rows) {
      if (c.def.status && row.status !== 'published') continue
      const route = pageRowHref(row, primary, prefixPrimary) // the shared (path, locale) → route rule
      if (!route) continue
      routes.add(route)
      // Same resolution `pageRowHref` used internally: a translatable collection's row locale (falling
      // back to primary), `null` for a non-translatable one (which ignores any stray `locale` entirely).
      localeOf.set(route, c.def.translatable ? (typeof row.locale === 'string' && row.locale ? row.locale : primary) : null)
      const saved = row.updatedAt
      if (saved instanceof Date) savedAt.set(route, saved.getTime())
      else if (typeof saved === 'number') savedAt.set(route, saved)
      // The same tag the publisher records against a rendered route, so a route can be traced back to its
      // record even after a rename moved the route string.
      if (typeof row.id === 'number') recordTag.set(route, `${c.def.name}:${row.id}`)
    }
  }
  return { routes: [...routes], savedAt, recordTag, localeOf, failed }
}

/** Whether the caller is the explicit "Publish" action (`'publish'`, the default — a route named here
 *  always gets a fresh producer render + recorded snapshot, whatever the store currently holds, since
 *  pressing Publish IS what a route's new content means) or a delivery reconcile (`'reconcile'` — a full
 *  publish converging OUTPUT to the CURRENT render via fingerprint-based promotion: a route whose fresh
 *  render fingerprint still matches the store is delivered from it as-is, a mismatch records + delivers
 *  the fresh render). See `publishRoutesInScope` (this module's own internal implementation).
 * @public
 */
export type PublishMode = 'publish' | 'reconcile'

/** Render + write the given routes (skips non-200). When `deps` is given, each render is wrapped in a
 *  read-capture and its data tags recorded, so a later write maps back to the routes it affects.
 *  `getLocaleOf`, when the caller has one on hand, threads each route's real locale into its recorded
 *  snapshot — a LAZY accessor (not the map itself): it is invoked at most once, and only if `routes` is
 *  non-empty, so a caller whose locale source is itself expensive (`allPublishedRoutes`'s full collection
 *  scan, for the tag-scoped incremental path) never pays for it on an empty run or more than once per call.
 * @public
 */
export async function publishRoutes(routes: string[], driver: StorageDriver, deps?: DepsStore, getLocaleOf?: () => Map<string, string | null>, mode: PublishMode = 'publish'): Promise<string[]> {
  // One UNBUDGETED resolve scope for the whole run: a media/link/relation shared across pages resolves
  // once per publish instead of once per embedding page (the runtime analogue of the generate build's
  // memoDuringPrerender). Memo hits replay their read-tags, so each page's dep capture stays complete.
  return withResolveScope(() => publishRoutesInScope(routes, driver, deps, getLocaleOf, mode))
}

async function publishRoutesInScope(routes: string[], driver: StorageDriver, deps?: DepsStore, getLocaleOf?: () => Map<string, string | null>, mode: PublishMode = 'publish'): Promise<string[]> {
  const written: string[] = []
  const db = usePublishingDb().db
  const target = outputConfig().driver
  let localeOf: Map<string, string | null> | undefined
  for (const route of routes) {
    try {
      // The PRODUCER render always runs — deps/read-capture tags come only from a real render, and a
      // 'reconcile' pass still needs to know whether the route currently 200s (renderOutcome below) even
      // when its bytes end up unused. What gets RECORDED/DELIVERED is decided after, from the store.
      const { result, tags } = await withReadCapture(() => renderRouteLive(route))
      const outcome = renderOutcome(result.status, !!result.body)
      if (outcome === 'success') {
        // Deps/tags are recorded from THIS render regardless of what happens below: they describe the
        // route's actual read footprint (which collections/records it touched), which is a fact about the
        // render itself, not about whether its bytes happened to match the store — so they never go stale
        // for a route the promotion below skips delivering.
        deps?.record(route, tags)
        localeOf ??= getLocaleOf?.() ?? new Map()
        const key = htmlKeyForRoute(route)
        let html: string
        let write = true
        if (mode === 'reconcile') {
          // Fingerprint-based promotion (ADR-0025 amendment): a reconcile pass ALWAYS live-renders (above),
          // then compares that fresh render's fingerprint against the route's currently recorded snapshot.
          // MISMATCH — a real content change the store hasn't seen yet (a missed/lost incremental
          // invalidation, a template/component deploy, direct restore) — records + delivers the fresh
          // render: reconcile converges output to the current render, it does not freeze it. MATCH —
          // nothing to record; the store's read surface
          // (`currentSnapshot`/`currentRoutes`) stays the single source delivery is built from, so the
          // WRITE itself is skipped too, UNLESS the target file is missing (a wiped/killed output — the
          // rebuild case), which a plain fingerprint match can't tell apart from "already correct on disk"
          // without asking the driver.
          const existing = currentSnapshot(db, route)
          const fingerprint = createHash('sha256').update(result.body!).digest('hex')
          if (existing && existing.fingerprint === fingerprint) {
            html = existing.html
            const alreadyOnDisk = await driver.exists?.(key)
            write = !alreadyOnDisk
          } else {
            html = result.body!.toString('utf8')
            recordSnapshot(db, { route, payload: { html, media: [], locale: localeOf.get(route) ?? null }, fingerprint })
          }
        } else {
          // 'publish': the explicit action always wins, whatever the store currently holds — record +
          // deliver this render's own bytes (recordSnapshot no-ops internally on an unchanged fingerprint,
          // so this stays cheap when nothing actually changed).
          html = result.body!.toString('utf8')
          recordSnapshot(db, {
            route,
            payload: { html, media: [], locale: localeOf.get(route) ?? null },
            fingerprint: createHash('sha256').update(result.body!).digest('hex'),
          })
        }
        if (write) await driver.put(key, Buffer.from(html, 'utf8'), contentTypeFor(key), { cacheControl: cacheControlFor(key) })
        written.push(route)
        recordPublishStatus(db, route, { status: 'success', target })
      } else if (outcome === 'error') {
        // The page itself rendered to a server error (5xx) — a non-200 RESPONSE, not a thrown exception, so
        // it never reaches the catch below. Record it so the editor ampel shows the failure; the
        // previously-written file (if any) stays in place.
        const message = `Render failed with HTTP ${result.status}`
        recordPublishStatus(db, route, { status: 'error', error: message, target })
        console.error(`[kestrel] publish failed for ${route}: ${message}`)
      }
      // outcome === 'skip': an expected non-200 (a draft / unpublish race) — leave the status untouched.
    } catch (error) {
      // Render or write (incl. S3 put) THREW for THIS route: record the outcome and carry on so one bad
      // route doesn't abort the whole publish. The failure stays visible in the logs and the editor ampel.
      const message = (error as Error)?.message ?? String(error)
      recordPublishStatus(db, route, { status: 'error', error: message, target })
      console.error(`[kestrel] publish failed for ${route}:`, message)
    }
  }
  return written
}

/** Delete the given routes' static files (idempotent) — unpublish / delete / old-path prune. Also retracts
 *  each route's current snapshot (a no-op if it has none, or is already retracted): the route's history
 *  stays, but `currentSnapshot`/`currentRoutes` stop surfacing it — the same "no longer live" fact the file
 *  deletion records on disk, recorded in the store the delivery side actually reads from.
 * @public
 */
export async function prunePages(routes: string[], driver: StorageDriver): Promise<void> {
  // pruneEmptyDirs: a page is `<path>/index.html`, so removing it must also clear the now-empty `<path>/`.
  const db = usePublishingDb().db
  for (const route of routes) {
    await driver.delete(htmlKeyForRoute(route), { pruneEmptyDirs: true })
    clearPublishStatus(db, route) // the file is gone → no live status (after the delete, so a failed delete keeps the row)
    retractSnapshot(db, route)
  }
}

/** Render + write the crawler/agent artifacts — sitemap/robots/llms/redirects, served at literal keys
 *  rather than `<path>/index.html`.
 *  A 404 means the route is switched off (`llms-full.txt` without `kestrel.seo.llmsFull`) — the file it
 *  wrote while it WAS on must go, or the flag would stop publishing new content while the last full dump
 *  stayed live. That is a deterministic route-level answer, not the incomplete-read case a delete must
 *  never act on; any other non-200 leaves the existing file alone. */
async function publishMeta(driver: StorageDriver): Promise<void> {
  for (const key of META_KEYS) {
    const { body, status } = await renderRouteLive(`/${key}`)
    if (body) await driver.put(key, body, contentTypeFor(key), { cacheControl: cacheControlFor(key) })
    else if (status === 404) await driver.delete(key)
  }
}

/** Mirror the built client bundle + static assets (`_nuxt/**`, favicon, fonts) into the output, but
 *  NOT the build's stale `*.html`/sitemap/robots — those are rendered fresh from the live DB. */
async function syncStaticAssets(driver: StorageDriver, publicDir: string): Promise<void> {
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) }
    catch (error) {
      // The root directory failing is a misconfig (missing/unreadable output.publicDir), not an empty
      // tree — silently returning here means zero assets get synced while the render below still
      // uploads fresh HTML referencing hashed `_nuxt/*` chunks that were never uploaded. A nested
      // directory disappearing mid-walk is comparatively benign and stays silent.
      if (!prefix) {
        console.error(`[kestrel] output.publicDir "${dir}" is unreadable — publishing HTML without syncing _nuxt/assets: ${(error as Error)?.message ?? error}`)
      }
      return
    }
    const names = entries.map((s) => s.name)
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) { await walk(resolve(dir, e.name), rel); continue }
      // Strip a precompressed `.br`/`.gz` suffix before the skip test: `index.html.br` is still the
      // build's stale HTML (only content-negotiable, not literally named `*.html`) and must be excluded
      // exactly like its uncompressed sibling, or it ships as a live sidecar for the fresh HTML rendered
      // below — served to any Accept-Encoding-negotiating client instead of the page just published.
      const base = rel.replace(/\.(?:br|gz)$/i, '')
      if (!e.isFile() || base.endsWith('.html') || isMetaKey(base)) continue
      const bytes = await readFile(resolve(dir, e.name))
      // Tag a precompressed sibling (`.br`/`.gz` beside its base) with Content-Encoding so a proxy over S3
      // serves it directly; a standalone archive stays unencoded so browsers don't decode + corrupt it.
      const contentEncoding = precompressedEncoding(e.name, names)
      await driver.put(rel, bytes, contentTypeFor(rel, !!contentEncoding), { cacheControl: cacheControlFor(rel), contentEncoding })
    }
  }
  await walk(publicDir, '')
}

/** Full publish: sync `_nuxt`/assets first (so HTML never references not-yet-uploaded chunks), render
 *  every published route + sitemap/robots, and prune routes that left the published set (unpublish /
 *  delete / slug change) — tracked via the now-durable deps index, so a page unpublished/deleted while the
 *  server was down is pruned on the next boot too. Targeted (only ever deletes routes this publisher wrote),
 *  and skipped entirely when the published set could not be enumerated in full.
 *
 *  Deliberately NOT single-flighted: each caller brings its own driver and DepsStore, and folding a later
 *  caller into a run already in progress would hand it that run's older route snapshot — an edit made
 *  after the snapshot would never render and its deps would never be recorded. Serializing overlapping
 *  triggers is the publish queue's job.
 * @public
 */
export async function publishFull(driver: StorageDriver = outputDriver(), deps?: DepsStore): Promise<{ rendered: number; pruned: number }> {
  const cfg = outputConfig()
  // Keep the registry read (`allPublishedRoutes` → `allCollections()`) AFTER this first `await`: on a
  // boot publish it lets the synchronous Nitro plugin loop — including collections/01.register — finish
  // populating the registry first, regardless of that plugin's declared position. Moving the read before
  // an await would silently render an empty registry. See docs/internals/architecture.md → "Server plugins".
  await syncStaticAssets(driver, cfg.publicDir)
  const { routes, savedAt, recordTag, localeOf, failed } = allPublishedRoutes()
  if (failed.length) {
    // Keep on doubt: with a collection missing from the enumeration, every one of its live pages looks
    // stale, so a prune would wipe it from the output. Rendering still proceeds — a stale extra file is
    // recoverable, a deleted site is not.
    console.error(`[kestrel] publish: prune skipped — routes of ${failed.join(', ')} could not be enumerated; existing files kept`)
  }

  // A full run resynchronizes the output with the DB, so without this it would push every saved-but-
  // unpublished edit live — exactly what deferring the publish exists to prevent. Those routes keep the
  // file their last publish wrote.
  // …unless the consumer opted out of the split (`output.publishOnSave`): there, a save IS a publish, so
  // "saved after the last publish" means a republish is merely in flight, not deliberately withheld.
  // Computed BEFORE the prune, because a held record's live file may sit at a route the DB no longer names
  // (an unpublished rename), and that file is what the site is still serving. Without `deps` there is no
  // way to find those prior routes, so only same-route withholding applies — the pre-rename behaviour.
  const { hold, keep } = cfg.publishOnSave
    ? { hold: new Set<string>(), keep: new Set<string>() }
    : heldRoutes(savedAt, lastPublishedAt(usePublishingDb().db), recordTag, (tag) => deps?.routesForTags([tag]) ?? [])
  if (hold.size) {
    console.info(`[kestrel] publish: ${hold.size} route(s) held at their published version (unpublished changes): ${[...hold].join(', ')}`)
  }

  // Targeted prune: a route we previously published that is no longer in the published set — a page
  // unpublished, deleted, or whose slug changed — must lose its static file. Safe because it only deletes
  // files this publisher wrote (tracked in deps, durable across restarts). Output ≡ DB; no opt-in toggle.
  let pruned = 0
  if (deps && !failed.length) {
    const stale = staleRoutes(deps.routes(), routes).filter((route) => !keep.has(route))
    if (stale.length) {
      await prunePages(stale, driver)
      for (const route of stale) deps.forget(route)
      pruned = stale.length
    }
  }

  const renderRoutes = routes.filter((route) => !hold.has(route))

  // Dynamic, not a static top-level import: `@michaelthielemann/kestrel-media`'s collections build EAGERLY at its own
  // module's first import (needs the field-type registry already seeded) — a static import here would make
  // ANY early-boot loader of this module (this package's own barrel, pulled in by e.g. the pipeline
  // registration plugin) also eagerly load media, racing the registry's own boot-time seed. Deferred to
  // first actual publish, well after boot either way.
  const { clearVariants, saveDiscoveredVariants } = await import('@michaelthielemann/kestrel-media')

  // Reset the discovery accumulator so this full run reconciles ONLY what it actually renders — an earlier
  // incremental (tag) publish also feeds the accumulator, and a variant it recorded whose usage was later
  // removed would otherwise survive and be re-registered here (defeating usage-driven narrowing).
  clearVariants()
  const written = await publishRoutes(renderRoutes, driver, deps, () => localeOf, 'reconcile')
  const rendered = written.length
  await publishMeta(driver)
  // Auto-discovery: a FULL render just visited every published route, so the capture accumulator now holds
  // the complete set of variants actually used — reconcile it into the media_settings registry (scan entries
  // replaced, manual/pinned kept). A partial (tag) publish must NOT do this: it would drop variants used only
  // by the un-rendered routes. ONLY narrow when EVERY route rendered: a partial failure leaves the accumulator
  // incomplete, so reconciling would deregister variants still referenced by the stale (kept) published HTML,
  // which a later backfill would then delete out from under the live page. An un-enumerated collection is
  // the same partial-coverage case: its pages were never visited, so their variants are missing too — and
  // so is a route held back at its published version: its live file still references the variants this run
  // never saw.
  if (!failed.length && !hold.size && rendered === renderRoutes.length) saveDiscoveredVariants(useDb())
  return { rendered, pruned }
}

/** What one {@link publishInvalidation} dispatch actually did.
 * @public
 */
export interface PublishResult { rendered: string[]; pruned: string[]; counts: { rendered: number; pruned: number } }

/**
 * Drop the routes a tag match dragged in that are holding their published version back. Withholding is a
 * property of the ROUTE, not of the full publish: a route whose record was saved after its last publish
 * serves that published file until someone publishes it. Without this, publishing one record re-renders
 * every route tagged with the collection — and every route reads the `site` singleton — from the live DB,
 * so a routine Publish writes an unrelated record's withheld body to the live site.
 *
 * A route named in `render` is exempt: it IS what the publish was for, and pressing Publish is what clears
 * the withholding. The prune set is untouched — removal has no publish intent left to protect, so an
 * unpublished or deleted record's page still goes at once (ADR-0008).
 *
 * The cost, deliberately accepted: a withheld route keeps the baked links and hreflang of its last
 * publish, so a link to a record that has since been unpublished stays stale until the referrer itself is
 * published. That is the same staleness its body already carries — a frozen route is one publish
 * generation throughout, rather than a mix of two. Rendering a referrer from its published state while
 * resolving fresh links needs a published snapshot per record, which is ADR-0008's "Future".
 */
function withheldRemoved(inv: Extract<Invalidation, { type: 'tags' }>, routes: string[], getPublished: () => PublishedRoutes): string[] {
  if (outputConfig().publishOnSave) return routes // that mode never defers a publish in the first place — getPublished() is never called
  // An un-enumerable collection contributes no `savedAt` entry, so its routes are simply not withheld —
  // the same direction publishFull takes, and the non-destructive one (a stale re-render, never a delete).
  const held = new Set(pendingRoutes(getPublished().savedAt, lastPublishedAt(usePublishingDb().db)))
  const explicit = new Set(inv.render)
  return routes.filter((route) => explicit.has(route) || !held.has(route))
}

/** Dispatch a coalesced invalidation from the queue: `full` → full publish; `tags` → re-render exactly
 *  the affected routes (deps-matched ∪ explicit `render`) + prune the `prune` routes + regen sitemap/robots
 *  (their `<lastmod>` may have changed).
 * @public
 */
export async function publishInvalidation(inv: Invalidation, driver: StorageDriver = outputDriver(), deps?: DepsStore): Promise<PublishResult> {
  if (inv.type === 'noop') return { rendered: [], pruned: [], counts: { rendered: 0, pruned: 0 } }
  if (inv.type === 'full') {
    const r = await publishFull(driver, deps) // full: counts only (don't list every route)
    return { rendered: [], pruned: [], counts: { rendered: r.rendered, pruned: r.pruned } }
  }
  // Memoized: `allPublishedRoutes()` (a full collection scan) runs AT MOST ONCE per call, and only if
  // something actually needs it — `withheldRemoved` (skipped entirely under `publishOnSave`) and the
  // locale lookup below (skipped when there are no routes to render) share this single instance instead of
  // each triggering their own scan.
  let publishedCache: PublishedRoutes | undefined
  const getPublished = () => (publishedCache ??= allPublishedRoutes())
  const routes = withheldRemoved(inv, [...new Set([...(deps?.routesForTags(inv.tags) ?? []), ...inv.render])], getPublished)
  const rendered = await publishRoutes(routes, driver, deps, routes.length ? () => getPublished().localeOf : undefined)
  let pruned: string[] = []
  // Never prune a route we just wrote live — render wins a coalesced render+prune collision (see routesToPrune).
  const toPrune = routesToPrune(inv.prune, rendered)
  if (toPrune.length) {
    await prunePages(toPrune, driver)
    for (const route of toPrune) deps?.forget(route)
    pruned = toPrune
  }
  await publishMeta(driver)
  return { rendered, pruned, counts: { rendered: rendered.length, pruned: pruned.length } }
}
