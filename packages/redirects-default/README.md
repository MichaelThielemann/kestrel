# redirects/default
Admin-managed redirects, plus automatic redirects for documents that moved: the `redirects` singleton
(`rules: json`, list of `{ from, to, status }`, order = priority) is compiled into anchored regex rules.
`from` uses `*` (one segment) / `**` (one or more), `to` is a path or an `http(s)` URL with `$1…`; `status`
301 (default) | 302 | 307 | 308. Config: `type` (`redirects`), `field` (`rules`), `prefix` (blobstore prefix,
same as delivery-static), `key` (`redirects.json`). Requires `content@1`, `blobstore@1` and `persistence@1`
(own collections, reached through no other module's contract).
Steps: `redirects.validate` before `content.set` (`VALIDATION`, `details.row`, message `Row N: …`, also for
an editor rule that would redirect into an existing automatic redirect); `redirects.recordMoves` applies
`site.pathsMoved` moves to the automatic-redirect state; `redirects.lookup` in the site pipeline before
`site.resolve` – on a hit (editor or automatic) the pipeline ends with `{ redirect: { to, status } }`;
`redirects.export` after save and in publish-all writes `<prefix>redirects.json` (`[{ pattern, target,
status }]`, editor rules first then automatic ones, `[]` when empty; broken legacy rows are skipped and
logged); `redirects.render` serves the same list from the DB; `redirects.listAuto` and `redirects.removeAuto`
back the admin view of automatic redirects.
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

## Automatic redirects

Whenever a document's public path changes, the module raising `site.pathsMoved` reports every affected
`{ type, id, locale, from, to, seq }`. This module keeps two facts per document and per path: where a
document currently lives, and what the newest known state of a given path is (still redirecting somewhere,
live content, or removed). A path never redirects through another path – `lookup`, `export` and `render`
always resolve to a document's *current* location, so a chain of renames answers with one hop, not several.

The state is rebuilt from `seq`, a run-global, increasing sequence number, so it does not matter in which
order moves arrive, whether a move is delivered twice, or whether an old event is replayed after something
newer has happened: only the higher `seq` wins. Two documents swapping paths in the same run (both moves
carry the same `seq`) leaves neither path redirected – the destination of a move wins a tie, so each path
ends up live for whichever document claims it last, and never lands on a document mid-swap. A move whose
`to` is `null` ends every redirect to that document, since a redirect is only reported while the document
still has a known destination path.

Moves are recorded one delivery at a time within the process, so two runs delivering moves at once end
in the same state as in either order.

An editor rule takes precedence over an automatic redirect at the same path, in `lookup` and in the
`redirects.json` order (editor rules first). Saving an editor rule that redirects into a path an automatic
redirect currently owns is rejected by `redirects.validate` – that combination would otherwise send a
visitor through two hops. Symmetrically, `lookup`, `export` and `render` skip an automatic redirect whose own
target an editor rule already matches (`export` and `render` log it), rather than answer a redirect into a redirect.

An admin can retire one automatic redirect with `redirects.removeAuto` without touching the underlying
content: the path is marked as removed, keeping the `seq` it had. Replaying the move that produced it does
not restore it – only a genuinely newer move away from that path can.

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
`@michaelthielemann/kestrel-redirects-default` – module `redirects/default`: provides no contract; requires `content@1`, `blobstore@1`, `persistence@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `type` | string | no | `"redirects"` |
| `field` | string | no | `"rules"` |
| `prefix` | string | no | `""` |
| `key` | string | no | `"redirects.json"` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `redirects.validate` | Compile the redirect rules of the payload; VALIDATION names the offending row, also for a rule that redirects into an active automatic redirect | – | – | { rules?: object[] } | – | 400 Row N: <reason> | – | no |
| `redirects.recordMoves` | Apply site.pathsMoved moves to the automatic-redirect state: per document the highest seq wins, a tie inside one run favours the destination path | `payload` | `result.autoRedirects` | { moves?: object[], … } | { autoRedirects: object, … } | 400 payload.moves is missing or malformed | – | no |
| `redirects.lookup` | End the pipeline with { redirect: { to, status } } on an editor rule or an automatic redirect (a moved document's old path); pass through otherwise | `params.path` | `result?` | – | – (ends: { redirect: object }) | – | – | no |
| `redirects.export` | Write redirects.json to the blobstore: editor rules first, then automatic ones (adds `redirects: { rules, skipped }` to the result) | – | `result.redirects` | – | { redirects: object, … } | – | – | no |
| `redirects.render` | The compiled redirect list (same content as redirects.json) | – | `result` | – | object[] | – | – | no |
| `redirects.listAuto` | Effective automatic redirects (a moved document's old path, sorted by from) | – | `result` | – | object[] | – | – | no |
| `redirects.removeAuto` | Turn the automatic redirect at params.path into a removed tombstone; a replay of the move that created it cannot restore it | `params.path` | – | – | – | 400 missing path; 404 no automatic redirect at that path | – | no |

Pipelines in `examples/minimal` using these steps:

- **listAutoRedirects** (GET /admin/redirects/auto): `authn.requireUser` → `authz.require:redirects.read` → **`redirects.listAuto`**
- **pathsMovedRedirects** (event site.pathsMoved): **`redirects.recordMoves`** → **`redirects.export`**
- **publishAllPages** (POST /admin/publish-all/pages): `authn.requireUser` → `authz.require:pages.manage` → `delivery.publishAll:pages` → **`redirects.export`** → `delivery.exportLlms`
- **removeAutoRedirect** (DELETE /admin/redirects/auto/*path): `authn.requireUser` → `authz.require:redirects.write` → **`redirects.removeAuto`** → **`redirects.export`**
- **renderRedirects** (GET /redirects.json): **`redirects.render`** → `authz.fields:redirectRules?shape=array`
- **resolvePage** (GET /site/*path): `authn.identifyUser` → `authz.require:pages.read` → **`redirects.lookup`** → `site.resolve:pages?home=home&status=published&fallback=true` → `site.resolveLinks:pages?home=home&status=published&fallback=true` → `authz.fields:pages?shape=item`
- **setRedirects** (PUT /redirects): `authn.requireUser` → `authz.require:redirects.write` → `validate.check:redirects.rules` → **`redirects.validate`** → `content.set:redirects` → **`redirects.export`**

<!-- kestrel-docs:end -->
