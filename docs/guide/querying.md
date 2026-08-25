# Reading data over the API

The HTTP surface a site or an external client uses to read records: filtering, sorting, paging, population, and the write-side concurrency check.

## The pipeline shape

Every `/api/` endpoint is a pipeline: `GET`/`POST /api/<collection>/<pipelineName>[/<id>]` for a collection operation, or `POST /api/<pipelineName>` for a collection-less one (`login`, `publish`). The reads are `GET /api/<name>/readMany` (list) and `GET /api/<name>/readOne/<id>` (single record, or the singleton row of a `mode: 'single'` collection, addressed without an `/<id>` segment) — both generated for every collection, nothing to opt into beyond defining the collection itself. Both accept the query parameters below. The write ops — `createOne`/`createMany`/`updateOne`/`updateMany`/`deleteOne`/`deleteMany`, plus `duplicate` and `rollback` — are covered in [Pipeline engine](../internals/pipeline-engine.md), along with the gate/step machinery behind every route. See [Custom pipelines](./extending.md) for adding your own pipeline.

## List filtering

`readMany` accepts per-field filters on the query string — the same code path the admin list UI uses, so filtering is not admin-only. It also works on the public, published-only read of a `pageLike` collection: your filters compose with the published scope, so drafts still never leak.

The wire form is `filter[<field>][<op>]=<value>`. A bare `filter[<field>]=<value>` (no operator) means `eq`. Repeat a key to AND two clauses on one field.

```bash
# products under 50, in stock, created this year
GET /api/products/readMany?filter[price][lt]=50&filter[inStock]=true&filter[createdAt][gte]=2026-01-01
# a repeated key ANDs: rows tagged BOTH "a" and "b"
GET /api/products/readMany?filter[tags][contains]=a&filter[tags][contains]=b
```

Which operators a field accepts depends only on its **kind**:

| Kind | Field types (and system columns) | Operators |
| --- | --- | --- |
| `number` | `number` · the `id` column | `eq` `ne` `lt` `lte` `gt` `gte` |
| `datetime` | non-range `datetime` · `createdAt` · `updatedAt` | `eq` `ne` `lt` `lte` `gt` `gte` |
| `text` | `text` · `slug` · a `pageLike` `path` | `eq` `ne` `contains` |
| `richtext` | `richtext` | `contains` |
| `boolean` | `boolean` | `eq` `ne` |
| `enum` | single `choice` · a `status` column | `eq` `ne` |
| `ref` | single `relation` · single `media` | `eq` `ne` |
| `stringSet` | multi `choice` | `contains` `notContains` |
| `idSet` | many `relation` · multiple `media` | `contains` `notContains` |

A single `relation`/`media` field is filtered (and sorted) by its id column, `<field>Id`, not the bare field name — `filter[author][eq]=3` is a 400 on a single `relation` named `author`; use `filter[authorId][eq]=3&sort=-authorId`. A many relation or multiple-media field keeps the bare field name.

`id`, `createdAt`, and `updatedAt` are always filterable; `path` only on a `pageLike` collection and `status` only when `status: true`. `link`, `json`, `repeater`, and a **range** `datetime` are not filterable at all. For the set kinds, `contains` means array membership (the value equals one element), not a substring; `notContains` is its negation — on `idSet` (a many relation/media field) the value must be a numeric id, or the request is a 400. A custom field type falls back to the `text` kind: `eq`/`ne`/`contains` against its stored column — see [Custom field types](./custom-field-types.md).

Everything is fail-loud with a clean **400**, never a 500: an unknown operator token, a field that does not exist or is not filterable, and an operator that field's kind does not allow are each rejected with a descriptive message. Values are coerced to the column's type — a `boolean` accepts `true`/`1`, a `datetime` accepts any parseable date string (an unparseable one is a 400).

> **A date-only `datetime` filter names a whole day.** `lte`/`gt` against a bare `YYYY-MM-DD` value (not a full timestamp) are shifted to the exclusive start of the next UTC day, so `filter[createdAt][lte]=2026-01-15` includes every row from the 15th and `filter[createdAt][gt]=2026-01-15` starts on the 16th — comparing against midnight would otherwise drop the day's own rows from `lte` and wrongly include them in `gt`. `lt`/`gte` already mean "before/from that day" without adjustment.

