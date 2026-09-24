# delivery/static
Static delivery with a publish status per document and locale. Requires `content@1`, `site@1`,
`renderer@1` (the site's own renderer), `blobstore@1` (filesystem or S3) and
`persistence@1`. `delivery.publish:<type>` after `content.create/update`: for every locale whose
own `statusField` equals `publishedValue` the document (an empty field filled from the default
locale only when the default locale's own values equal `publishedValue` too, `_translations`
narrowed to locales that satisfy it themselves, internal links resolved to public paths via
`site.resolveLinks`, `_links` attached) is rendered in each configured format and stored under the
path `site.pathOf` returns (default locale unprefixed unless `prefixPrimary`, `home` slug → `/`);
other locales are removed. Outcome per
locale in `delivery_publish_status` (`live` | `error` | `draft`, `path`, `error`, `publishedAt`); a failed
render keeps the previous live output, but a locale that is published yet has no slug of its own or
inherited (`state: "error"`, e.g. the default locale it inherited a slug from turned draft) removes
its previous output instead — that content is no longer publishable, so it does not stay public.
`delivery.unpublish:<type>` after remove, `delivery.readStatus:<type>`
for the editor's second lamp, `delivery.publishAll:<type>` to re-render everything.
`delivery.publish` takes the document id from `result.id` when present, else from the event
payload's `id`, so it also runs as the first step of a pipeline an event triggers; it merges
`_delivery` into the result instead of replacing it. `delivery.unpublish` does the same with
`params.id` and the payload's `id`. Both answer `VALIDATION` (400) when neither source names a
document, instead of throwing.
Formats come from the renderer (`html`, `pdf`, …) – `formats: ["html", "pdf"]` writes both.
Assets the renderer returns (`assets: [{ path: "/_assets/app.js", … }]` – hydration bundles, CSS)
are stored under `<prefix><path>` once per process; they are never removed on unpublish. Rendered
output is stored exactly as the renderer returned it: this module never scans or rewrites it, so
any media reference it contains (a URL a media module already returned as data) reaches the export
unchanged, in whatever spelling the renderer produced.
`reservedPaths` (e.g. `["/api", "/admin", "/media"]`) names paths the origin – not this export –
owns. A page whose path equals or lies under one of them is not written; its status becomes
`error` with `path <path> is reserved (<reserved>)`, and the previous live output (if any) stays. A
renderer asset under a reserved path fails the same way, naming the asset's own path.
`delivery.exportLlms` (always on; `llms` defaults to paths instead of URLs and no full file) (no argument; append it after `delivery.publish`/`unpublish`/`publishAll`
and after saving the settings) writes `<prefix>llms.txt` per [llmstxt.org](https://llmstxt.org) from the `live` status rows
of every delivered type, re-checking each source locale's own current values at read time — a
`live` row only names where to look, not what to trust, so a document saved as a draft after its
last successful publish is skipped even if its row has not caught up yet: `# <settings title>`,
`> <settings description>`, one `## <headings[type] ?? type>` section with
`- [<seo.title || title>](<siteUrl><path>): <seo.description>` per page; `seo.noindex === true` excludes a page.
An empty `seo`/title field is filled from the default locale only when the default locale's own
values equal `publishedValue` too, the same rule `delivery.publish` applies. `full: true`
also writes `<prefix>llms-full.txt` – the stored HTML of every page, restricted to `<main>` (matched
greedily up to the last `</main>` tag, so a nested `<main>` does not cut it short), converted with turndown
(headings shifted three levels, so a page's own top-level heading becomes `####` under its `###` page
heading and `##` section heading; root-relative links and images made absolute with `siteUrl`) – and
needs `"html"` in `formats`; `full: false` removes a stale `llms-full.txt`. Titles and descriptions are
escaped so that editor-authored text cannot introduce a stray line break or start with a heading marker
in the generated file. The result gains `_llms: { entries, full }`.
Every `Delivery` method returns a `Result`; a failure is an `Err(KestrelError)`, never an exception.
A render failure (`RENDER_FAILED` or `TRANSIENT` from `renderer@1`) is not a step failure: it is
recorded on the status row as `state: "error"` with the message and the remaining locales are still
published. Only wiring bugs throw (unknown type, unconfigured type, an asset path that is empty or contains a
`..` segment).

| Step | reads | writes | codes |
|---|---|---|---|
| `delivery.publish:<type>` | `result.id` | `result` (`document`, `delivery`) | TRANSIENT |
| `delivery.unpublish:<type>` | `params.id` | – | VALIDATION (missing id), TRANSIENT |
| `delivery.readStatus:<type>` | `params.id` | `result` | VALIDATION (missing id), TRANSIENT |
| `delivery.publishAll:<type>` | – | `result` | TRANSIENT |
| `delivery.exportLlms` | – | `result.llms` | TRANSIENT |

Not included: sitemap, CDN invalidation.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-delivery-static` – module `delivery/static`: provides no contract; requires `content@1`, `renderer@1`, `blobstore@1`, `persistence@1`, `site@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `types` | record | yes | – |
| `formats` | array | no | `["html"]` |
| `prefix` | string | no | `""` |
| `prefixPrimary` | boolean | no | `false` |
| `fallback` | boolean | no | `true` |
| `reservedPaths` | array | no | `[]` |
| `llms` | object | no | `{}` |
| `llms.siteUrl` | string | no | – |
| `llms.full` | boolean | no | `false` |
| `llms.settings` | object | no | `{}` |
| `llms.settings.type` | string | no | `"settings"` |
| `llms.settings.titleField` | string | no | `"title"` |
| `llms.settings.descriptionField` | string | no | `"description"` |
| `llms.titleField` | string | no | `"title"` |
| `llms.seoField` | string | no | `"seo"` |
| `llms.headings` | record | no | `{}` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `delivery.publish:<arg>` | Render and store published locales of a <arg> (adds `_delivery` to the result) | `result.id?`, `payload` | `result._delivery` | object | { _delivery: object[], … } | 400 no document id in the result or the event payload | – | no |
| `delivery.unpublish:<arg>` | Remove rendered output of a <arg> | `params.id`, `payload` | – | object | – | 400 no document id in params or the event payload | – | no |
| `delivery.readStatus:<arg>` | Publish status per locale of a <arg> | `params.id` | `result` | – | object[] | 400 missing id | – | yes |
| `delivery.publishAll:<arg>` | Re-render every <arg> | – | `result` | – | { documents: number, live: number, errors: number, … } | – | – | no |
| `delivery.exportLlms` | Write llms.txt (and llms-full.txt when `llms.full` is set) from the live output of every delivered type (adds `_llms: { entries, full }` to the result) | – | `result._llms` | – | { _llms: object, … } | – | – | no |

Pipelines in `examples/minimal` using these steps:

- **pagePublishStatus** (GET /admin/publish-status/pages/:id): `authn.requireUser` → `authz.require:pages.manage` → **`delivery.readStatus:pages`**
- **publishAllPages** (POST /admin/publish-all/pages): `authn.requireUser` → `authz.require:pages.manage` → **`delivery.publishAll:pages`** → `redirects.export` → **`delivery.exportLlms`**
- **publishPage** (event page.created, event page.updated, event page.restored, event page.translationRemoved): **`delivery.publish:pages`** → **`delivery.exportLlms`**
- **setSettings** (PUT /settings): `authn.requireUser` → `authz.require:settings.write` → `validate.check:settings.navigation` → `content.set:settings` → **`delivery.exportLlms`**
- **unpublishPage** (event page.deleted): **`delivery.unpublish:pages`** → **`delivery.exportLlms`**

<!-- kestrel-docs:end -->
