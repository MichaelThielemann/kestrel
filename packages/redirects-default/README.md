# redirects/default
Admin-managed redirects: the `redirects` singleton (`rules: json`, list of `{ from, to, status }`, order =
priority) is compiled into anchored regex rules. `from` uses `*` (one segment) / `**` (one or more), `to`
is a path or https URL with `$1…`; `status` 301 (default) | 302 | 307 | 308. Config: `type` (`redirects`),
`field` (`rules`), `prefix` (blobstore prefix, same as delivery-static), `key` (`redirects.json`).
Steps: `redirects.validate` before `content.set` (`VALIDATION`, `details.row`, message `Row N: …`);
`redirects.lookup` in the site pipeline before `site.resolve` – on a hit the pipeline ends with
`{ redirect: { to, status } }`; `redirects.export` after save and in publish-all writes
`<prefix>redirects.json` (`[{ pattern, target, status }]`, `[]` when empty; broken legacy rows are
skipped and logged); `redirects.render` serves the same list from the DB.
Not included: query matching/forwarding, regex authoring, the edge handler itself (see `../../examples/nginx-njs`).