> **The negating operators include empty values.** On a nullable column, `ne` also matches rows where the field is unset: `filter[category][ne]=news` returns the uncategorised records too, since they are certainly not `news`. That is a deliberate departure from SQL's `<>`, whose three-valued logic drops NULL rows. On a `notNull` column (required, or carrying a default) `ne` is plain `<>`. There is no operator for "is / is not empty" — use `eq`/`ne` against the value you do know.

> **`contains` matches the raw stored string** for `text`/`richtext`. Text is a case-insensitive ASCII substring match. For `richtext` the stored string is the HTML source, so `filter[body][contains]=span` can match a `<span>` tag or a `class="…"` attribute, not just visible prose.

## Response shape

`readMany` answers `{ data, total, page, perPage, quarantinedCount }`, where `data` is an array of records in the collection's serialized shape, with the populated sidecars described below when `?depth` was set. On a multi-mode translatable collection every row also carries `$translations` (locale → sibling record id, or `null`), including on a public, published-only read; an admin-scope read additionally carries `$hasDeadRefs` (`true` when a reference on that row points at a deleted or unpublished target). A stored row that no longer parses against its collection's schema is served instead as `{ id, $quarantined: true }` — every other field withheld — and `quarantinedCount` reports how many rows on the page were replaced this way. `readOne` answers the record itself (subject to the same quarantine substitution); for a collection with `id`s, a missing id or a filtered-out draft is a 404. For a singleton (`readOne` with no id), a missing or unpublished row is not an error — the response is a **204 No Content** with an empty body.

```json
{
  "data": [{ "id": 12, "title": "Launch week", "startsAt": "2026-09-01T09:00:00.000Z" }],
  "total": 37,
  "page": 1,
  "perPage": 25
}
```

## Sorting and paging

`?sort=<field>` sorts ascending; `?sort=-<field>` (a leading `-`) sorts descending. Sorting by an unknown field is a 400. With no `sort`, results order by `createdAt` descending.

`?page=<n>` (1-based, default `1`) and `?perPage=<n>` (default `25`, clamped to `[1, 500]`) page the result. A non-finite `page` or `perPage` (missing, `NaN`, a garbage string) falls back to the default rather than producing an unbounded query. `total` in the response is always the full match count across all pages, not the page size.

```bash
GET /api/products/readMany?sort=-createdAt&page=2&perPage=50
```

## Locale

On a `translatable` collection, `?locale=<code>` filters `readMany` to that locale and drives which locale gets populated for `?depth`. `?locale=all` returns every locale's rows with no locale filter, in which case the primary locale is used for population. On a non-translatable collection the parameter has no effect. On a `readOne/<id>` (addressed by id, not locale), `?locale` only drives which locale is used for population — it does not select which sibling record is returned; use the translations sub-route to find a sibling's id. On a singleton `readOne` (no id) on a translatable collection, `?locale` does select which locale's row is returned. A `?locale` outside the site's configured locales is a **400** on a translatable collection; `?locale=all` and any locale value on a non-translatable collection are not validated at all. An absent or empty value falls back to the primary locale rather than erroring.

```bash
GET /api/posts/readMany?locale=de&sort=-updatedAt
```

## `?depth` and population

`?depth=<n>` (default `0`, clamped to `[0, 10]`) controls how far reference-bearing fields are resolved on read: a media field resolves to a `ResolvedMedia` object (id, alt, mime, dimensions, `src`, `srcset`, and more) under `$media.<field>`, an internal link value is rewritten in place with a resolved `href` (and `richtext` has its internal-link markers rewritten the same way), and a relation becomes the related record, attached under a `$<name>` sibling next to the raw id column. `depth: 0` returns raw ids only. `depth: 1` resolves one hop: a relation becomes its target record, but that record's own media/links/relations stay raw ids (a `speakers` relation at `depth: 1` gives `$speakers[i]` with no `$media` on it). Each additional level resolves one hop further outward (`depth: 2` on the same record gives `$speakers[i].$media` already resolved). The full population mechanism — the registries, the field-tree walker, key-mode — is in [Read-time population](../internals/populate.md).

