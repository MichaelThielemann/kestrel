# site/default
`site@1` on top of `content@1`: the website vocabulary that `content@1` deliberately does not carry.
`resolve` maps a site path from a `*path` route – `/`, `/<slug>`, `/<lang>`, `/<lang>/<slug>`; the
default locale has no prefix unless `?prefixPrimary=true` – onto one document by its slug field,
`pathOf` is the inverse, `resolveLinks` rewrites internal references (`kestrel:<type>:<id>` in
strings and richtext, `{ type: "internal", collection, id }` objects) to public paths in the
document's locale; targets not served there become `href="#" data-kestrel-broken="…"` / `broken: true`,
and `_links` maps every referenced id to its path. With `?fallback=true` a locale without its own
slug is found through the default locale, but localized filters are re-checked strictly.
Steps: `site.resolve:<t>?home=home&status=published&fallback=true` (`NOT_FOUND` otherwise) and
`site.resolveLinks:<t>?…` with the same arguments. Config `{}`.
Not included: rendering, storage, redirects (see delivery-static, redirects-default).
