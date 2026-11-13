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
Validates every write (unknown fields, types, required, unique, reserved names — persistence backs
`unique` with an index, so a race that slips past the pre-check still answers the same field-shaped
error). A field name may not start with `_`: that namespace is reserved for members the system adds
to a document, such as `_locale`, `_links`, `_translations`, `_delivery` and `_events`. Boot fails naming the
type and the field. Sets
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

`get:<t>` reads `params.id` (none for a single type) and takes `?fallback=true`; a single type
answers with an empty document rather than a 404, unless the step argument pins a fixed filter the
stored document can miss; `list:<t>` or
`list:<t>?status=published` pins a fixed filter the client cannot override and reads `limit`,
`offset` and `sort=-field` from the payload. `limit` and `offset` must be integers (`limit` ≥ 1,
`offset` ≥ 0), `limit` at most `maxLimit` (config, default 200), `sort` a known field; anything
else is `VALIDATION` (400). Without `limit`, a page holds at most `defaultLimit` items (config, default
`maxLimit`, never above it, or setup fails); `total` still counts every match, so a client pages with
`offset`. The limit applies to the step only: `content@1`'s own `list()` stays unbounded for callers in
the process. An unknown `?locale=` is `VALIDATION` too, on every step.
A fixed filter also narrows `_translations`: a locale counts only once its own values satisfy the
same filter too (`get` through `@michaelthielemann/kestrel-contracts/helpers/content-locale`'s
`publishedLocale`, `list` through its `narrowListTranslations`, one query per other locale for the
whole page, not per item). A fixed filter together with `?fallback=true` fails to boot, naming the
step: `fallback` fills a field from the default locale whatever its own status, so a filtered read
must never use it — read the requested locale strictly instead, or resolve the page through
`site.resolve`.
The field type set is closed. An unknown `type` fails the config schema at boot, naming the field
(`types.pages.fields.accent: Invalid input`), so a consumer-defined field type is declared here as
the `content/default` type it is *stored* as – a colour as `text`, a link object as `json`. Its
value shape is enforced by a `validate@1` provider beside this module, not by the model:
`validate.check:<type>.<field>` with an inline JSON Schema, run before `content.create`,
`content.update` or `content.set`, answers `VALIDATION` (400) with `details.fields` naming the
field. That holds for localized fields too – the payload carries the plain field name and the
locale comes from `params.locale` or `payload.locale`. An absent or `null` value passes the schema
check; `required` stays this module's job. `content.describeModel` reports the storage type, so a
UI that wants the consumer's own type name keeps that mapping on its side.

Not included: referential integrity (see references-default), URL paths and internal link
rewriting (see site-default), versioning.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-content-default` – module `content/default`: provides `content@1`; requires `persistence@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `types` | record | yes | – |
| `locales` | array | no | – |
| `defaultLocale` | string | no | – |
| `maxLimit` | integer | no | `200` |
| `defaultLimit` | integer | no | – |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `content.validate:<arg>` | Validate a <arg> payload | – | – | { locale?: "de" \| "en" } | – | 400 validation failed | – | yes |
| `content.create:<arg>` | Create a <arg> | – | `result` | { locale?: "de" \| "en" } | { id: string, createdAt: number, updatedAt: number, _locales?: object, _translations?: object, … } | 400 validation failed; 409 a document with that id already exists | – | yes |
| `content.set:<arg>` | Replace the <arg> document | – | `result` | { locale?: "de" \| "en" } | { id: string, createdAt: number, updatedAt: number, _locales?: object, _translations?: object, … } | 400 validation failed | – | yes |
| `content.get:<arg>` | One <arg> document | `params.id` | `result` | ?locale: "de" \| "en" | { id: string, createdAt: number, updatedAt: number, _locales?: object, _translations?: object, … } | 400 unknown locale; 404 not found | – | yes |
| `content.list:<arg>` | List <arg> | – | `result` | ?locale: "de" \| "en", limit: integer, offset: integer, sort: string | { items: object[], total: number, … } | 400 invalid limit, offset, sort or locale | – | yes |
| `content.update:<arg>` | Update a <arg> | `params.id` | `result` | { locale?: "de" \| "en" } | { id: string, createdAt: number, updatedAt: number, _locales?: object, _translations?: object, … } | 400 validation failed; 404 not found | – | yes |
| `content.remove:<arg>` | Delete a <arg> | `params.id` | `result` | – | { ok: boolean, … } | 400 missing id | – | yes |
| `content.describeModel` | The content model: locales, default locale and every type with its fields | – | `result` | – | { locales?: string[], defaultLocale?: string, types: object, … } | – | – | yes |
| `content.removeTranslation:<arg>` | Remove one translation of a <arg> (locale from the route or ?locale=); the document stays in its other locales | `params.id` | `result` | ?locale: "de" \| "en" | { id: string, createdAt: number, updatedAt: number, _locales?: object, _translations?: object, … } | 400 unknown or missing locale; 404 document or translation not found; 409 last translation – remove the document | – | yes |

Used by 14 of 110 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
