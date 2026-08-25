# SEO, structured data and answer engines

Everything the generated HTML advertises to crawlers and answer engines — head tags, JSON-LD, sitemap, robots.txt, and the `llms.txt` family — needs no wiring beyond the content itself.

## The `site` singleton and title composition

The **Site** entry in the admin holds the tier above a single page: a base title, its separator and
position, a default meta description, and a default sharing image, each stored per locale.

Each value is a fallback, not an override — a page that sets its own SEO description keeps it, and the
site value fills in for every page that does not. An untouched Site record changes nothing about the
emitted head.

- `siteUrl` and `siteName` stay in `kestrel.config.ts`, not the database — see
  [configuration.md](./configuration.md) for the matching env vars. The build needs `siteUrl` for canonical URLs, the sitemap and `robots.txt`.
- Only the document `<title>` is composed from the site title. `og:title` keeps the bare page title, since
  `og:site_name` already carries the site name.
- The separator is stored as a bare token (`|`, `·`, `—`) and padded with single spaces when rendered — a
  text field trims on write, so a stored `" | "` could not keep its spaces.
- A page title that already ends in the base title is left as it is, which matters for content migrated
  from a CMS that baked the site name into every title.
- Unlike `pages` and `media`, the Site record has no `collections` toggle — it is always registered.
  Leaving it untouched is the off switch.

## Per-page head

Every generated page emits, from its `seo` fields and the resolved site URL:

- `<title>` from `seo.title`, else the record title, composed with the Site base title as described above;
  `<meta name="description">` from `seo.description`, else the Site's default description, else omitted.
  `robots: noindex,nofollow` when `seo.noindex` is set.
