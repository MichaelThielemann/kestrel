# redirects/default
Admin-managed redirects: the `redirects` singleton (`rules: json`, list of `{ from, to, status }`, order =
priority) is compiled into anchored regex rules. `from` uses `*` (one segment) / `**` (one or more), `to`
is a path or an `http(s)` URL with `$1…`; `status` 301 (default) | 302 | 307 | 308. Config: `type` (`redirects`),
`field` (`rules`), `prefix` (blobstore prefix, same as delivery-static), `key` (`redirects.json`).
Steps: `redirects.validate` before `content.set` (`VALIDATION`, `details.row`, message `Row N: …`);
`redirects.lookup` in the site pipeline before `site.resolve` – on a hit the pipeline ends with
`{ redirect: { to, status } }`; `redirects.export` after save and in publish-all writes
`<prefix>redirects.json` (`[{ pattern, target, status }]`, `[]` when empty; broken legacy rows are
skipped and logged); `redirects.render` serves the same list from the DB.
Not included: query matching/forwarding, regex authoring, the edge handler itself (see `../../examples/nginx-njs`).

## How a rule compiles

Editors never write a regex. `from` is a path with `*` (one segment) or `**` (one or more)
wildcards, and `to` references them positionally as `$1`, `$2`, … in authored order; the translation
into the anchored regex happens here, so the edge only matches and substitutes. The exported list is
`{ pattern, target, status }` for every rule and nothing else, so a consumer such as the njs handler
needs no per-item shape check.

`${1}` is rejected: it compiles clean and then ships verbatim in every `Location`, a rule that
silently 404s. A bare `$` is left alone — it is a legal path character, only `$` followed by digits
is reserved. Two `**` with only a separator between them are rejected as well: they match the same
thing through every split point, which is quadratic on a long path.

## Security of a capture

A capture comes from the request, not from the editor, so the checks that ran over the authored
literal say nothing about what it holds; the capture class is the guard instead. It excludes a
backslash, because every browser resolves `Location: /\host` as a host.

A `$n` placeholder inside an absolute target's **host** is rejected outright: with
`https://neu.example.com$1`, a request for `/blog/.evil.com` would produce
`https://neu.example.com.evil.com`. The capture classes cannot prevent that — the hazard is where
`$n` sits, not what it holds.

A stored `rules` field that is neither absent nor a list is a broken container, not a bad row:
`redirects.lookup` fails open on it, so a live site keeps resolving pages instead of answering 500
on every request.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-redirects-default` – module `redirects/default`: provides no contract; requires `content@1`, `blobstore@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `type` | string | no | `"redirects"` |
| `field` | string | no | `"rules"` |
| `prefix` | string | no | `""` |
| `key` | string | no | `"redirects.json"` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `redirects.validate` | Compile the redirect rules of the payload; VALIDATION names the offending row | – | – | { rules?: object[] } | – | 400 Row N: <reason> |
| `redirects.lookup` | Answer { redirect: { to, status } } and end the pipeline when the request path matches a rule | `params.path` | `result?` | – | – | – |
| `redirects.export` | Write redirects.json to the blobstore (adds `redirects: { rules, skipped }` to the result) | – | `result.redirects` | – | { redirects: object, … } | – |
| `redirects.render` | The compiled redirect list (same content as redirects.json) | – | `result` | – | object[] | – |

Pipelines in `examples/minimal` using these steps:

- **publishAllPages** (POST /admin/publish-all/pages): `authn.requireUser` → `authz.require:pages.manage` → `delivery.publishAll:pages` → **`redirects.export`** → `delivery.exportLlms`
- **renderRedirects** (GET /redirects.json): **`redirects.render`**
- **resolvePage** (GET /site/*path): `authn.identifyUser` → `authz.require:pages.read` → **`redirects.lookup`** → `site.resolve:pages?home=home&status=published&fallback=true` → `site.resolveLinks:pages?home=home&status=published&fallback=true`
- **setRedirects** (PUT /redirects): `authn.requireUser` → `authz.require:redirects.write` → `validate.check:redirects.rules` → **`redirects.validate`** → `content.set:redirects` → **`redirects.export`**

<!-- kestrel-docs:end -->