Three things bound what a given caller can pull in through the populated sidecars:

- **Published-only.** A draft, missing, or deleted relation target is skipped — a single relation resolves to `null`, a many-relation drops the stale entry — never leaked into a read and never 404-ing the whole record.
- **Public read scope.** For an anonymous caller (and for a missing principal, which fails closed the same way), a relation whose target collection sits outside the public set is left unexpanded: raw id only, no populated sidecar at all, at every hop. `?depth` on `readMany`/`readOne` is bounded by this; it does not let an anonymous caller walk into non-public collections just by asking for more depth.
- **Resolve budget.** Population runs under a per-request budget on distinct references, scaled with `?perPage`. Past it, further new references resolve to `null` instead of expanding, and the server logs a warning once per request — a large `?perPage=500&depth=3` read can come back with some relations/media silently unpopulated; lower `perPage`/`depth` if that happens.

## Published-only and public reads

A `pageLike` collection's published records are reachable through the same routes it ships to the static site with: `GET /api/<name>/readMany` (published-only) and `GET /api/<name>/readOne/<id>` (404 for a draft). Drafts stay private, and the tooling sub-routes (`/options`, `/translations`, `/deadRefs/<id>`, `/schema`, `/referrers`) remain admin-only. A non-`pageLike` collection has no public surface at all — its whole `/api/<name>` stays behind the guard.

An authenticated read as the `admin` role sees drafts too; the published-only scope is a property of the caller's role, not of the route. A non-browser client authenticates by sending the session cookie issued by `POST /api/login` — see [Auth / session](./configuration.md#auth--session--env-only-by-design).

The static site renders a `pageLike` record by its `path` the same way: a published-only, `depth: 1` lookup. Its population scope is not pinned to the public set the way an anonymous `readOne` is, so it can expand a relation into a collection an anonymous caller's `?depth` could not reach.

## Optimistic concurrency

An `updateOne` call may send an `X-Kestrel-If-Unmodified-Since: <updatedAt-ms>` header — the `updatedAt` epoch you last read. If the record has changed since, the write is refused with **409** before any mutation, so a stale editor tab can't silently overwrite a newer save. Omit the header, or send a value that doesn't parse as a number, for an unconditional write — a non-numeric header is treated as absent rather than rejected.

```bash
POST /api/products/updateOne/42
X-Kestrel-If-Unmodified-Since: 1735689600000
cookie: <admin session cookie>
```

Omitting the header is the right default for a script or a batch job where "last write wins" is fine; send it from an editor UI that keeps a record open across multiple saves, where a silent overwrite would lose someone else's edit.

## Errors

A read request fails loud, never silently: a filter on an unknown or non-filterable field, an unsupported operator, an unknown sort field, or (on a translatable collection) an unsupported `?locale` is a **400** with a message naming the offending field or locale. A `readOne` by id that does not exist, or exists but is filtered out by the published-only scope, is a **404**; the same miss on a singleton (`readOne` with no id) is a **204 No Content** with an empty body instead. A `page`/`perPage`/`depth` value that fails to parse falls back to its default instead of erroring, since these are best-effort UI conveniences rather than user-authored predicates.

## Combining parameters

`filter`, `sort`, `page`/`perPage`, `depth`, and `locale` all compose on the same request — a single `readMany` call can page through a filtered, sorted, populated, locale-scoped list:

```bash
GET /api/events/readMany?filter[status]=published&sort=startsAt&page=1&perPage=25&depth=1&locale=en
```

`readOne` accepts `depth` the same way (filter/sort/page do not apply to a single record). On `readOne/<id>` the record is addressed by id alone; `?locale` only picks which locale is used to populate it, not which record is returned — use the translations sub-route to find a sibling's id:

```bash
GET /api/events/readOne/42?depth=1&locale=de
```

## See also

- [Collections](./collections.md) — defining the fields and relations a query reads.
- [Read-time population](../internals/populate.md) — the populator registries and the field-tree walker behind `?depth`.
- [Extending Kestrel](./extending.md) — writing your own pipeline alongside the built-in CRUD ops.
- [Publishing](./publishing.md) — how a write becomes a published, publicly readable record.
- [Configuration](./configuration.md#auth--session--env-only-by-design) — configuring admin login.