- `<link rel="canonical">` and `og:url` — the page's own absolute, locale-prefixed URL.
- Open Graph + Twitter card: `og:title`/`og:description`/`og:type`/`og:site_name` and `twitter:card`. Set
  `seo.image` (a media id, picked in the editor's SEO panel) to add `og:image` (plus its width/height) and
  upgrade the card to `summary_large_image`. `og:type` is always `website`, even for a record that becomes
  an `Article` in the JSON-LD graph below — turning on `articleMeta` does not change it.
- `<link rel="alternate" hreflang="…">` for each published, **indexable** translation of the page, and only
  when two or more remain (a lone page gets none) — the set is dropped whole if the page being rendered is
  not itself advertisable. `x-default` points at the primary-locale variant. The page-level counterpart to
  the sitemap's hreflang set.
- a `<script type="application/ld+json">` graph — see below.

Everything that needs an absolute URL (canonical, `og:url`, hreflang, a relative `og:image`) is **omitted**
when the resolved `siteUrl` is unset; the plain title/description/OG-text tags still render. On a prebuilt
server the head and JSON-LD origin comes from the runtime-config names (`NUXT_PUBLIC_SITE_URL`), not the
build-time `KESTREL_SITE_URL` — see [./deploying.md § Build-time vs runtime configuration](./deploying.md#build-time-vs-runtime-configuration)
and [./configuration.md § Precedence](./configuration.md#precedence).

## Structured data (JSON-LD)

Every generated page carries one schema.org `@graph`, built from the same values as the head above so the
two can never disagree:

- **`WebSite`** — the site's origin and `siteName`. Omitted (with the `isPartOf` edge that points at it)
  when no `siteName` is configured, since a nameless node asserts nothing.
- **`WebPage`** — the page: `url`, `name`, `description`, `inLanguage`, and `image` when an `og:image`
  resolved. It becomes an **`Article`** (with `headline` instead of `name`) when article metadata is
  switched on *and* the record carries some — see below.
- **`BreadcrumbList`** — the trail from the path hierarchy. Only **real published, indexable pages** become
  items: a path segment with no page behind it is skipped rather than invented, so a crumb never links a
  404, and a trail with fewer than two items is dropped entirely.

Nothing is emitted at all when `KESTREL_SITE_URL` is unset (every `@id`/`url` would be relative), for a
`seo.noindex` page, or in an unsaved editor preview.

Breadcrumbs participate in incremental publishing like everything else: a page subscribes to each ancestor
path it looked in and to the record it found there, so an ancestor's unpublish or delete repairs a
descendant's trail immediately, and a create, retitle, rename or `noindex` flip makes the descendant a
target of the ancestor's next explicit publish. See [./publishing.md § What a save invalidates](./publishing.md#what-a-save-invalidates)
and [../internals/publishing.md](../internals/publishing.md) for the invalidation model.

### Article metadata — opt-in (`seo.articleMeta`)

`author`, `publishedDate` and `keywords` live in the record's `seo` column and map to schema.org `author`
(as a `Person`), `datePublished` and `keywords`. **Off by default**: some installations must not attribute
content at all, so with the flag off the editor is not even offered the fields and nothing is published.

The column always round-trips the values, so switching the flag off *hides and unpublishes* what is
already stored rather than destroying it; switching it back on restores it. A `publishedDate` that is not
an ISO date is rejected in the editor, and a value that somehow reaches the renderer unparseable is
dropped rather than published as a broken `datePublished`.

```ts
// kestrel.config.ts
export default { seo: { articleMeta: true } } satisfies KestrelConfig
```

## sitemap.xml

Lists every **published, indexable** record across all page-like collections — see
[./collections.md](./collections.md) for the `pageLike` and `seo` flags that put a collection's records
into everything on this page:

- Drafts (`status != 'published'`) and records with `seo.noindex = true` are excluded. So is a whole
  page-like collection whose read pipeline is not publicly readable — a consumer who overrides that
  access declaration silently drops the collection from the sitemap and both `llms.txt` files too.
- `<loc>` needs an absolute origin — the sitemaps.org schema rejects a relative one — so with
  `KESTREL_SITE_URL` unset the route returns a valid but **empty** sitemap and logs a warning, rather than
  emit root-relative paths.
- `<lastmod>` is the record's `updatedAt`.
- Under `delivery: 'live'`, a route also has to hold a current snapshot in the publishing store; a route
  retracted there drops out of the sitemap even though its row is untouched. See
  [../internals/publishing.md](../internals/publishing.md) for what retracts a snapshot.
- For a translatable page with two or more published, indexable locale variants, each `<url>` carries
  `<xhtml:link rel="alternate" hreflang="…">` for every sibling variant plus an `hreflang="x-default"`
  pointing at the primary-locale variant (when it exists). The `xhtml` namespace is declared on `<urlset>`
  only when alternates are present; single-locale and non-translatable pages are unaffected.

The route filters status and `noindex` itself, so it is safe to serve publicly and to prerender — drafts
never leak.

## robots.txt

```
User-agent: *
Allow: /
# llms.txt: <KESTREL_SITE_URL>/llms.txt
# llms-full.txt: <KESTREL_SITE_URL>/llms-full.txt

Sitemap: <KESTREL_SITE_URL>/sitemap.xml
```

The `Sitemap:` directive and the `llms.txt` comment are emitted only when `KESTREL_SITE_URL` is set; the
`llms-full.txt` comment additionally requires `seo.llmsFull`.

There are **no per-crawler rules**, deliberately. A blanket `Allow: /` is current best practice: AI
crawlers largely respect `robots.txt`, and blocking them costs visibility without buying anything back.
Differentiating training crawlers from retrieval crawlers is a policy decision for a specific site, not a
default — add the rules at your reverse proxy or ship your own `robots.txt` route if you need them.

## llms.txt

An [llmstxt.org](https://llmstxt.org) site map for AI agents: the `#` heading is `siteName`, else the site
URL host, else the literal `Website`, so the file always has one; the `>` description below it is
`siteDescription` and is omitted when unset (unrelated to the JSON-LD `WebSite` node above, which really is
omitted when `siteName` is unset). One section per page-like collection lists its published, indexable
records — the same status/`noindex` filters the sitemap applies, plus the same public-readability filter.
It does **not** consult the publishing store's snapshots the way `sitemap.xml` does under `delivery:
'live'`, though, so a route retracted only at the snapshot level stays listed here after it has dropped out
of the sitemap; the two otherwise agree on status and `noindex`. It is referenced from `robots.txt` (the
comment above) and a `<link rel="alternate" type="text/markdown" href="/llms.txt">` in every public page's
`<head>`. With no site URL configured, the file keeps its heading and description and lists no pages,
because every link would be relative.

```
# Example

> What this site is about.

## Pages

- [Home](https://www.example.com/): The landing page.
- [About](https://www.example.com/about)
```

## llms-full.txt — opt-in (`seo.llmsFull`)

The long form of the same convention: where `llms.txt` is a map, this is the territory — every published,
indexable page's **full body as Markdown**, in one document an answer engine can retrieve without crawling
the site. Same collections, same status/`noindex` filters, same section headings. With no site URL
configured it degrades the same way `llms.txt` does: the site header stays, every page section is dropped,
and a warning is logged. With the flag off, the route 404s and is not prerendered — the publisher reads
that 404 as "delete the file", which is what turning the flag back off removes below.

```ts
// kestrel.config.ts
export default { seo: { llmsFull: true } } satisfies KestrelConfig
```

Pages sit at `###`, so a body's own headings are shifted down to start at `####` and the document keeps a
valid outline. Richtext becomes real Markdown (headings, lists, links, quotes, code); block content is
walked through each block's registered field defs, so only its `text`/`richtext` props carry prose into the
document — a `repeater` prop recurses into its entries' own `text`/`richtext` sub-fields, everything else
(media, relation, number, choice, json, …) is skipped — and an unregistered block type is skipped rather
than guessed at. Internal richtext links resolve to absolute
URLs when their target is itself published and indexable, and degrade to plain text otherwise — an
unpublished URL is never leaked.

Editor-authored text can never forge the document's own structure: every line that would open a Markdown
block — a heading, a list item, a quote, a code fence, a thematic break — is escaped, and a code block is
fenced wider than any backtick run inside it. A paragraph that literally reads `## Roadmap` stays a
paragraph rather than becoming a sibling of the generator's own `## Pages` section.

Turning the flag back off **removes** the published file on the next publish — the last full dump does not
stay live after the disclosure is withdrawn.

```
# Example

> What this site is about.

## Pages

### About

Source: https://www.example.com/about

Who we are.

#### Our story

We started in **1999**.
```

## Writing for search and answer engines

What is left to you is the content itself, and it is the part that moves the needle most for passage
retrieval — an answer engine quotes a passage, not a page:

- **Give every page a real `<h1>` and a heading per section.** Headings are the chunk boundaries these
  systems retrieve on, and they are what `llms-full.txt` carries through as Markdown structure. A page
  built out of one long richtext block with no headings retrieves as one undifferentiated blob.
- **Answer the question in the first paragraph under each heading**, then elaborate. Retrieval scores the
  passage, not the page's overall quality.
- **Write the meta description as the answer, not as a teaser.** It is what `llms.txt` publishes per page
  and what a summary is most likely to be built from.
- **Prefer explicit prose over layout-only structure.** A fact that only exists as a table cell or an icon
  label is a fact the extractors above cannot carry: only `text` and `richtext` props reach the Markdown
  body (repeater entries included) — a number, choice, media or relation prop never does.
- **Keep `noindex` for what genuinely should not be found.** It removes the page from the sitemap, the
  hreflang sets, `llms.txt`, `llms-full.txt`, the breadcrumb trails of its descendants, and its own
  structured data — one switch, consistently.

## See also

- [./publishing.md](./publishing.md) — how a page's `status` and `noindex` state gets there, and what a
  save invalidates immediately versus on the next publish.
- [./multilingual.md](./multilingual.md) — locale prefixes and the primary-locale URL scheme.
- [./collections.md](./collections.md) — the `pageLike` and `seo` flags that put a collection's records
  into everything on this page.
- [./configuration.md](./configuration.md) — `KESTREL_SITE_URL` and the rest of `kestrel.config.ts`.
- [../internals/publishing.md](../internals/publishing.md) — the invalidation model behind incremental republishing.
