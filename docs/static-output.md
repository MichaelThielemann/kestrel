# Static output (SSG)

The CMS is consumed as a **static site generator**: editors work on a private origin, and
published content is rendered to static files for NGINX or S3 to serve. There is no live
public SSR.

## Generating

```
nuxt generate            # or: pnpm generate
```

This writes a deployable tree to `.output/public/`. Point your static host at it; assets
(`_nuxt/`) ship inside it, while uploaded media is a separate artifact set served from the
media origin (NGINX / S3), not bundled into the HTML.

## What gets prerendered

At build time the `prerender-routes` module reads the SQLite database and registers one route
per **published** page path, plus the two artifacts below:

- The site root `/` (always seeded, and rendered as an empty document before a home page exists).
- Every published page-like record's path. Primary-locale pages are unprefixed (`/about`);
  other locales are prefixed (`/de/ueber-uns`).
- `/sitemap.xml`
- `/robots.txt`
- `/llms.txt`

A route whose lookup could not *complete* — an unmigrated or drifted table, so "no page here" is
unknowable rather than true — errors instead of rendering, and no HTML is written for it. That includes
the root, which is otherwise the one path that always produces a file. The generate itself still exits 0
(`prerender.failOnError` is off by design), so check the prerender log, not the exit code. Nothing
destructive follows from it: the deploy step counts a failed route as an incomplete run and suppresses
the S3 prune, so the live page it could not re-render survives.

### What a generated page contains

A prerendered page ships more than its visible markup. Nuxt serialises the data the page resolved into a
hydration payload — inline in the HTML as `__NUXT_DATA__`, and, for a prerendered route, additionally as a
sibling `_payload.json` that client-side navigation fetches instead of re-querying the API. Both are static
files on the public site.

That payload holds the **whole record**, not the fields the template rendered: every column of the page's
own row, the `site` singleton, and — because the render populates at depth 1 — every column of each related
record under its `$<field>` sidecar. There is no projection anywhere on that path; `list()` selects the full
row and the populator attaches whatever it read.

**So any collection reachable from a page-like record's relations is public data, whatever its access
grant.** A relation from a published page into a collection holding private columns publishes those columns,
permanently, in every page that carries the relation. The access layer does not bound this and cannot: it
governs who may call the API, while the payload is written at build time by the renderer, which is
deliberately unrestricted so the baked page is complete.

To keep a column out of the bake, project the relation where it is populated — see the per-instance
`populate` override in [population.md](./population.md), and note the delegation rule there: an override
that replaces the type populator instead of delegating to it loses `captureRead`, and with it the
invalidation that re-publishes the page when the related record changes.

That is the `output.auto: false` model. On the default (`auto: true`) the **runtime publisher** owns the
static output instead — it keeps it current *while the CMS runs*, re-rendering only the routes a content
edit affects, so editors don't run a full rebuild for every change — and the route seeding above is
skipped (see below).

## Runtime incremental publishing

When `output.auto` is on (the default), the running server publishes the static site itself instead of
relying on a separate `nuxt generate`:

- **Auto-trigger.** Every content write is classified into an *invalidation* and an incremental
  republish is enqueued (debounced + coalesced + single-flight). Only the affected routes re-render:
  a **durable** route→dependency index (`publish_deps`, survives restarts) maps an edited record back to
  exactly the pages that read it (the record's own detail page + any overview that lists it), so editing
  one record doesn't re-render the whole collection. What re-renders vs prunes per event (content edit /
  publish / unpublish / delete / slug change), and why an availability change re-renders the pages that
  link to the record as well, is the **invalidation model** in
  [reference-integrity.md](./reference-integrity.md). `sitemap.xml` / `robots.txt` regenerate too (a
  `<lastmod>` may have changed).
- **Boot publish.** A full publish on startup resyncs this build's hashed `_nuxt` bundle and re-records
  every route's dependencies. Detached, so it never blocks boot.
- **Reconciler.** An optional periodic full publish (`output.reconcileMinutes`, default `0` = off)
  self-heals any missed invalidation and picks up time-based publishing no write event would trigger.

The target is the same `output` block as the `generate` deploy — a local dir (default `.data/published`)
or an S3 bucket. Pruning the static files of unpublished/deleted/renamed pages is **always on** (output ≡
DB, no toggle): the publisher tracks every route it wrote in a durable index and removes the ones that
leave the published set, on every target. Because the
runtime publisher owns the output, **build-time prerender is skipped when `output.auto` is on** (the
`prerender-routes` module bails), so the two never fight over the same tree. Set `output.auto: false`
to opt back into the pure `nuxt generate` flow.

