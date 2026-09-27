# links/default
External link checking for content. `links.extract:<type>` after `content.create/update` (and
`links.unextract:<type>` after remove) indexes every `http(s)` URL found in `text`, `richtext` and
`json` fields (per locale) into `links_index`. `links.check` (cron) probes each due URL once
(HEAD, GET on 405/501; timeout, concurrency and recheck interval from config) and stores
`ok`/`status`/`error`/`checkedAt` on all entries of that URL. `links.report` lists broken ones
(optional `type` filter), `links.rebuild` refills the index from all content.
A URL longer than 2048 characters (`MAX_URL_LENGTH`) is not indexed. Each document stores at most `maxLinksPerDocument` links (default 1000, counted over all fields and
locales, one per field, locale and URL). A document with more gets one additional row whose `url` is
the first link left out and whose `error` is `LINK_LIMIT_ERROR`; it shows up in `links.report` and is
never requested. Scanning stops at the limit, so the cost of `links.extract` does not grow with the
size of the text.

`links.check` walks the index in batches of 100 rows and yields to the event loop between batches, so
other requests are served while a run is in progress. Each URL is requested at most once per run, and
the result is written to every due row with that URL. A run ends when `checkBudgetSeconds` (default
3600) have passed; no new URL is requested after that, and the rows it did not reach stay due for the
next run. `urls` in the summary counts the URLs requested or refused in this run.

A probed URL's own `ok`/`status`/`error` (whether the *target* answered) is data, not a step
failure — only a failure to read or write the index itself (a busy database) fails the step.
Outbound requests are a SSRF surface. With `allowPrivate: false` (the default) a check sends a request
only to an `http(s)` URL whose host is a globally reachable address:

- A hostname is compared without trailing dots and case (`localhost.`, `LOCALHOST`), and `localhost`,
  `*.localhost`, `*.local`, `*.localdomain`, `*.internal` and `*.home.arpa` are refused by name.
- A hostname is resolved first (every address, `dns.lookup`); if any address is in a blocked range the
  URL is not requested, and the connection goes to the address that passed the check, so a second
  resolution to another address cannot take its place. With several addresses (IPv6 and IPv4) the
  connection tries them in resolution order and falls back to the next when one cannot be reached; a
  connection that fails at once ends the check with that error, never the process.
- Blocked ranges are the IANA special-purpose ranges that are not globally reachable: IPv4 `0/8`,
  `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`,
  `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, multicast `224/4` and `240/4` including
  broadcast; IPv6 `::/96` (unspecified, loopback, IPv4-compatible), `::ffff:0:0:0/96`, `64:ff9b:1::/48`,
  `100::/64`, `2001::/23`, `2001:db8::/32`, `3fff::/20`, `5f00::/16`, `fc00::/7`, `fe80::/10`,
  `fec0::/10` and multicast `ff00::/8`. An IPv4 address embedded in an IPv4-mapped (`::ffff:0:0/96`),
  NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`) address is checked against the IPv4 list.
- Redirects are followed by hand, at most 5 hops; every hop passes the same checks before it is
  requested. A hop that fails them ends the check with that error (`private address`), more hops end it
  with `too many redirects`.

A URL refused this way is stored with `ok: false`, `status: null` and the reason in `error`, and counts
as `skipped` in the `links.check` summary when the reason applies to the URL itself.
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
| `maxLinksPerDocument` | integer | no | `1000` |
| `checkBudgetSeconds` | integer | no | `3600` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `links.extract:<arg>` | Index external links of <arg> | `result.id` | – | – | – | – | – | yes |
| `links.unextract:<arg>` | Drop indexed links of <arg> | `params.id` | – | – | – | 400 missing id | – | yes |
| `links.check` | Check due links | – | `result` | – | { urls: number, checked: number, broken: number, skipped: number, … } | – | – | no |
| `links.report` | Broken links | – | `result` | ?type: string | object[] | – | – | yes |
| `links.rebuild` | Rebuild the link index | – | `result` | – | { documents: number, entries: number, … } | – | – | no |

Pipelines in `examples/minimal` using these steps:

- **brokenLinks** (GET /admin/links/broken): `authn.requireUser` → `authz.requireRole` → `authz.require:pages.manage` → **`links.report`**
- **checkLinks** (cron 0 3 * * *): **`links.check`**
- **createPage** (POST /pages): `authn.requireUser` → `authz.requireRole` → `authz.require:pages.write` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → [ `references.check:pages` → `content.create:pages` → `revisions.record:pages` → `references.index:pages` → **`links.extract:pages`** → `site.indexPath:pages` ] → `site.announcePaths` → `events.emit:page.created` → `events.relay`
- **deletePage** (DELETE /pages/:id): `authn.requireUser` → `authz.requireRole` → `authz.require:pages.delete` → [ `references.guard:pages` → `content.remove:pages` → `revisions.remove:pages` → `references.unindex:pages` → **`links.unextract:pages`** → `site.indexPath:pages` ] → `site.announcePaths` → `events.emit:page.deleted` → `events.relay`
- **deletePageTranslation** (DELETE /pages/:id/translations/:locale): `authn.requireUser` → `authz.requireRole` → `authz.require:pages.write` → [ `content.removeTranslation:pages` → `revisions.removeTranslation:pages` → `references.index:pages` → **`links.extract:pages`** → `site.indexPath:pages` ] → `site.announcePaths` → `events.emit:page.translationRemoved` → `events.relay`
- **rebuildLinks** (POST /admin/links/rebuild): `authn.requireUser` → `authz.requireRole` → `authz.require:pages.manage` → **`links.rebuild`**
- **restorePageRevision** (POST /admin/pages/:id/revisions/:revisionId/restore): `authn.requireUser` → `authz.requireRole` → `authz.require:pages.write` → `revisions.restore:pages` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → [ `references.check:pages` → `content.update:pages` → `revisions.record:pages` → `references.index:pages` → **`links.extract:pages`** → `site.indexPath:pages` ] → `site.announcePaths` → `revisions.reportRestore` → `events.emit:page.restored` → `events.relay`
- **updatePage** (PATCH /pages/:id): `authn.requireUser` → `authz.requireRole` → `authz.require:pages.write` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → [ `references.check:pages` → `content.update:pages` → `revisions.record:pages` → `references.index:pages` → **`links.extract:pages`** → `site.indexPath:pages` ] → `site.announcePaths` → `events.emit:page.updated` → `events.relay`

<!-- kestrel-docs:end -->
