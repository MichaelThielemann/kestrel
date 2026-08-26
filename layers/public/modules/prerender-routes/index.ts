import { cpus } from 'node:os'
import { existsSync } from 'node:fs'
import { defineNuxtModule } from '@nuxt/kit'
import Database from 'better-sqlite3'
import { collectPageRoutes, pageLikeTables } from './discover'
import { localePath, resolveKestrel } from '@michaelthielemann/kestrel-core'
import type { KestrelConfig } from '@michaelthielemann/kestrel-core'
import { META_KEYS } from '@michaelthielemann/kestrel-core'
import { recordRouteDiscovery, type RouteDiscovery } from '@michaelthielemann/kestrel-delivery-static'
// Read published paths from EVERY page-like collection straight from the DB at build time so
// `nuxt generate` prerenders one HTML file per page (see `collectPageRoutes` for how pageLike tables
// are identified). The server's migrate-on-boot hasn't run yet at this point, so a DB that isn't there
// yet degrades to the root alone — reported as `incomplete`, because a deploy that reconciles must be
// able to tell that degrade apart from a CMS that genuinely holds one page.
// `reconciles` (an S3 deploy follows this build) makes an unreadable-but-present DB fail the build
// instead: there the degraded tree would also be uploaded over a real live site. Without that step there
// is nothing destructive downstream, so a degrade stays a warning.
export function discoverRoutes(path: string, primary: string, prefixPrimary: boolean, reconciles = false): RouteDiscovery {
  const root = localePath('/', primary, primary, prefixPrimary) // `/` or `/<primary>` when the primary is prefixed
  if (path === ':memory:') return { routes: [root], incomplete: 'the build ran against an in-memory database — only the site root was prerendered' }
  if (!existsSync(path)) {
    console.warn(`[kestrel] prerender: no database at ${path} — prerendering the site root only`)
    return { routes: [root], incomplete: `no database at ${path} — only the site root was prerendered` }
  }
  let db: Database.Database | undefined
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
    // Opening the file is not enumerating it: an unmigrated, zero-byte or simply wrong `KESTREL_DB` file
    // opens as a valid EMPTY database, and the root-only route list it yields is byte-identical to a
    // complete enumeration. Report the missing schema so a reconcile downstream can tell the two apart.
    if (!pageLikeTables(db).length) {
      const why = `the database at ${path} holds no page-like table — only the site root was prerendered`
      console.warn(`[kestrel] prerender: ${why}`)
      return { routes: [root], incomplete: why }
    }
    return { routes: collectPageRoutes(db, primary, prefixPrimary) }
  } catch (error) {
    const why = `cannot read the database at ${path}: ${(error as Error)?.message ?? error}`
    if (reconciles) throw new Error(`[kestrel] prerender: ${why} — refusing to ship a site with no pages to an S3 target`)
    console.warn(`[kestrel] prerender: ${why} — prerendering the site root only`)
    return { routes: [root], incomplete: why }
  } finally {
    db?.close()
  }
}

export default defineNuxtModule({
  meta: { name: 'kestrel-prerender-routes' },
  setup(_options, nuxt) {
    // Build-time: resolve directly from the consumer's config (runtimeConfig/useRuntimeConfig aren't
    // available here), rather than the request-time locale.ts globals.
    const c = resolveKestrel(nuxt.options.kestrel as KestrelConfig, process.env, nuxt.options.rootDir)
    // The editor-preview fallback page must NEVER be prerendered: the classic `nuxt generate` (static
    // preset) auto-seeds every static page path, and this page 404s without an admin session — a
    // guaranteed prerender error on every SSG build. Registered unconditionally (before the output.auto
    // early-return) so both publishing models exclude it.
    nuxt.hook('nitro:config', (nitro) => {
      nitro.prerender ||= {}
      nitro.prerender.ignore = [...(nitro.prerender.ignore ?? []), '/__kestrel/preview']
    })
    // The runtime publisher (output.auto) and build-time prerendering are mutually exclusive: a prerendered
    // `.output/public/<route>/index.html` SHADOWS the live SSR route, so the publisher's localFetch would
    // read STALE build-time HTML instead of rendering fresh. With auto on, the publisher (boot + on-write)
    // owns publishing — so skip prerender seeding entirely. (auto off = the classic `nuxt generate` SSG model.)
    if (c.output.auto) return
    nuxt.hook('nitro:config', (nitro) => {
      // Only an S3 target reconciles (deletes what this build didn't produce); a local build leaves the
      // tree on disk, so an incomplete enumeration destroys nothing there. `nitro.static` is the same flag
      // the deploy itself gates on: this hook also runs for `nuxt dev` and a plain `nuxt build`, and
      // neither ships anything, so there a degrade must stay a warning instead of failing the command.
      const reconciles = c.output.driver === 's3' && nitro.static === true
      const discovery = discoverRoutes(c.dbPath, c.primaryLocale, c.prefixPrimary, reconciles)
      // Hand the deploy module the completeness of THIS enumeration — the only step that knows it.
      recordRouteDiscovery(nuxt, discovery)
      nitro.prerender ||= {}
      // Every meta artifact EXCEPT `llms-full.txt`, which is seeded only when the consumer opted in — the
      // route 404s otherwise, and a prerender error fails the whole `nuxt generate`.
      const meta = META_KEYS.filter((k) => k !== 'llms-full.txt' || c.seo.llmsFull).map((k) => `/${k}`)
      nitro.prerender.routes = [...new Set([...(nitro.prerender.routes ?? []), ...discovery.routes, ...meta])]
      // Render pages in parallel — the dominant lever on `nuxt generate` wall-clock as page count grows.
      // Safe: page reads are synchronous better-sqlite3 (WAL + busy_timeout, can't interleave mid-statement);
      // the one WRITE on this path — the variant-registry capture — is an IMMEDIATE transaction, so
      // concurrent prerender writers (and a co-running server publisher) serialize instead of losing updates.
      // Capped to avoid memory over-subscription; overridable.
      nitro.prerender.concurrency ??= Math.min(Math.max(cpus().length, 2), 8)
    })
  },
})
