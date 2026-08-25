# Field layout and conditional fields

`fieldLayout` arranges a collection's editor form into rows, columns, and named groups, and `condition` shows or hides individual fields based on other field values.

## Field layout

By default the editor renders one field per row, in declaration order. Add a `fieldLayout` to arrange the
collection's fields into side-by-side columns and named groups. It is **presentation only** — it changes
nothing about storage, validation, or the API.

```ts
export default defineCollection({
  name: 'events',
  mode: 'multi',
  fields: {
    title: { type: 'text', required: true },
    startsAt: { type: 'datetime' },
    endsAt: { type: 'datetime' },
    metaTitle: { type: 'text' },
    metaDescription: { type: 'text' },
    body: { type: 'richtext' },
  },
  fieldLayout: [
    'title',                              // a lone string → its own full-width row
    ['startsAt', 'endsAt'],               // an array → a side-by-side row (equal columns)
    { 'SEO': [['metaTitle', 'metaDescription']] },  // a single-key object → a named group of rows
  ],
})
```

Each entry is one of:

- **a string** — a full-width row (`'title'`). Add a width to give it a single sized track: `'title|50%'`.
- **an array** — fields side by side. Equal columns by default, or size each with `|`:
  - `'field|2'` — a **flex weight** (`2fr`), so `['a|2', 'b|1']` splits 2 : 1.
  - `'field|30%'` — an explicit **length/percent** (`%`, `px`, `rem`, `em`, `fr` allowed). A width must be
    a positive, finite number, alongside a valid unit.
- **a single-key object** — a **named group** rendered as a labelled `<fieldset>`: `{ 'SEO': [ …rows ] }`.
  A group's value is a list of **rows** (each a string or an array), so `{ 'SEO': ['a', 'b'] }` stacks two
  full-width rows while `{ 'SEO': [['a', 'b']] }` is one two-column row. Groups are **one level deep** — a
  group may not contain another group. A group heading is a **plain string** — it is the object's key, so
  (unlike a field or collection label) it is **not** localizable.

Any field you **omit** from `fieldLayout` is appended as a full-width row at the end, in declaration order,
so adding a field can never silently hide it. `fieldLayout` addresses only the keys declared in `fields`; the
system controls a `pageLike` collection gets — page path, status, SEO, page layout, block body — render in
their own pane and cannot be named in a row or group. Columns collapse to a single column on narrow
viewports. An unknown field name, a duplicate field, an invalid width, or a nested group **throws** — for a
collection (and a repeater reached through it) the layout is validated both at `defineCollection()` and when
its schema is serialized, so a bad layout fails at import/startup, never silently at render. A repeater's
layout declared inside a block prop is checked later, when that block's schema is first served.

A field hidden by its `condition` (see below) collapses its grid track rather than leaving a gap: the
remaining visible cells in that row keep their own track size, so flex weights (the default) re-spread to
fill the freed space, while explicit `%`/`px`/`rem` widths do not grow — a row of two 30%-wide columns with
one hidden still leaves 70% of the row empty.

## Repeater layouts

A repeater's sub-fields take the same layout DSL under `options.fieldLayout`, applied inside each row of the
repeater:

```ts
fields: {
  faqs: {
    type: 'repeater',
    options: {
      fields: {
        question: { type: 'text', required: true },
        answer: { type: 'richtext' },
      },
      fieldLayout: [['question', 'answer']],   // side by side in each repeater row
    },
  },
}
```

See [field-types.md](./field-types.md) § `repeater` for the type's full options table, including what a
repeater's storage means for indexing and uniqueness.

## Conditional fields

Any field (collection field or block field, at any depth) can carry a `condition` that shows it only when
other fields match. `required` is enforced per write, only while the field is visible — see [field-types.md](./field-types.md)
§ "`condition` keeps the column nullable" for what pairing `condition` with `required` does to the column.

```ts
fields: {
  kind: { type: 'choice', options: { choices: [{ label: 'Image', value: 'image' }, { label: 'Embed', value: 'embed' }] } },
  // shown (and required) only when `kind` is "image":
  alt:      { type: 'text',  required: true, condition: { field: 'kind', is: 'image' } },
  embedUrl: { type: 'text',  required: true, condition: { field: 'kind', is: 'embed' } },
}
```

A block prop carries the same `condition` as a factory option, not a literal field object:

```ts
heading: textField({ condition: { field: 'kind', is: 'image' } })
```

A condition is a leaf rule combined by explicit `and` / `or` / `not`:

```ts
condition: { field: 'kind', is: 'image' }                       // strict equality shorthand
condition: { field: 'count', op: { gte: 1, lt: 10 } }           // operators (multiple keys are ANDed)
condition: { or: [{ field: 'a', is: true }, { field: 'b', is: true }] }
condition: { not: { field: 'status', op: { in: ['archived'] } } }
condition: { field: 'tags', op: { empty: false } }              // present (non-empty)
```

Operators: `eq` `ne` `gt` `gte` `lt` `lte` (scalars; type-sensitive) · `in` `notIn` · `regexp`
(case-sensitive) · `empty`. A bare `{ field }` (no `is`/`op`) means "present" — not empty, where empty is
null/undefined/`''`/`[]`, so `0` and `false` count as present. `is`/`op` are type-sensitive — `{ is: true }`
does not match `1`.

## Current limitations

`field` references a **sibling** in the same scope — a sibling collection field, a sibling prop of the same
block, or a sibling sub-field of the same repeater row — as `name` or `./name`. Cross-scope paths
(`../parent`, `/root`, dotted paths, repeater item-counts) are not supported and never error — the path
simply resolves to `undefined`. That makes `is` and a bare `{ field }` presence rule fail to match, hiding
the field, but it makes `op: { empty: true }`, `ne`, and `notIn` match `undefined` and leave the field
visible — check which operator an unresolvable path is paired with. A hidden field's stored value is left
as-is, not cleared.

A block definition does not accept its own `fieldLayout` — its props render one field per row — though the
`condition` on each prop still applies.

## See also

- [Collections](./collections.md) — defining `fields` and the rest of `CollectionDef` that `fieldLayout` sits beside.
- [Field types](./field-types.md) — the repeater type and its other options.
- [Blocks](./blocks.md) — how block props are declared with the field factories that `condition` above uses.
