# links/default
External link checking for content. `links.extract:<type>` after `content.create/update` (and
`links.unextract:<type>` after remove) indexes every `http(s)` URL found in `text`, `richtext` and
`json` fields (per locale) into `links_index`. `links.check` (cron) probes each due URL once
(HEAD, GET on 405/501; timeout, concurrency and recheck interval from config) and stores
`ok`/`status`/`error`/`checkedAt` on all entries of that URL. `links.report` lists broken ones
(optional `type` filter), `links.rebuild` refills the index from all content.
A probed URL's own `ok`/`status`/`error` (whether the *target* answered) is data, not a step
failure — only a failure to read or write the index itself (a busy database) fails the step.
Outbound requests are a SSRF surface: non-http schemes and private/loopback addresses are never
requested (`allowPrivate: false`); hostnames resolving to private ranges are not detected.
Every method returns a `Result`: a failure is an `Err(KestrelError)`, never an exception. Only
wiring bugs throw (unknown type).

| Step | reads | writes | codes |
|---|---|---|---|
| `links.extract:<type>` | `result.id` | – | TRANSIENT |
| `links.unextract:<type>` | `params.id` | – | VALIDATION (missing id), TRANSIENT |
| `links.check` | – | `result` | TRANSIENT |
| `links.report` | – | `result` | TRANSIENT |
| `links.rebuild` | – | `result` | TRANSIENT |

Not included: link rewriting, retries before reporting, robots.txt.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-links-default` – module `links/default`: provides no contract; requires `content@1`, `persistence@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `timeoutMs` | integer | no | `10000` |
| `concurrency` | integer | no | `4` |
| `recheckAfterSeconds` | integer | no | `21600` |
| `userAgent` | string | no | `"kestrel-links/0.1 (+link check)"` |
| `allowPrivate` | boolean | no | `false` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `links.extract:<arg>` | Index external links of <arg> | `result.id` | – | – | – | – |
| `links.unextract:<arg>` | Drop indexed links of <arg> | `params.id` | – | – | – | 400 missing id |
| `links.check` | Check due links | – | `result` | – | { urls?: number, checked?: number, broken?: number, skipped?: number, … } | – |
| `links.report` | Broken links | – | `result` | ?type: string | object[] | – |
| `links.rebuild` | Rebuild the link index | – | `result` | – | { documents?: number, entries?: number, … } | – |

Pipelines in `examples/minimal` using these steps:

- **brokenLinks** (GET /admin/links/broken): `authn.requireUser` → `authz.require:pages.manage` → **`links.report`**
- **checkLinks** (cron 0 3 * * *): **`links.check`**
- **createPage** (POST /pages): `authn.requireUser` → `authz.require:pages.write` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → `references.check:pages` → `content.create:pages` → `references.index:pages` → **`links.extract:pages`** → `delivery.publish:pages` → `delivery.exportLlms` → `events.emit:page.created`
- **deletePage** (DELETE /pages/:id): `authn.requireUser` → `authz.require:pages.delete` → `references.guard:pages` → `content.remove:pages` → `references.unindex:pages` → **`links.unextract:pages`** → `delivery.unpublish:pages` → `delivery.exportLlms` → `events.emit:page.deleted`
- **deletePageTranslation** (DELETE /pages/:id/translations/:locale): `authn.requireUser` → `authz.require:pages.write` → `content.removeTranslation:pages` → `references.index:pages` → **`links.extract:pages`** → `delivery.publish:pages` → `delivery.exportLlms` → `events.emit:page.translationRemoved`
- **rebuildLinks** (POST /admin/links/rebuild): `authn.requireUser` → `authz.require:pages.manage` → **`links.rebuild`**
- **updatePage** (PATCH /pages/:id): `authn.requireUser` → `authz.require:pages.write` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → `references.check:pages` → `content.update:pages` → `references.index:pages` → **`links.extract:pages`** → `delivery.publish:pages` → `delivery.exportLlms` → `events.emit:page.updated`

<!-- kestrel-docs:end -->
