import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getTableColumns } from 'drizzle-orm'
import type { StorageDriver } from '../../../../core/server/utils/storage'
import { createLocalDriver } from '../../../../core/server/utils/storage.local'
import { createS3Driver } from '../../../../core/server/utils/storage.s3'
import { contentTypeFor, cacheControlFor, precompressedEncoding } from '../../../modules/deploy-output/deploy-output'
import { localePath } from '../../../../core/app/utils/locale-path'
import { pageRowHref } from '../../../../core/server/utils/page-route'
import { withReadCapture } from '../../../../core/server/utils/read-capture'
import { withResolveScope } from '../../../../core/server/utils/resolve-scope'
import { runAsRenderer } from '../../../../access/server/utils/render-context'
import { htmlKeyForRoute } from './route-keys'
import { staleRoutes, type DepsStore } from './deps'
import { recordPublishStatus, clearPublishStatus, renderOutcome, lastPublishedAt } from './publish-status'
import { routesToPrune, type Invalidation } from './invalidation'
import { pendingRoutes, heldRoutes } from './pending'

/**
 * The runtime static publisher: renders public routes from the LIVE server (`localFetch`, the same
 * handler `nuxt generate` uses) and writes them — plus the built `_nuxt` bundle + assets — through the
 * configured output StorageDriver (local dir or S3). This is the engine the manual `publish:run` task
 * and (later) the auto-trigger queue both drive. NOT unit-tested (needs a running build); the pure
 * pieces it composes (route-keys, invalidation, deps, queue) are.
 */

interface OutputRc {
  driver: 'local' | 's3'
  dir: string
  publicDir: string
  auto: boolean
  publishOnSave: boolean
  reconcileMinutes: number
  verbose: boolean
  s3: { bucket: string; region: string; endpoint: string; prefix: string; accessKeyId: string; secretAccessKey: string; sessionToken: string }
}

export function outputConfig(): OutputRc {
  return (useRuntimeConfig().kestrel as { output: OutputRc }).output
}

/** Build the output driver from runtimeConfig (local dir or S3 bucket) — separate from the media driver. */
export function outputDriver(cfg: OutputRc = outputConfig()): StorageDriver {
  if (cfg.driver === 's3') {
    return createS3Driver({
      bucket: cfg.s3.bucket, region: cfg.s3.region, endpoint: cfg.s3.endpoint || undefined, prefix: cfg.s3.prefix,
      publicBaseUrl: '', accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey, sessionToken: cfg.s3.sessionToken || undefined,
    })
  }
  return createLocalDriver({ dir: cfg.dir, baseUrl: '/' })
}

/** Render a public route via the in-process server, returning its HTML buffer (200) or a null body with the
 *  HTTP status, so the caller can tell a broken page (5xx — a server-error RESPONSE, not a throw) from an
 *  expected non-200 (a draft / unpublish race → 404 / redirect). */
export async function renderRoute(route: string): Promise<{ body: Buffer | null; status: number }> {
  // Run as the renderer principal so the nested $fetch('/api/route') passes the access guard (it is not a
  // public endpoint). The ALS context propagates through localFetch → the page render → the nested fetch.
  // useNitroApp is imported LAZILY (not via the Nitro auto-import) on purpose: a static import gives this
  // module an edge to nitropack's app.mjs, which both defines useNitroApp AND loads the plugin registry
  // that reaches this file (via zz.publish) — a build-time circular dependency. A dynamic import is a chunk
  // boundary, so that cycle disappears from the build graph; it's the same nitroApp singleton either way
  // (Rollup bundles the literal specifier; useNitroApp is only CALLED here at publish time, long after boot).
  const { useNitroApp } = await import('nitropack/runtime')
  const res = await runAsRenderer(() => useNitroApp().localFetch(route, { method: 'GET', headers: { 'x-kestrel-publish': '1' } }))
  if (res.status !== 200) return { body: null, status: res.status }
  return { body: Buffer.from(await res.arrayBuffer()), status: res.status }
}

/** The enumerated published routes plus the collections whose query failed. `failed` is non-empty ⇒ the
 *  route set is INCOMPLETE, so it must never be used as the authority for what to delete. */
export interface PublishedRoutes {
  routes: string[]
  /** Each route's record `updatedAt` in ms — the "last saved" half of the saved-vs-published comparison. */
  savedAt: Map<string, number>
  /** Each route's owning record as its deps tag (`<coll>:<id>`) — route strings move on a rename, records
   *  do not, so withholding a renamed page needs the identity behind the route. */
  recordTag: Map<string, string>
  /** Names of collections whose route query threw (drifted schema, locked DB) — routes are missing. */
  failed: string[]
}

/** Every published, publicly-readable page-like route (across collections) + the site root — the
 *  runtime analogue of the prerender/sitemap route enumeration. noindex pages ARE published (real
 *  reachable pages); only the sitemap omits them. */
export function allPublishedRoutes(): PublishedRoutes {
  const db = useDb()
  const primary = primaryLocale()
  const prefixPrimary = prefixPrimaryLocale()
  const pub = publicReadableResources()
  const routes = new Set<string>([localePath('/', primary, primary, prefixPrimary)]) // `/` or `/<primary>`
  const savedAt = new Map<string, number>()
  const recordTag = new Map<string, string>()
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
      const saved = row.updatedAt
      if (saved instanceof Date) savedAt.set(route, saved.getTime())
      else if (typeof saved === 'number') savedAt.set(route, saved)
      // The same tag the publisher records against a rendered route, so a route can be traced back to its
      // record even after a rename moved the route string.
      if (typeof row.id === 'number') recordTag.set(route, `${c.def.name}:${row.id}`)
    }
  }
  return { routes: [...routes], savedAt, recordTag, failed }
}

