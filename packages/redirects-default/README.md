# redirects/default
Admin-managed redirects, plus automatic redirects for documents that moved: the `redirects` singleton
(`rules: json`, list of `{ from, to, status }`, order = priority) is compiled into wildcard rules.
`from` uses `*` (one segment) / `**` (one or more), `to` is a path or an `http(s)` URL with `$1…`; `status`
301 (default) | 302 | 307 | 308. Config: `type` (`redirects`), `field` (`rules`), `prefix` (blobstore prefix,
same as delivery-static), `key` (`redirects.json`), `reservedPaths` (see below). Requires `content@1`, `blobstore@1` and `persistence@1`
(own collections, reached through no other module's contract).
Steps: `redirects.validate` before `content.set` (`VALIDATION`, `details { row, field, reason, path? }`, message `Row N: …`, also for
an editor rule that would redirect into an existing automatic redirect and for rules that redirect in a loop); `redirects.recordMoves` applies
`site.pathsMoved` moves to the automatic-redirect state; `redirects.lookup` in the site pipeline before
`site.resolve` – on a hit (editor or automatic) the pipeline ends with `{ redirect: { to, status } }`;
`redirects.export` after save and in publish-all writes `<prefix>redirects.json` (`[{ from, pattern,
target, status }]`, editor rules first then automatic ones, `[]` when empty; broken legacy rows are skipped and
logged); `redirects.render` serves the same list from the DB; `redirects.listAuto` and `redirects.removeAuto`
back the admin view of automatic redirects.
Not included: query matching/forwarding, regex authoring, the edge handler itself (see `../../examples/nginx-njs`).

## How a rule compiles

Editors never write a regex. `from` is a path with `*` (one segment) or `**` (one or more)
wildcards, and `to` references them positionally as `$1`, `$2`, … in authored order. The exported list is
`{ from, pattern, target, status }` for every rule and nothing else, so a consumer such as the njs handler
needs no per-item shape check. `from` is the canonical form (leading slash, no trailing slash); `pattern`
is the same rule as an anchored regex source, for consumers that match with a regex engine.

A `from` holds at most 8 wildcards and 512 characters; a longer one is rejected with the row number.
A list holds at most 1000 rules (`MAX_RULES`): saving more fails with `VALIDATION`, and publishing a
stored longer list keeps the first 1000 and logs the rest as skipped.

## Rejection reasons

A rejected rule is answered with `400`, `code: "VALIDATION"` and the English message
`redirects: Row N: …`. `details` repeats the facts in a form a client can switch on, so it can show a
localized message: `{ row, field, reason, path? }`. `row` is the 1-based position in the list, `field` is
`from`, `to` or `status`, `reason` is one of the values below and `path` the offending path where there is one.

| Field | `reason` | Rejected when | `path` |
|---|---|---|---|
| `from` | `blank` | empty, or not a string | |
| `from` | `too-long` | longer than 512 characters | |
| `from` | `scheme-or-host` | starts with a scheme or `//` | |
| `from` | `query-or-fragment` | contains `?` or `#` | |
| `from` | `control-characters` | contains a control character | |
| `from` | `backslash` | contains a backslash | |
| `from` | `dot-segments` | has a `..` segment | |
| `from` | `adjacent-double-wildcards` | two `**` with only a separator between them | |
| `from` | `too-many-wildcards` | more than 8 wildcards | |
| `from` | `reserved-path` | can match a path of `reservedPaths` | the reserved prefix, e.g. `/admin` |
| `to` | `blank` | empty, or not a string | |
| `to` | `control-characters` | contains a control character | |
| `to` | `backslash` | contains a backslash | |
| `to` | `protocol-relative` | starts with `//` | |
| `to` | `unsupported-scheme` | a scheme other than `http` or `https` | |
| `to` | `invalid-url` | an `http(s)` URL that does not parse | |
| `to` | `embedded-credentials` | an URL with a user name or password | |
| `to` | `placeholder-in-host` | `$1`, `$2`, … in the host of an absolute URL | |
| `to` | `placeholder-out-of-range` | `$n` with `n` beyond the wildcards of `from` | |
| `to` | `placeholder-syntax` | a placeholder written as `${1}` | |
| `to` | `automatic-redirect-loop` | points at the source of an automatic redirect, also with a trailing slash, query or fragment | the source of the automatic redirect |
| `to` | `redirect-loop` | following the editor rules from a source comes back to a path already passed, or takes more than 20 redirects | the target |
| `status` | `invalid-status` | not 301, 302, 307 or 308 | |

An absolute target keeps its host and path as written, and its scheme is compiled in lower case: a rule
saved with `HTTPS://example.org/x` answers `https://example.org/x` in `redirects.lookup`,
`redirects.render` and `redirects.json`, while the stored list keeps what the editor typed.

## Redirect loops

`redirects.validate` follows the editor rules the way `redirects.lookup` does, starting at the source of
every rule, with `sample` standing for each wildcard: first match first, `$n` filled in, a path target
taken without its query, fragment and trailing slash, an absolute URL ending the chain. A list in which
such a chain comes back to a path it has already passed is refused with `redirect-loop`, at the row
whose target closes the loop, and the message names the paths and the rows:

```text
Row 3: "To" /a leads back to /a, a redirect loop: /a → /b → /a (rows 1, 3)
```

That covers a rule whose target is its own source (`/a` → `/a`), a target that only adds a trailing slash
or a query (`/a` → `/a/`), a wildcard rule that matches its own target (`/blog/**` → `/blog/$1`) and rules
that point at each other, also through several rows. A chain that keeps growing (`/news/**` →
`/news/archive/$1`) or passes more than 20 redirects is refused the same way, since browsers stop
following after about as many. Only the sample path is followed, so a loop that only a particular
capture reaches is not found. Rows that a stored list holds already are not checked when it is
published; the next save checks the whole list.

Each path a chain reaches is matched against the rules once, and a chain already followed from an
earlier source is not followed again. The check stops after a fixed amount of matching work: a list
that needs more, for instance hundreds of wildcard rules that come close to every one of many long
targets, is refused as a whole with `too-complex`. A list of 1000 wildcard rules under `/` with chains
of 20 redirects stays well below that limit and is checked in a fraction of a second.

A list that is not a list (`not-a-list`), holds more than 1000 rules (`too-many-rules`) or is too complex
to check for redirect loops (`too-complex`) is rejected as a whole: `details` is `{ reason }` without `row` and `field`. Duplicate rules are not rejected: the first
match wins. The first failing check of a row is reported. A row is checked in this order: `from` blank, the form of `to` and its placeholders, the other checks of `from` including reserved paths, then the status; a rule that fails more than one check is reported with the field of the first one in that order.

`redirects.export` reports each row it leaves out when publishing: as a line in `skipped` and as an
entry of `skippedRules` with the same `{ row, field?, reason, path? }` structure, in the same order. A row
beyond the 1000-rule limit is `{ row, reason: "too-many-rules" }` there.

The types `RedirectRuleReason`, `RedirectRuleField` and `RedirectRuleDetails`, the list
`REDIRECT_RULE_REASONS` of every reason and the class `RedirectRuleError` are exported from `@michaelthielemann/kestrel-redirects-default/impl`.

## Reserved paths

`reservedPaths` (default `["/admin", "/api", "/media"]`) lists path prefixes the application serves
itself. A `from` that can match one of them, the path itself or anything below it, is refused with
`Row N: "From" can match the reserved path /admin …`: that covers `/admin`, `/admin/x`, `/admin/*`, and
also a wildcard such as `/*` or `/**/login` that reaches `/admin/login`. A wildcard in the first
segment is refused even when the rest of the path is fixed: `/*/old-page`, the usual shape of a rule for
every language prefix, can reach `/admin/old-page`, so write one rule per prefix (`/de/old-page`,
`/en/old-page`). `/administration` shares
characters with `/admin` but not a path segment, so it stays allowed. Entries are absolute paths without
a trailing slash, as in `delivery-static`; pass the mounts of your own project, for instance the prefix
the API sits under.

A rule stored under a reserved path before the list was set, or after it grew, is not an error when
publishing: `redirects.lookup`, `redirects.export` and `redirects.render` leave it out and log the row,
like any other row they cannot honour. An automatic redirect whose old path lies at a reserved path, for
instance a page that moved away from `/admin`, is left out as well: `redirects.export` and
`redirects.render` log it, `redirects.lookup` answers without it and without a log line. It still
appears in the list of automatic redirects, but never takes effect. The edge handler in `../../examples/nginx-njs` takes the same list
in `RESERVED_PATHS` and never redirects those paths.

## Matching

`redirects.lookup` matches `from` directly, without a regex: a linear pass over the request path per
rule, so the cost of a lookup grows with the path length and the number of rules, never with how the
wildcards of a rule can be split. `*` takes as much of the segment as it can, `**` as little as it can,
and a trailing slash on the request is tolerated; the captures are exactly those of `pattern`. A request
path longer than 2048 characters matches no rule and falls through to the page lookup. The njs handler in
`../../examples/nginx-njs` uses the same algorithm.

`pattern` in a backtracking regex engine gives the same result, but several wildcards in one segment
(`/p/*-*-*`) can take time polynomial in the path length on a path that almost matches. An edge that
matches `pattern` bounds the request path length itself, or matches `from` as described above.

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
| `reservedPaths` | array | no | `["/admin","/api","/media"]` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `redirects.validate` | Compile the redirect rules of the payload; VALIDATION names the offending row, also for a rule that redirects into an active automatic redirect and for rules that redirect in a loop | – | – | { rules?: object[] } | – | 400 Row N: <reason>; details carries { row, field, reason, path? } | – | no |
| `redirects.recordMoves` | Apply site.pathsMoved moves to the automatic-redirect state: per document the highest seq wins, a tie inside one run favours the destination path | `payload` | `result.autoRedirects` | { moves?: object[], … } | { autoRedirects: object, … } | 400 payload.moves is missing or malformed | – | no |
| `redirects.lookup` | End the pipeline with { redirect: { to, status } } on an editor rule or an automatic redirect (a moved document's old path); pass through otherwise | `params.path` | `result?` | – | – (ends: { redirect: object }) | – | – | no |
| `redirects.export` | Write redirects.json to the blobstore: editor rules first, then automatic ones (adds `redirects: { rules, skipped, skippedRules }` to the result) | – | `result.redirects` | – | { redirects: object, … } | – | – | no |
| `redirects.render` | The compiled redirect list (same content as redirects.json) | – | `result` | – | object[] | – | – | no |
| `redirects.listAuto` | Effective automatic redirects (a moved document's old path, sorted by from) | – | `result` | – | object[] | – | – | no |
| `redirects.removeAuto` | Turn the automatic redirect at params.path into a removed tombstone; a replay of the move that created it cannot restore it | `params.path` | – | – | – | 400 missing path; 404 no automatic redirect at that path | – | no |

Pipelines in `examples/minimal` using these steps:

- **listAutoRedirects** (GET /admin/redirects/auto): `authn.requireUser` → `authz.requireRole` → `authz.require:redirects.read` → **`redirects.listAuto`**
- **pathsMovedRedirects** (event site.pathsMoved): **`redirects.recordMoves`** → **`redirects.export`**
- **publishAllPages** (POST /admin/publish-all/pages): `authn.requireUser` → `authz.requireRole` → `authz.require:pages.manage` → `delivery.publishAll:pages` → **`redirects.export`** → `delivery.requestIndexes`
- **removeAutoRedirect** (DELETE /admin/redirects/auto/*path): `authn.requireUser` → `authz.requireRole` → `authz.require:redirects.write` → **`redirects.removeAuto`** → **`redirects.export`**
- **renderRedirects** (GET /redirects.json): **`redirects.render`** → `authz.fields:redirectRules?shape=array`
- **resolvePage** (GET /site/*path): `authn.identifyUser` → `authz.require:pages.read` → **`redirects.lookup`** → `site.resolve:pages?home=home&status=published&fallback=true` → `site.resolveLinks:pages?home=home&status=published&fallback=true` → `authz.fields:pages?shape=item`
- **setRedirects** (PUT /redirects): `authn.requireUser` → `authz.requireRole` → `authz.require:redirects.write` → `validate.check:redirects.rules` → **`redirects.validate`** → `content.set:redirects` → **`redirects.export`**

<!-- kestrel-docs:end -->