```ts
// kestrel.config.ts
export default {
  output: {
    auto: true,            // publish on content writes (default)
    dir: '.data/published', // local target (or use driver:'s3' + s3:{…})
    reconcileMinutes: 0,    // optional periodic full reconcile
    verbose: false,         // log a timestamped per-route line (rendered/pruned) per incremental run
  },
} satisfies KestrelConfig
```

The publisher reads this `output` block from the frozen `runtimeConfig`, so its `KESTREL_OUTPUT_*` env
equivalents count only in the environment that builds the app; on a prebuilt server use the runtimeConfig
names (`NUXT_KESTREL_OUTPUT_DIR`, `NUXT_KESTREL_OUTPUT_AUTO`, …).

`output.verbose` (or `KESTREL_OUTPUT_VERBOSE=1`) adds, on top of the one-line summary, a timestamped
per-route line for each incremental republish — `[kestrel] <ISO ts> rendered <path>` / `pruned <path>` —
for traceability while editing. A boot / reconciler full publish stays a count summary (it's a bulk resync).

The publisher renders each route from the **live** server in-process (the same handler `nuxt generate`
uses), under a renderer principal, and is always **published-only** — a draft never reaches the static
output even though that principal can read everything.

**Per-route publish status.** Each publish attempt records its outcome in a durable `publish_status` table
(one latest-state row per route, not a history): `success` once the file is written, or `error` — with the
failure message (render / write / **S3**) — when an attempt throws. A failing route is isolated: it is
recorded and logged, and the rest of the run continues. A prune (unpublish / delete / slug change) clears
the route's row, so it reads as "not live". The admin editor reads this through the admin-only
`GET /api/publish-status?collection=&id=` to show whether a record's page is actually generated (the right
Ampel dot below). In **dev** the publisher is off, so there are no rows and the dot reads amber ("pending").

> In **dev** the publisher is intentionally disabled (a dev render would write un-hashed Vite HTML).
> Use it from a production build (`nuxt build` + run the node server, or `pnpm preview`).

## Live preview (editor)

Public pages are also retrievable from the running CMS like a normal CMS, which powers an in-editor
preview:

- The editor toolbar has an **"open in new tab"** button (shown once a page has a saved, routable path)
  that opens the record at its real public URL.
- An authenticated admin can preview an **unpublished** page at that URL: the public render entry
  (`GET /api/route`) is readable by everyone but **scoped per principal** — anonymous and the static
  render stay published-only, while the admin session resolves drafts. A small "Draft preview" badge
  marks an unpublished page so it's never mistaken for live. Drafts therefore never leak to the static
  site or to anonymous visitors.
- A two-dot status **Ampel** in the toolbar. The **left** dot is the change/draft lifecycle: amber
  (unsaved / saving), blue (saved Draft — off the live site), green (saved / published). The **right** dot
  (pageLike collections only) is the live / **generated** state of this record's static page, read from
  `publish_status`: green (published and the route's last publish succeeded), red (the last publish
  errored — the tooltip shows the message, incl. S3, and when), amber (published but not generated yet —
  republish in flight, or dev), blue (a Draft, intentionally not generated). The right dot carries a
  tooltip with the localized label, the last-published time, and the error text on a failure; it refreshes
  on load and after each save.