/** Render + write the given routes (skips non-200). When `deps` is given, each render is wrapped in a
 *  read-capture and its data tags recorded, so a later write maps back to the routes it affects. */
export async function publishRoutes(routes: string[], driver: StorageDriver, deps?: DepsStore): Promise<string[]> {
  // One UNBUDGETED resolve scope for the whole run: a media/link/relation shared across pages resolves
  // once per publish instead of once per embedding page (the runtime analogue of the generate build's
  // memoDuringPrerender). Memo hits replay their read-tags, so each page's dep capture stays complete.
  return withResolveScope(() => publishRoutesInScope(routes, driver, deps))
}

async function publishRoutesInScope(routes: string[], driver: StorageDriver, deps?: DepsStore): Promise<string[]> {
  const written: string[] = []
  const db = useDb()
  const target = outputConfig().driver
  for (const route of routes) {
    try {
      const { result, tags } = await withReadCapture(() => renderRoute(route))
      const outcome = renderOutcome(result.status, !!result.body)
      if (outcome === 'success') {
        deps?.record(route, tags)
        const key = htmlKeyForRoute(route)
        await driver.put(key, result.body!, contentTypeFor(key), { cacheControl: cacheControlFor(key) })
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

/** Delete the given routes' static files (idempotent) — unpublish / delete / old-path prune. */
export async function prunePages(routes: string[], driver: StorageDriver): Promise<void> {
  // pruneEmptyDirs: a page is `<path>/index.html`, so removing it must also clear the now-empty `<path>/`.
  const db = useDb()
  for (const route of routes) {
    await driver.delete(htmlKeyForRoute(route), { pruneEmptyDirs: true })
    clearPublishStatus(db, route) // the file is gone → no live status (after the delete, so a failed delete keeps the row)
  }
}

/** Render + write sitemap.xml, robots.txt and llms.txt (served at literal keys, not `<path>/index.html`). */
async function publishMeta(driver: StorageDriver): Promise<void> {
  for (const key of ['sitemap.xml', 'robots.txt', 'llms.txt']) {
    const { body } = await renderRoute(`/${key}`)
    if (body) await driver.put(key, body, contentTypeFor(key), { cacheControl: cacheControlFor(key) })
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
      if (!e.isFile() || base.endsWith('.html') || base === 'sitemap.xml' || base === 'robots.txt' || base === 'llms.txt') continue
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
 *  triggers is the publish queue's job. */
export async function publishFull(driver: StorageDriver = outputDriver(), deps?: DepsStore): Promise<{ rendered: number; pruned: number }> {
  const cfg = outputConfig()
  // Keep the registry read (`allPublishedRoutes` → `allCollections()`) AFTER this first `await`: on a
  // boot publish it lets the synchronous Nitro plugin loop — including collections/01.register, which
  // runs late (layer-then-filename order) — finish populating the registry first. Moving the read before
  // an await would silently render an empty registry. See docs/architecture.md → "Server plugins".
  await syncStaticAssets(driver, cfg.publicDir)
  const { routes, savedAt, recordTag, failed } = allPublishedRoutes()
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
    : heldRoutes(savedAt, lastPublishedAt(useDb()), recordTag, (tag) => deps?.routesForTags([tag]) ?? [])
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

  // Reset the discovery accumulator so this full run reconciles ONLY what it actually renders — an earlier
  // incremental (tag) publish also feeds the accumulator, and a variant it recorded whose usage was later
  // removed would otherwise survive and be re-registered here (defeating usage-driven narrowing).
  clearVariants()
  const written = await publishRoutes(renderRoutes, driver, deps)
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

/** Dispatch a coalesced invalidation from the queue: `full` → full publish; `tags` → re-render exactly
 *  the affected routes (deps-matched ∪ explicit `render`) + prune the `prune` routes + regen sitemap/robots
 *  (their `<lastmod>` may have changed). */
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
function withheldRemoved(inv: Extract<Invalidation, { type: 'tags' }>, routes: string[]): string[] {
  if (outputConfig().publishOnSave) return routes // that mode never defers a publish in the first place
  // An un-enumerable collection contributes no `savedAt` entry, so its routes are simply not withheld —
  // the same direction publishFull takes, and the non-destructive one (a stale re-render, never a delete).
  const held = new Set(pendingRoutes(allPublishedRoutes().savedAt, lastPublishedAt(useDb())))
  const explicit = new Set(inv.render)
  return routes.filter((route) => explicit.has(route) || !held.has(route))
}

export async function publishInvalidation(inv: Invalidation, driver: StorageDriver = outputDriver(), deps?: DepsStore): Promise<PublishResult> {
  if (inv.type === 'noop') return { rendered: [], pruned: [], counts: { rendered: 0, pruned: 0 } }
  if (inv.type === 'full') {
    const r = await publishFull(driver, deps) // full: counts only (don't list every route)
    return { rendered: [], pruned: [], counts: { rendered: r.rendered, pruned: r.pruned } }
  }
  const routes = withheldRemoved(inv, [...new Set([...(deps?.routesForTags(inv.tags) ?? []), ...inv.render])])
  const rendered = await publishRoutes(routes, driver, deps)
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
