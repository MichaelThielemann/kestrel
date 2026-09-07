# content/default
`content@1` on top of `persistence@1`. The content model comes from config: types with
`kind: single | multi` and fields of type `text richtext number boolean date slug json enum ref`
(`required`, `unique`, `localized`, `options`, `to` per field). A `ref` holds the id of a
document in `to`; existence and delete protection are checked by `references-default`. Pages, settings, posts are config
entries, not modules. With `locales`/`defaultLocale`, localized fields are stored per locale
(`title__de`) and resolved on read with fallback to the default locale; `required` and `unique`
apply per locale. The locale comes from `params.locale` or `payload.locale`. Reads are strict:
a missing translation is `null`; `fallback: true` (step argument `?fallback=true`) fills it from
the default locale and reports the origin per field in `_locales`; `_translations` says per locale
whether the required localized fields are present. `completeWhen: { field: "status", equals: "published" }` on a type refuses to set that value for
a locale whose required localized fields are missing (`VALIDATION` naming them).
Validates every write (unknown fields, types, required, unique, reserved names), sets
`createdAt`/`updatedAt`, stores dates as milliseconds. One persistence collection per type.
Every `content@1` method returns a `Result`: a failure is an `Err(KestrelError)`, never an
exception. Only wiring bugs throw (unknown type, `get` of a multi type without id, `create` on a
single type, `set` on a multi type, a filter on an unknown field).

| Step | reads | writes | codes |
|---|---|---|---|
| `content.validate:<t>` | – | – | VALIDATION (`details.fields`) |
| `content.create:<t>` | – | `result` | VALIDATION (`details.fields`), CONFLICT, TRANSIENT |
| `content.set:<t>` | – | `result` | VALIDATION (`details.fields`), TRANSIENT |
| `content.get:<t>` | `params.id` (multi types only) | `result` | VALIDATION, NOT_FOUND, TRANSIENT |
| `content.list:<t>` | – | `result` | VALIDATION, TRANSIENT |
| `content.update:<t>` | `params.id` | `result` | VALIDATION, NOT_FOUND, TRANSIENT |
| `content.remove:<t>` | `params.id` | `result` | VALIDATION (missing id), TRANSIENT |
| `content.removeTranslation:<t>` | `params.id` | `result` | VALIDATION, NOT_FOUND, CONFLICT, TRANSIENT |

`get:<t>` reads `params.id` (none for a single type) and takes `?fallback=true`; `list:<t>` or
`list:<t>?status=published` pins a fixed filter the client cannot override and reads `limit`,
`offset` and `sort=-field` from the payload. `limit` and `offset` must be integers (`limit` ≥ 1,
`offset` ≥ 0), `limit` at most `maxLimit` (config, default 200), `sort` a known field; anything
else is `VALIDATION` (400). An unknown `?locale=` is `VALIDATION` too, on every step.
Not included: referential integrity (see references-default), URL paths and internal link
rewriting (see site-default), custom field types, versioning.