A full rebuild via `nuxt generate` remains available as the alternative model — set `output.auto: false`
so the build-time prerenderer seeds the routes again (with `auto` on it seeds none, and a `generate` would
emit only what Nitro's crawler reaches).

## Per-page head (canonical · Open Graph · hreflang)

Every generated page emits, from its `seo` data and `KESTREL_SITE_URL`:

- `<title>` / `<meta name="description">` (from `seo.title`/`seo.description`, falling back to the record title),
  and `robots: noindex,nofollow` when `seo.noindex` is set.
- `<link rel="canonical">` and `og:url` — the page's own absolute, locale-prefixed URL.
- Open Graph + Twitter card: `og:title`/`og:description`/`og:type`/`og:site_name` and `twitter:card`. Set
  `seo.image` (a media id, picked in the editor's SEO panel) to add `og:image` (+ its width/height) and
  upgrade the card to `summary_large_image`.
- `<link rel="alternate" hreflang="…">` for each **published** translation of the page, plus `x-default` at
  the primary-locale variant — the page-level counterpart to the sitemap's hreflang set.

Everything that needs an absolute URL (canonical, `og:url`, hreflang, a relative `og:image`) is **omitted**
when `KESTREL_SITE_URL` is unset; the plain title/description/OG-text tags still render.

## sitemap.xml

Lists every **published, indexable** record across all page-like collections:

- Drafts (`status != 'published'`) and records with `seo.noindex = true` are excluded.
- `<loc>` is absolute when `KESTREL_SITE_URL` is set (see below), and carries the same
  locale prefixing as the page routes.
- `<lastmod>` is the record's `updatedAt`.
- For a translatable page with two or more published, indexable locale variants, each `<url>`
  carries `<xhtml:link rel="alternate" hreflang="…">` for every sibling variant plus an
  `hreflang="x-default"` pointing at the primary-locale variant (when it exists). The `xhtml`
  namespace is declared on `<urlset>` only when alternates are present; single-locale and
  non-translatable pages are unaffected.

The route filters status and `noindex` itself, so it is safe to serve publicly and to
prerender — drafts never leak.

## robots.txt

```
User-agent: *
Allow: /
# llms.txt: <KESTREL_SITE_URL>/llms.txt

Sitemap: <KESTREL_SITE_URL>/sitemap.xml
```

The `Sitemap:` directive and the `llms.txt` comment are emitted only when `KESTREL_SITE_URL` is set.

## llms.txt

An [llmstxt.org](https://llmstxt.org) site map for AI agents: the site name + description (from
`siteName` / `siteDescription`), then one section per page-like collection listing its published,
indexable records — the same set the sitemap advertises. It is referenced from `robots.txt` (the comment
above) and a `<link rel="alternate" type="text/markdown" href="/llms.txt">` in every public page's
`<head>`.

```
# Example

> What this site is about.

## Pages

- [Home](https://www.example.com/): The landing page.
- [About](https://www.example.com/about)
```

## Configuring the site URL

Set `KESTREL_SITE_URL` to the public origin so the sitemap emits absolute URLs and robots can
point at it:

```
KESTREL_SITE_URL=https://www.example.com
```

When unset, sitemap `<loc>` values fall back to root-relative paths and the robots `Sitemap:`
line is omitted. Set it for any real deployment.

Like every non-auth setting it is read when the app is **built** (see
[configuration.md › When the environment is read](./configuration.md#when-the-environment-is-read--build-time-not-request-time)).
A server that was built without it needs the runtimeConfig names — `NUXT_KESTREL_SITE_URL` (sitemap /
robots / llms.txt) and `NUXT_PUBLIC_SITE_URL` (the per-page canonical / OG / hreflang head) — not
`KESTREL_SITE_URL`.

## Output target: local directory or S3

By default `nuxt generate` writes the static site to `.output/public` — that tree **is** the artifact;
ship it however you like (NGINX, a bucket, `aws s3 sync`, etc.).

Setting the output driver to `s3` makes `generate` also push that tree to a bucket at the end of the
run, so a single `nuxt generate` builds **and** deploys. It's the deploy half of FEATURES "Output
target: local directory or S3 bucket", and reuses the same SigV4 S3 client (`aws4fetch`) as the media
driver.

**This build-time deploy needs `output.auto: false`.** With `auto` on (the default) the running server
publishes to that same bucket itself, and `nuxt generate` **skips the deploy entirely** — it also seeds no
prerender routes (only what Nitro's crawler reaches ends up in `.output/public`), so shipping that tree
would reconcile the server's live pages away. A `generate` in that configuration logs
`[kestrel] output.auto is on — …` and uploads nothing. Pick one model: `auto: true` (server publishes) or
`auto: false` (`generate` deploys).

The deploy runs on Nitro's `compiled` hook — once the **full** output is on disk (prerendered HTML,
the `_nuxt` client bundle + static `public/` assets, and any compressed `.gz`/`.br` variants). It
fires **only on a real `nuxt generate`** (`nitro.options.static`); a plain `nuxt build` or `dev` never
deploys, so it can't clobber the live bucket with a partial build. Nitro does **not** abort a generate
on a route that failed to render (`prerender.failOnError` is off by default), so the deploy checks for
that itself — see the reconcile rules below.

```ts
// kestrel.config.ts — non-secret settings
export default {
  output: {
    driver: 's3',
    s3: { bucket: 'my-site', region: 'eu-central-1', prefix: 'prod', endpoint: '' }, // endpoint for R2/MinIO; prefix required
  },
} satisfies KestrelConfig
```

Per setting: `KESTREL_OUTPUT_* → config → default`. Env equivalents: `KESTREL_OUTPUT_DRIVER`,
`KESTREL_OUTPUT_S3_BUCKET` / `_REGION` / `_ENDPOINT` / `_PREFIX`. **Credentials are env-only** — the
output-specific `KESTREL_OUTPUT_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` (and optional `_SESSION_TOKEN`),
falling back to the shared media `KESTREL_S3_*` keys when unset — never in committed config. Files are uploaded keyed by their path under
`.output/public`, with a `Content-Type` inferred from the extension (the common static-asset types;
unknown binaries fall back to `application/octet-stream`). A `.gz`/`.br` file whose uncompressed sibling
is also in the tree is a pre-compressed sidecar and is **skipped** — a plain static host does no
`Accept-Encoding` negotiation, so nobody would ever fetch it; a standalone archive with no base file is
real content and ships. Uploads run with bounded concurrency and
each file is retried with backoff, so a transient S3 error rides out instead of half-updating the
bucket; only a file that fails every attempt fails the deploy.

`KESTREL_OUTPUT_DRY_RUN` (any of `1` / `true` / `yes` / `on`) walks the output and logs how much it would
upload without touching the bucket — useful to confirm wiring, and the one case where a missing
bucket/credentials is tolerated. With `driver: local` the deploy is a no-op. With `driver: s3` but a
**missing bucket or credentials**, a real (non-dry-run) `generate` **fails loudly** rather than
silently exiting 0 and leaving a stale live bucket.

### Reconcile (`--delete`, on by default)

The sync **reconciles by default**: after uploading, it deletes remote objects under the prefix that the
current generate didn't produce, so pages removed from the CMS stop being served (output ≡ DB — there is
no opt-in toggle). Deletes run with the same bounded concurrency + retry as uploads, and a dry-run
(`KESTREL_OUTPUT_DRY_RUN`) reports how many objects it *would* delete without touching the bucket.

**Only a reported failure withholds the prune.** A prune treats "not in this build" as "removed from the
CMS", so a build that came out short would delete live pages. The deploy therefore uploads but skips the
delete pass — **all** of it, stale assets included — when a build step *reports* that it could not
enumerate the site:

- **Routes failed to prerender.** Nitro reports them on `prerender:done` and (with the default
  `failOnError: false`) still exits 0; their pages are missing from the output but very much alive.
- **Route discovery could not read the pages out of the database.** No DB file at build time, an in-memory
  DB, or a file that opens but holds no page-like table at all (unmigrated, zero-byte, or `KESTREL_DB`
  pointing at some other sqlite file). Each of those is reported, so the root-only route list they produce
  is never mistaken for a CMS that genuinely holds one page. A DB that is *present but unreadable* fails a
  `nuxt generate` outright when the target is S3, rather than shipping a site with no pages over the live
  one; `nuxt dev` and a plain `nuxt build` only warn, since neither deploys.

Nothing is ever withheld because of how the output *looks*: a build that legitimately produced a single
page reconciles like any other. No shape of output distinguishes a degraded build from a small site, so
inferring one would strand the pages an editor deleted.

The reason is logged (`[kestrel] skipping reconcile — …`) and the pages that *did* render are still
uploaded. A stale object left behind is recoverable; a deleted page is not. Fix the failing routes
(or set `nitro.prerender.failOnError` to fail the build instead) and re-run to get a full reconcile.

Because the reconcile deletes, an S3 deploy **requires a non-empty `s3.prefix`** dedicated to the
generated site: reconciling the bucket root would delete everything not in this generate — including a
media bucket sharing the same bucket — so a real deploy with an empty (or media-overlapping) prefix
**fails loudly** instead. Point `output` at its own bucket, or give it a prefix the media driver doesn't
use.

## Serving the generated site from S3

Expose the output bucket exactly like a media bucket — a public read policy or CloudFront + OAC (see
[media-uploads.md › Exposing the bucket](./media-uploads.md#exposing-the-bucket)). Two output-specific
points beyond that:

- **Clean URLs.** `generate` writes `about/index.html`, not `about.html`. The S3 **REST** endpoint does
  *not* map `/about` → `/about/index.html`, so either serve via the S3 **website** endpoint (which applies
  the index document) or front the bucket with CloudFront using a default-root-object of `index.html` plus
  a viewer-request function that rewrites an extensionless / trailing-slash path to `…/index.html`.
- **Caching.** The deploy sets `Content-Type` **and** `Cache-Control` on every object: long-lived
  `public, max-age=31536000, immutable` for the content-hashed `_nuxt/` assets, and
  `public, max-age=0, must-revalidate` for the stable-URL `*.html` pages + `sitemap.xml` + `robots.txt` +
  `llms.txt` (and Nuxt's `_nuxt/builds/latest.json` app manifest) so edits go live promptly. Everything
  else (favicons, fonts, un-hashed media) is left to the host default.

## Redirects

Redirects are handled at the NGINX / S3 edge, not at runtime — there is no runtime redirect
engine.
