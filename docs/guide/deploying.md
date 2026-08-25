# Building and deploying

This page covers everything between `nuxt generate` and a live site: what gets built, the
production environment, and where the output goes.

## Generating

`output.auto` (default `true`) picks which of two things is your deployable tree:

- **`auto: true` (default)** — the running server publishes pages itself as content changes,
  writing them to `output.dir` (default `.data/published`). `nuxt generate` seeds no prerender
  routes at all under this default; that directory is what you deploy.
- **`auto: false`** — `nuxt generate` prerenders the whole site at build time and writes it to
  `.output/public/`, which becomes the deployable tree instead. Point your static host at it.

```bash
nuxt generate    # or: pnpm generate
```

Under the default `media.driver: 'local'`, `generate` also bakes the upload directory into
whichever tree it writes, at `/uploads`, then deletes every baked file no generated page
references — skipping the prune entirely (leaving the full bake in place) when the media registry
itself can't be read at build time. See [media.md](./media.md). Only `media.driver: 's3'` serves
uploads from a separate media origin instead.

## What gets prerendered

**This section describes `output.auto: false`.** Set `auto: false` to get the route list below.

With `auto: false`, at build time Kestrel registers one route per **published** page-like record,
plus:

- The site root `/` (always seeded, rendered as an empty document before a home page exists) —
  or `/<primaryLocale>` instead, when `prefixPrimaryLocale` is on; see
  [multilingual.md](./multilingual.md).
- Every published page's path — primary-locale pages unprefixed (`/about`), other locales
  prefixed (`/de/ueber-uns`), unless `prefixPrimaryLocale` changes the primary-locale case too.
- `/sitemap.xml`, `/robots.txt`, `/llms.txt`.
- `/llms-full.txt`, only when `seo.llmsFull` is on.
- `/redirects.json` — see [redirects.md](./redirects.md).

A route whose lookup could not complete (an unmigrated or drifted database) errors instead of
rendering, and the generate still exits `0` — check the prerender log, not the exit code. A
deploy counts a failed route as an incomplete run and withholds the S3 prune, so a live page that
could not be re-rendered stays up rather than disappearing. See
[troubleshooting.md](./troubleshooting.md) for what causes an incomplete run.

## Every rendered page leaks its full payload

A rendered page ships more than its visible markup, on **either** model. Nuxt serialises the full
data payload the page resolved into the HTML — plus a sibling `_payload.json` on the `auto: false`
prerender path — and that payload holds the **whole record**, not just the fields the template
rendered: every column of the page's own row plus every column of each related record pulled in at
populate depth 1. Any collection reachable from a page-like record's relations is therefore public
data, whatever its access grant — permanently, in every page carrying that relation. This applies
just as much to the default `auto: true` model, where the running server's live render inlines the
same resolved payload into the HTML it serves. Project the relation to keep a column out of the
bake; see the per-instance `populate` override in
[../internals/populate.md](../internals/populate.md).

## Production environment variables

A production run needs three settings before login works:

- `KESTREL_SESSION_SECRET` — required, at least 32 bytes (`openssl rand -hex 32`). Checked per
  request, not at boot, so a deploy that forgets it still starts and binds the port — every
  `/api/*` request then answers `500` until it is set.
- `KESTREL_ADMIN_PASSWORD_HASH` — required, generated with `pnpm kestrel hash-password <password>`;
  see [getting-started.md](./getting-started.md).
  Without it `POST /api/login` answers `503` rather than a wrong-password `401`.
- `KESTREL_SECURE_COOKIES` — leave it at its default (`true`). Production *refuses* `=false`
  outright. The session cookie is `Secure`/`__Host-`, and browsers accept those over plain
  `http://localhost`, so local login still works without HTTPS.

