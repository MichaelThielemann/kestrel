# site/default
`site@1` on top of `content@1`: the website vocabulary that `content@1` deliberately does not carry.
`resolve` maps a site path from a `*path` route – `/`, `/<slug>`, `/<lang>`, `/<lang>/<slug>`; the
default locale has no prefix unless `?prefixPrimary=true` – onto one document by its slug field,
`pathOf` is the inverse, `resolveLinks` rewrites internal references (`kestrel:<type>:<id>` in
strings and richtext, `{ type: "internal", collection, id }` objects) to public paths in the
document's locale; targets not served there become `href="#" data-kestrel-broken="…"` / `broken: true`,
and `_links` maps every referenced id to its path. With `?fallback=true` a locale without its own
slug is found by the same slug in the default locale; that lookup matches the slug and only the
filter's locale-independent fields, and the requested locale must then pass the whole filter
itself. A locale that is not published itself stays unserved and is never replaced by another
locale's content (404). A locale with a slug of its own is reachable through the default locale's
slug only while the default locale passes the filter too, so a draft default slug never becomes a
second address for it. An empty field of a
served locale — including a linked page's slug inside `resolveLinks` — is filled from the default
locale only when the default locale's own values pass the filter too; with no such default the field
stays empty. `_translations` lists only the locales that pass the filter themselves. Every `site@1`
implementation must follow this rule; the shared contract suite
(`@michaelthielemann/kestrel-contracts/site.contract.test`) tests it.
Cost: with `?fallback=true` and N locales configured, resolving a non-default locale reads up to two
`content.get` calls (the requested locale's own values, the merged fallback read) and up to N+2
`content.list` calls (the slug lookup, a filter check each for the requested and the default locale,
one per remaining locale to narrow `_translations`) — when the requested locale's own slug lookup
finds nothing, the default-locale slug lookup adds one list call, plus one `content.get` (and one
filter check if the requested locale has a slug of its own) to decide whether that slug routes
there. Measured at 4 locales: 8 calls for `resolve`. Every locale's filter membership is decided fresh at read time, on the store itself,
never cached or reused across these calls; that correctness is preferred over the read count.
Steps: `site.resolve:<t>?home=home&status=published&fallback=true` (`NOT_FOUND` otherwise) and
`site.resolveLinks:<t>?…` with the same arguments. Config `{}`.
Not included: rendering, storage, redirects (see delivery-static, redirects-default).

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-site-default` – module `site/default`: provides `site@1`; requires `content@1`.

Config: `{}` – nothing to set.

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `site.resolve:<arg>` | Resolve a site path to a <arg> document (default locale unprefixed) | `params.path` | `result` | – | { id: string, createdAt: number, updatedAt: number, _locales?: object, _translations?: object, _locale?: string, _links?: object, … } | 404 no page at this path | – | no |
| `site.resolveLinks:<arg>` | Replace internal kestrel:<type>:<id> references in the <arg> document with public paths (_links map added) | `result` | `result` | ?locale: string | { _links?: object, … } | – | – | no |

Pipelines in `examples/minimal` using these steps:

- **resolvePage** (GET /site/*path): `authn.identifyUser` → `authz.require:pages.read` → `redirects.lookup` → **`site.resolve:pages?home=home&status=published&fallback=true`** → **`site.resolveLinks:pages?home=home&status=published&fallback=true`** → `authz.fields:pages?shape=item`

<!-- kestrel-docs:end -->
