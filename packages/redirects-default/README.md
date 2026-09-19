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