Beyond env vars, a production deploy also needs the database and the session-revocation epoch file
on persistent storage — restoring an older epoch resurrects revoked sessions. See
[configuration.md § State & backups](./configuration.md#state--backups).

## Build-time vs runtime configuration

The non-auth `KESTREL_*` variables (database path, site URL, output target, …) are read once,
when the app is **built** — a server started from an already-built `.output/` ignores them
entirely. A **prebuilt** server that needs different values takes Nuxt's runtime-config names
instead: `NUXT_KESTREL_DB_PATH` for the database path, `NUXT_KESTREL_SITE_URL` for the site
origin, `NUXT_KESTREL_OUTPUT_DIR` / `NUXT_KESTREL_OUTPUT_AUTO` for the publish target, and
`NUXT_PUBLIC_SITE_URL` for the client-side canonical/OG/hreflang head. The auth variables above
are the exception — they are read per request, so exporting them works either way.

See [configuration.md § Precedence](./configuration.md#precedence) for the full variable list and
how it applies beyond deployment.

## Configuring the site URL

```bash
KESTREL_SITE_URL=https://www.example.com
```

Set it for any real deployment so the sitemap emits absolute URLs and `robots.txt` can point at
it. See [./seo.md § sitemap.xml](./seo.md#sitemapxml) for what happens when it's unset.

## Output target: local directory or S3

With `output.auto: false`, `nuxt generate` writes to `.output/public` — that tree *is* the
artifact; ship it however you like (NGINX, a bucket, `aws s3 sync`, …).

Setting the output driver to `s3` makes `generate` also push that tree to a bucket at the end of
the run, reusing the same S3 client the media driver uses:

```ts
// kestrel.config.ts — non-secret settings
export default {
  output: {
    driver: 's3',
    s3: { bucket: 'my-site', region: 'eu-central-1', prefix: 'prod', endpoint: '' }, // endpoint for R2/MinIO
    auto: false,
  },
} satisfies KestrelConfig
```

**This build-time deploy needs `output.auto: false`.** With `auto` on (the default) the running
server publishes to that bucket itself on every content change, and `nuxt generate` skips the
deploy entirely — it also seeds no prerender routes, so shipping its (near-empty) `.output/public`
tree would reconcile the server's live pages away. Pick one model: `auto: true` (server
publishes incrementally) or `auto: false` (`generate` deploys the whole site each run). The S3
push only fires on a real `nuxt generate` — a plain `nuxt build` or `nuxt dev` never deploys.

Settings resolve as `KESTREL_OUTPUT_* → config → default`: env equivalents are
`KESTREL_OUTPUT_DRIVER`, `KESTREL_OUTPUT_S3_BUCKET` / `_REGION` / `_ENDPOINT` / `_PREFIX`.
**Credentials are env-only** — `KESTREL_OUTPUT_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` (and
optional `_SESSION_TOKEN`), falling back to the shared media `KESTREL_S3_*` keys when unset —
never in committed config. Uploaded files get a `Content-Type` inferred from their extension. A
`.gz`/`.br` file whose uncompressed sibling is also present is a pre-compressed sidecar and is
skipped, since a plain static host does no `Accept-Encoding` negotiation; a standalone compressed
file with no base sibling ships as real content.

`KESTREL_OUTPUT_DRY_RUN` (`1`/`true`/`yes`/`on`) walks the output and logs how much it would
upload without touching the bucket — the one case where a missing bucket or missing credentials
is tolerated. With `driver: local` the deploy is a no-op; with `driver: s3` and a real (non-dry-run)
run, a missing bucket or credentials **fails the build loudly** instead of silently leaving a
stale live bucket. The same flag also makes the generate-time media prune (above) report the baked
files it would remove instead of deleting them.

### Reconcile (always on)

The sync always reconciles, the way `aws s3 sync --delete` would: after uploading, it deletes
remote objects under the prefix that the current generate did not produce, so pages removed from
the CMS stop being served — there is no toggle to turn this off. Deletes run with the same bounded
concurrency and retry as uploads,
and `KESTREL_OUTPUT_DRY_RUN` reports how many objects it *would* delete without touching the
bucket.

**Only a reported failure withholds the prune.** When a build step reports that it could not
fully enumerate the site — a route that failed to prerender, a missing database file, a database
holding no page-like table, or an in-memory (`:memory:`) database — the deploy still uploads what
did render, but skips the delete pass entirely, all of it, because deleting on an incomplete build
would strand live pages the build simply failed to reach. The reason is logged
(`[kestrel] skipping reconcile — …`). A database that *exists* but can't be read is a different
case on an S3 target: the generate refuses to run at all rather than ship a site with no pages,
since it cannot even tell what to reconcile. See [troubleshooting.md](./troubleshooting.md) for
the specific conditions that trigger this and how to fix them. Nothing is ever withheld because of
how the output *looks* — a legitimately small site reconciles like any other; only a reported
failure does.

Because the reconcile deletes, an S3 deploy **requires a non-empty `s3.prefix`** dedicated to the
generated site — reconciling the bucket root would delete everything not in this generate,
including a media bucket sharing the same bucket. A deploy with an empty or media-overlapping
prefix fails loudly instead. Point `output` at its own bucket, or give it a prefix the media
driver doesn't use.

## Serving the generated site from S3

Expose the output bucket exactly like a media bucket — a public read policy or CloudFront with
Origin Access Control; see [media.md](./media.md) for the walkthrough. Two points specific to the
generated site:

- **Clean URLs.** `generate` writes `about/index.html`, not `about.html`. The S3 REST endpoint
  does not map `/about` to `/about/index.html`, so either serve via the S3 **website** endpoint
  (which applies the index document) or front the bucket with CloudFront using a default root
  object of `index.html` plus a viewer-request function that rewrites an extensionless or
  trailing-slash path to `…/index.html`.
- **Caching.** The deploy sets long-lived, immutable caching on the content-hashed `_nuxt/`
  assets, and a short, must-revalidate cache on the stable-URL `*.html` pages, `sitemap.xml`,
  `robots.txt`, `llms.txt`, `llms-full.txt`, `redirects.json`, and the Nuxt app manifest, so edits
  go live promptly. Everything else (favicons, fonts, un-hashed media) is left to the host
  default.
- **Redirects.** `redirects.json` is inert on its own — the bucket does not act on it. An edge
  handler (an NGINX or CloudFront-function rule in front of the static origin) has to read it and
  answer the redirect before the origin is touched; see [redirects.md](./redirects.md) for what
  that handler needs.

## Simulating a production deploy locally

A real deployment is two processes: the private CMS server that renders the static files, and a
public static host that serves them. Rehearse that split on one machine:

```bash
pnpm build
pnpm preview                 # built server, NODE_ENV=production → admin at http://localhost:3000/admin
                              #   boot publish writes .data/published; use the editor's Publish
                              #   button (or POST /api/publish) to push further changes

# in a second terminal — serve the generated site like a CDN would:
npx serve .data/published
```

`pnpm preview` runs the build under `NODE_ENV=production` and loads `.env` — running
`node .output/server/index.mjs` directly does not, so export the variables yourself if you go that
route. Watch the CMS terminal: boot prints a line like

```
[kestrel] published 12 route(s) (pruned 0)
```

By default (`output.publishOnSave: false`) a save writes the DB and leaves the live output alone —
only unpublishing or deleting a record prunes its page immediately. Publishing a route re-renders
it and logs the same line, naming the routes it wrote for an incremental run. Set
`output.publishOnSave: true` to have every save republish instead; see
[publishing.md § Opting out: `publishOnSave`](./publishing.md#opting-out-publishonsave).

## See also

- [configuration.md](./configuration.md) — the full environment variable reference and precedence
  rules.
- [publishing.md](./publishing.md) — save vs publish, `publishOnSave`, boot publish and the
  incremental publisher.
- [redirects.md](./redirects.md) — authoring redirects and the `redirects.json` artifact this
  page's deploy ships.
- [media.md](./media.md) — exposing an S3 bucket behind CloudFront, shared by media and output
  storage.
- [troubleshooting.md](./troubleshooting.md) — diagnosing an incomplete build or a skipped
  reconcile.
