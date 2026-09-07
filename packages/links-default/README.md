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
