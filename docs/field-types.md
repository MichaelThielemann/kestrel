# Field types

Every field in a collection has a `type`, and the type decides three separate things: the SQLite column
it becomes, the Zod schema the server validates writes against, and the widget the admin renders. This
page documents all twelve built-in types with each of their options.

The distinction that matters most while reading: an option is enforced by the **server**, shapes the
**column**, or only configures the **widget**. A widget-only option is a convenience for the editor, not
a guarantee — a direct API write ignores it. Each option table says which.

Collections are defined with `defineCollection`; see
[consuming-kestrel.md](./consuming-kestrel.md) for the surrounding structure.

## The types at a glance

| Type | Stores | Column | Options |
|---|---|---|---|
| [`text`](#text) | a string | `text` | `minLength`, `maxLength`, `multiline` |
| [`slug`](#slug) | a URL-safe string | `text` | `from`, `prefix` |
| [`richtext`](#richtext) | sanitized HTML | `text` | — |
| [`number`](#number) | a number | `integer` or `real` | `min`, `max`, `integer`, `decimals`, `unit` |
| [`boolean`](#boolean) | true / false | `integer` (boolean mode) | — |
| [`datetime`](#datetime) | an ISO string, or a range | `text` | `precision`, `range` |
| [`choice`](#choice) | one or many of a fixed set | `text` or JSON array | `choices`, `multiple`, `display` |
| [`link`](#link) | an internal / external / email / tel link | `text` (JSON) | `types`, `collections` |
| [`media`](#media) | one or many media ids | `integer` or JSON array | `multiple`, `accept` |
| [`relation`](#relation) | one or many record ids | `integer` or JSON array | `relation.collection`, `relation.many`, `relation.labelField` |
| [`repeater`](#repeater) | a list of sub-records | JSON array | `fields`, `fieldLayout` |
| [`json`](#json) | arbitrary JSON | `text` (JSON), `NOT NULL` | — |

Need something else? See [custom field types](#custom-field-types).

## Flags every type accepts

```ts
{
  required?: boolean
  default?: unknown
  unique?: boolean
  index?: boolean
  label?: string | Record<string, string>
  condition?: Condition
  renamedFrom?: string
  populate?: (bag, key, field, ctx, keyMode) => void
}
```

| Flag | What it does |
|---|---|
| `required` | Makes the column `NOT NULL` and the validator reject empty. **Only when there is no `condition`** — a conditional field stays nullable in the database and is enforced at validation time instead. |
| `default` | The column default. Must be JSON-safe, because it is serialized to the admin along with the schema. |
| `unique` | A DB uniqueness constraint — but see [the `unique` no-op](#unique-is-a-no-op-on-multi-valued-fields). |
| `index` | A plain (non-unique) index. Skipped when `unique` is set, which already indexes. |
| `label` | The editor label; falls back to a humanized key. Accepts a per-locale record. |
| `condition` | Shows or hides the field based on another field's value. Evaluated in the editor *and* re-checked on the server for conditionally-required fields. |
| `renamedFrom` | Migration path: the schema diff emits a column **rename** instead of drop + add, so the data survives. Only takes effect while the old column still exists. |
| `populate` | Replaces the type's populator for this one field. See [population.md](./population.md). |

## text

```ts
{ type: 'text'; options?: { minLength?: number; maxLength?: number; multiline?: boolean } }
```

| Option | Type | Enforced by |
|---|---|---|
| `minLength` | `number` | Server + widget (`minlength` attribute) |
| `maxLength` | `number` | Server + widget (`maxlength` attribute) |
| `multiline` | `boolean` | **Widget only** — renders a textarea instead of a single-line input |

**Column** `text`. **Validation** `z.string().trim()`. A required text field also rejects the empty
string, unless you set an explicit `minLength` of your own.

```ts
fields: {
  title: { type: 'text', required: true, options: { maxLength: 120 } },
  summary: { type: 'text', options: { multiline: true, maxLength: 500 } },
}
```

## slug

```ts
{ type: 'slug'; options?: { from?: string; prefix?: string } }
```

| Option | Type | Enforced by |
|---|---|---|
| `from` | `string` | Server — when the slug is left empty, it is generated from this field |
| `prefix` | `string` | **Widget only** — a display chip in front of the input; never stored |

**Column** `text`. The value is always run through `slugify`, whether typed or derived. Slug uniqueness
for page-like collections is checked separately against the database, so a collision is reported on the
field rather than as a generic constraint error.

```ts
fields: {
  title: { type: 'text', required: true },
  slug: { type: 'slug', unique: true, options: { from: 'title', prefix: '/blog/' } },
}
```

## richtext

```ts
{ type: 'richtext' }
```

No options. **Column** `text`.

The stored HTML is sanitized on the server on every write, against a fixed allow-list:

```
p, br, span, strong, b, em, i, u, s, sub, sup, mark, blockquote, pre, code,
h1, h2, h3, h4, h5, h6, ul, ol, li, a, hr
```

Attributes are limited to `class` and `style` globally (and only `text-align` among styles), plus
`href`, `title`, `target` and `rel` on links. External links get `target="_blank"` and
`rel="noopener noreferrer nofollow"` added automatically. There is no image or table support.

> Sanitization runs **before** the required check, so content that consists only of disallowed tags
> counts as empty and fails a `required: true` field.

Internal links are stored as a `kestrel:` marker and resolved to real paths on read; a link to an
unpublished target renders as `#`. See [reference-integrity.md](./reference-integrity.md).

```ts
fields: { body: { type: 'richtext', required: true } }
```

## number

```ts
{ type: 'number'; options?: { min?: number; max?: number; integer?: boolean; decimals?: number; unit?: string; units?: string[] } }
```

| Option | Type | Enforced by |
|---|---|---|
| `min` | `number` | Server + widget |
| `max` | `number` | Server + widget |
| `integer` | `boolean` | Server — picks the column type **and** the validator |
| `decimals` | `number` | Server (indirectly — any value switches the column to `real`) + widget step |
| `unit` | `string` | **Widget only** — a display suffix; the stored value stays a bare number |
| `units` | `string[]` | **Not yet honoured anywhere** — reserved |

> **A number field is an integer by default.** The column is `real` only if you pass `integer: false`
> or a `decimals` value. Storing `19.99` in a field you did not opt out of integer mode truncates it.

```ts
fields: {
  stock: { type: 'number', options: { min: 0 } },
  price: { type: 'number', options: { integer: false, decimals: 2, min: 0, unit: '€' } },
}
```

## boolean

```ts
{ type: 'boolean' }
```

No options. **Column** `integer` in boolean mode. The widget is a three-state control — true, false and
unset — so an optional boolean can genuinely be "not answered".

```ts
fields: { featured: { type: 'boolean', default: false } }
```

## datetime

```ts
{ type: 'datetime'; options?: { precision?: 'date' | 'datetime' | 'time'; range?: boolean } }
```

| Option | Type | Enforced by |
|---|---|---|
| `precision` | `'date' \| 'datetime' \| 'time'` | Server (picks the ISO schema) + widget. Defaults to `'datetime'` |
| `range` | `boolean` | Server — changes both the column and the validator — + widget |

**Column** `text`; with `range: true` a JSON object `{ start, end }`. A range is rejected unless
`start <= end`.

```ts
fields: {
  publishedOn: { type: 'datetime', options: { precision: 'date' } },
  runsFor: { type: 'datetime', options: { range: true, precision: 'date' } },
}
```

## choice

```ts
{ type: 'choice'; options: { choices: { label: string; value: string }[]; multiple?: boolean; display?: 'select' | 'buttons' | 'checkboxes' } }
```

`options` is **required** here, unlike most types.

| Option | Type | Enforced by |
|---|---|---|
| `choices` | `{ label, value }[]` | Server — becomes a `z.enum` of the values |
| `multiple` | `boolean` | Server — changes both the column and the validator |
| `display` | `'select' \| 'buttons' \| 'checkboxes'` | **Widget only** |

**Column** `text` for a single choice, a JSON array when `multiple`.

```ts
fields: {
  status: {
    type: 'choice',
    required: true,
    options: {
      display: 'buttons',
      choices: [
        { label: 'Draft', value: 'draft' },
        { label: 'Review', value: 'review' },
      ],
    },
  },
}
```

## link

```ts
{ type: 'link'; options?: { types?: LinkType[]; collections?: string[] } }
```

| Option | Type | Enforced by |
|---|---|---|
| `types` | `('internal' \| 'external' \| 'email' \| 'tel')[]` | **Widget only** |
| `collections` | `string[]` | **Widget only** — limits the internal-link picker |

> Both options constrain the editor, not the API. The validator accepts any of the four link shapes
> regardless of what you list here.

**Column** `text` holding JSON. The stored value is one of:

```ts
{ type: 'internal', collection: string, id: number, hash?: string, label?: string }
{ type: 'external', url: string, label?: string }
{ type: 'email',    email: string, label?: string }
{ type: 'tel',      tel: string, label?: string }
```

External URLs must be `http`/`https`, and are rejected if they contain control characters or embedded
credentials. An anchor `hash` must start with a letter or digit. On read, an internal link is resolved
to an `href`; a link to an unpublished record resolves to `#`.

```ts
fields: {
  cta: { type: 'link', options: { types: ['internal', 'external'], collections: ['pages'] } },
}
```

## media

```ts
{ type: 'media'; options?: { multiple?: boolean; accept?: 'image' | 'any' } }
```

| Option | Type | Enforced by |
|---|---|---|
| `multiple` | `boolean` | Server — changes the column, the validator **and the column name** |
| `accept` | `'image' \| 'any'` | **Widget only** — no server-side MIME check |

**Column** a single media field stores a media id in `integer`, and its column is named `<key>Id`
(`<key>_id` in SQLite). With `multiple: true` it is a JSON array and the key is unchanged.

On read the resolved media records are attached under `$media.<field>`; a dangling id resolves to
`null` rather than failing the read. See [media-uploads.md](./media-uploads.md).

```ts
fields: {
  hero: { type: 'media', options: { accept: 'image' } },   // column: heroId
  gallery: { type: 'media', options: { multiple: true } },  // column: gallery
}
```

## relation

```ts
{ type: 'relation'; relation: { collection: string; many?: boolean; labelField?: string } }
```

The config lives under `relation`, not `options`, and is required.

| Option | Type | Enforced by |
|---|---|---|
| `relation.collection` | `string` | Server — the collection to resolve against |
| `relation.many` | `boolean` | Server — changes the column, the validator **and the column name** |
| `relation.labelField` | `string` | **Widget only** — which field of the target to show in the picker |

**Column** as with `media`: a single relation is `integer` named `<key>Id`, a `many` relation is a JSON
array under the plain key.

Resolved records are attached under `$<field>`. Population is **published-only** — a draft target never
reaches a public read — and a missing target resolves to `null` while other errors propagate. Nested
population is depth-limited; see [population.md](./population.md).

```ts
fields: {
  author: { type: 'relation', relation: { collection: 'authors', labelField: 'name' } },
  tags: { type: 'relation', relation: { collection: 'tags', many: true } },
}
```

## repeater

```ts
{ type: 'repeater'; options: { fields: Record<string, FieldDef>; fieldLayout?: FieldLayoutDSL } }
```

`options` is **required**.

| Option | Type | Enforced by |
|---|---|---|
| `fields` | `Record<string, FieldDef>` | Server — each sub-field is validated with its own type's schema |
| `fieldLayout` | `FieldLayoutDSL` | **Widget only** — arranges the sub-fields inside a row |

**Column** a JSON array. Sub-fields are not separate columns, so they are not individually indexable or
uniquely constrainable — but their populators still run: a `media` or `relation` inside a repeater is
resolved per row. A conditionally-required sub-field is re-checked per row.

```ts
fields: {
  faqs: {
    type: 'repeater',
    options: {
      fields: {
        question: { type: 'text', required: true },
        answer: { type: 'richtext' },
      },
      fieldLayout: [['question', 'answer']],   // side by side in each row
    },
  },
}
```

## json

```ts
{ type: 'json' }
```

No options. **Column** `text` in JSON mode, always `NOT NULL` with a default of `{}` — the `NOT NULL` is
unconditional and does not follow `required`.

Because of that default, an optional `json` field that receives `null` is stored as `{}`. Sending an
explicit `null` in a PATCH is therefore a reset, not a clear. A required `json` field rejects `null` and
`undefined` but accepts any other JSON value, including `{}`.

The editor renders a raw JSON textarea and reports parse errors locally, independent of server
validation.

```ts
fields: { settings: { type: 'json', default: { theme: 'light' } } }
```

## Custom field types

Register a server descriptor, then a widget for the editor:

```ts
// server/field-types/color.ts
import { text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

export default defineFieldType({
  name: 'color',
  column: (n, f) => constrain(text(n), f),                       // honours required / unique / default
  validator: (f) => opt(z.string().regex(/^#[0-9a-f]{6}$/i), f), // required-aware
})
```

`constrain` and `opt` are the same auto-imported helpers the built-in types use — reach for them rather
than hand-rolling nullability, or the flags in the table above stop working for your type.

```ts
// app/plugins/color-field.client.ts
export default defineNuxtPlugin(() => {
  registerFieldComponent('color', ColorField)
  registerFieldEmpty('color', () => '#000000')   // optional: seed new records
})
```

`column` and `validator` are required; `transform` is optional and runs before validation. Registering a
name that already exists warns and then overrides. `registerFieldEmpty` matters for array- or
object-backed types — without it a new record seeds the field with `null`.

The full walkthrough is in [consuming-kestrel.md](./consuming-kestrel.md#custom-field-types).

## Caveats

### `unique` is a no-op on multi-valued fields

A uniqueness constraint needs a scalar column, so `unique: true` is silently ignored on every
JSON-backed field: `choice` with `multiple`, `media` with `multiple`, `relation` with `many`, and every
`repeater` and `json` field. The collection still builds — it warns on the console at build time rather
than failing, so an existing definition keeps booting.

### Client-side validation is advisory

The widgets emit HTML5 constraints (`minlength`, `maxlength`, `min`, `max`, `step`) for `text` and
`number`, which a direct API call bypasses entirely. The server's Zod schema is the only authority, and
several types — `link`, `media`, `relation`, `repeater`, `boolean`, `slug`, `richtext` — have no
field-specific client check at all beyond required.

### `condition` keeps the column nullable

`required: true` combined with a `condition` never makes the column `NOT NULL`, even if the condition is
always true in practice. The requirement is enforced at validation time only.

