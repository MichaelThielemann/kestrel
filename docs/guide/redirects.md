# Redirects

How to author CMS-managed redirects, what the emitted `redirects.json` artifact looks like, and how an edge handler consumes it.

Redirects are **authored in the CMS** and, under the default `delivery: 'static'`, **served at the
edge**: what Kestrel publishes is a small JSON artifact, and an NGINX / CloudFront / njs handler in front
of the static origin reads it and answers 30x before the origin is touched. Under `delivery: 'live'` the
app is its own edge and honours these rules itself, ahead of the published page lookup — a rule whose
`From` matches a live page redirects instead of serving it, the same precedence the edge handler has since
it sits ahead of `proxy_pass` — see [Publishing](./publishing.md).

## Authoring

The built-in **Redirects** singleton holds one repeater: a list of rules, each with a source path, a
target and a status. Row order is priority — the first rule that matches wins, so the most specific
rule belongs at the top; nothing is auto-sorted by specificity, because a UI that silently reorders is
impossible to reason about from the editor.

- **`From`** is a path, never a regex. `*` matches exactly one path segment; `**` matches one or more.
  A missing leading slash is added, an authored trailing slash is dropped, and a trailing slash on the
  request is tolerated — `/blog` and `/blog/` are the same rule. Matching is case-sensitive and
  path-only: a query string, a fragment or a scheme/host in `From` is rejected at save time — as are a
  backslash, a `..` segment and two adjacent `**`. A `From` of `/` is a valid rule and matches only the
  site root — this is how `/` → `/<primary>` is authored when `prefixPrimaryLocale` is on. Rules are
  matched globally: no locale prefix is added to either side, so a rule with a locale prefix in `From`
  applies to that locale only, and one without applies to every locale.
- **`To`** is a path (`/artikel/$1`) or a full `http(s)` URL (`https://neu.example.com/artikel/$1`, for
  a moved domain). `$1`, `$2`, … are the wildcards of `From` in authored order, and in an absolute URL
  they may only appear after the host — a placeholder in the host would let a visitor pick the
  destination. A `javascript:`/`data:` scheme, a protocol-relative `//host`, a backslash and embedded
  credentials are all rejected.
- **`Status`** is `301` (permanent, the default), `302` (temporary), or `307`/`308` — the two that
  preserve the request method, for the rare non-GET redirect. 307/308 only mean anything to an edge
  handler in the static topology: under `delivery: 'live'` the catch-all answers GET and HEAD only, so a
  non-GET request falls through to the app instead of being redirected.

A rule that cannot compile fails the save with the offending row named (`Row 3: "To" references $2 but
"From" has 1 wildcard(s)`), so an unpublishable rule can never reach the database through the editor. A
row stored by an older version that a newer one rejects, however, is dropped from the published artifact
when the artifact is next rendered — the rest of the rules still publish — and reported in the server log;
the editor only sees the error the next time the singleton is saved.

## The artifact

`redirects.json` sits at the output driver's root — locally `output.dir`
(`.data/published/redirects.json` by default), on S3 the configured prefix root — served at
`<origin>/redirects.json`. It is a sibling of `index.html` and `sitemap.xml`, never a child of a page
directory. A running Kestrel server also answers `GET /redirects.json` straight from the database: that
is the only source available before a first publish, and the natural poll target when the origin is the
app itself rather than a bucket — poll the artifact URL for a static/CDN topology, the server route for a
`delivery: 'live'` one. Its shape is a flat array in priority order:

```json
[
  { "pattern": "^/blog/([^/\\\\\\x00-\\x1f\\x7f]+)/?$", "target": "/artikel/$1", "status": 301 },
  { "pattern": "^/alte\\-seite/?$", "target": "/neue-seite", "status": 301 }
]
```

`pattern` is an anchored regular-expression source string, already compiled from the wildcard syntax
above. The edge only has to test it against the request path and substitute `$n` — no DSL parsing out
there. The pattern is tested against the path with the query string removed, and the emitted `Location`
is the target as authored — the query string is not carried over. An edge handler that wants to preserve
it has to re-append the original query itself.

Do not hand-roll the pattern. The capture classes are what keeps a request from splicing something
dangerous into `Location`: `*` and `**` exclude a backslash (browsers resolve `Location: /\host` as
`//host` — an open redirect) and the control characters that would split the header, and a `**` capture
may not start with `/` (a target of `/$1` would become the protocol-relative `//host`). A request
carrying any of those simply does not match and falls through to the origin.

An empty rule list publishes `[]`, not nothing. Zero redirects is a fully supported state, and the edge
must read `[]` as "no redirects" rather than as an error; a missing or unparseable file means the edge
should keep its last known-good list instead of blanking live redirects on one bad fetch.

## When it is written

- **On every save of the Redirects singleton** — deliberately decoupled from the publish cycle, so a
  redirect goes live without a full republish and without pressing Publish. Under `delivery: 'live'` this
  also drops the app's own compiled-redirect cache, so the new rule takes effect on the very next request
  handled by that process. There is no cross-process invalidation — a multi-process or multi-replica
  deployment keeps serving the old rules from its other processes until each one restarts or handles its
  own save. If the artifact write fails, the save fails with a message saying the artifact is stale and to
  save again; the row is already committed by then, and the server hands the new baseline back with the
  error so the retry is not refused as a stale overwrite.
- **…but only where the output target is what the site is served from.** That is `output.auto: true`
  (either driver) and `auto: false` + `driver: 's3'`. In the classic build model — `auto: false` with the
  default `driver: 'local'` — the deployed tree is `output.publicDir` (`.output/public`) while the
  artifact goes to `output.dir`, so a redirect saved there goes live with the next `nuxt generate`, not
  on save.
- **On every publish — incremental as well as full —** and, in the `auto: false` build model, on every
  `nuxt generate` (that is the model whose S3 deploy reconciles the bucket), re-rendered from the live
  database like `sitemap.xml` and `robots.txt`. That is not redundancy: a build-time S3 deploy reconciles
  the bucket against `.output/public`, so an artifact the build never produced would be pruned as stale.

## Consuming it at the edge

Stock (open-source) NGINX has no dynamic key-value store — `keyval_zone` is NGINX **Plus**. The
free-tier equivalent is **njs** (`ngx_http_js_module`): a `js_periodic` handler fetches `redirects.json`
into a `js_shared_dict_zone`, and a request-path handler ahead of the origin `proxy_pass` walks the
stored rules in order and returns the first match. Two rules for that handler: keep the last good list
when a fetch or parse fails (never blank live redirects on one transient error), and poll faster on a
cold start until the first well-formed response — including `[]`, so an empty list ends the burst
instead of polling forever. The `Cache-Control` on the object is `public, max-age=0, must-revalidate` for
the same reason: a cached copy would keep serving withdrawn redirects.

The NGINX/njs configuration itself is deployment infrastructure and lives with the deployment, not in
this repo.

## See also

- [Deploying](./deploying.md) — output targets, S3 driver, and site URL configuration.
- [SEO](./seo.md) — the other generated artifacts (`sitemap.xml`, `robots.txt`, `llms.txt`).
- [Configuration](./configuration.md) — the full `output` config block.
