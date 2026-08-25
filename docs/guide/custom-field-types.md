# Custom field types and editor bodies

Two client+server extension recipes for a site: register a new field type with its own storage and widget, or swap the whole editor body for a collection.

## Register a field type

A field type needs a **server descriptor** (storage column + validation) and a **client widget** (the editor input). Once both are registered, `{ type: 'mytype' }` works in any collection or block field, and flows through everything for free: the DB column, server validation, the editor, the serialized schema, and the live preview. Client-side validation is not part of that: the editor only ever runs the generic empty/`required` check for an unregistered type, since `validateField` has no seam for a per-type client check next to `registerFieldComponent`. The `validator` you register runs server-only — a widget wanting inline feedback has to do its own check, and a bad value otherwise surfaces as a server field error on save.

Both halves live outside the framework's own source: the server descriptor is auto-discovered from a project directory, and the widget registers itself from an ordinary Nuxt plugin. Neither requires touching a built-in field type or forking anything — a new type is additive.

Drop a file in `server/field-types/` that default-exports `defineFieldType`. It is auto-discovered and registered before any table is built. `constrain` (column nullable/unique/default) and `opt` (Zod optionality) are the helpers the built-in types use — reach for them instead of hand-rolling nullability, or the flags every field accepts stop working for your type. All three are package exports of `@kestrel/fields`, not auto-imported, so import them explicitly:

```ts
// server/field-types/color.ts
import { defineFieldType, constrain, opt } from '@kestrel/fields'
import { text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

export default defineFieldType({
  name: 'color',
  column: (n, f) => constrain(text(n), f),                       // TEXT column, honouring required/unique/default
  validator: (f) => opt(z.string().regex(/^#[0-9a-f]{6}$/i), f), // hex string, required-aware
})
```

`column` and `validator` are required; `transform` is optional and runs after validation, before insert/update, wherever the field sits — top-level, block props, repeater entries, and nested repeaters. In a nested scope the `record` argument a transform receives is the surrounding scope (the block's props, or the repeater entry), not the whole record. Registering a name that already exists warns and then overrides; a malformed descriptor (`column`/`validator` not functions) throws instead, at registration — see [../internals/extension-points.md](../internals/extension-points.md) for the full registration contract.

Field types are process-wide, not per-collection: registering `color` once makes it available to every collection and block in the site, the same as `text` or `number`.

A field using your type may carry a free-form `options` object, forwarded to both halves: `column` and `validator` read it as `f.options`, and the widget receives it as `field.options`. It's the only way a custom type is configurable per field. `options` must be plain JSON — `serializeField` drops it from the wire (silently) if it carries anything not JSON-safe, such as a function, `Date`, or `Map`, and the widget never sees it.

## Register the editor widget

Register a widget from a client plugin. The widget honours the shared field props (`field`, `name`, `locale`, `error`, `disabled`, `id`) plus a `v-model`; `KestrelUiField` is the label/error wrapper.

```vue
<!-- app/components/field/Color.vue -->
<script setup lang="ts">
defineProps<{ field: unknown; name: string; locale: string; error?: string | null; disabled?: boolean; id?: string }>()
const model = defineModel<string | null>()
</script>
<template>
  <KestrelUiField :id="id" :label="name" :error="error">
    <template #default="f">
      <input type="color" :value="model ?? '#000000'" :disabled="disabled"
        @input="model = ($event.target as HTMLInputElement).value" v-bind="f" />
    </template>
  </KestrelUiField>
</template>
```

The default slot hands the control `id`/`aria-invalid`/`aria-describedby`/`required` — bind them with `v-bind="f"` the way every built-in widget does, or the label and error text render with nothing pointing at the input.

```ts
// app/plugins/field-types.client.ts
import Color from '~/components/field/Color.vue'
export default defineNuxtPlugin(() => {
  registerFieldComponent('color', Color) // the editor resolves the widget by type name
})
```

An unregistered type renders a clear "unsupported field" placeholder rather than crashing.

### Nested use

The widget, the validator, and `transform` resolve by type name wherever the field sits — a top-level collection field, a block's props, or a repeater entry. The DB column only applies to a top-level field: block props and repeater entries have no column of their own, since their values live inside the parent's JSON.

## Non-scalar backings

A type stored as an **array or object** (e.g. a json column) should register a blank value so a new record or block seeds the right shape, with `registerFieldEmpty` (auto-imported, same client plugin):

```ts
registerFieldEmpty('mytype', () => [])
```

Its widget should also tolerate a `null` value the way built-ins do (`Array.isArray(v) ? v : []`). Scalar types backed by text/number/boolean (like `color` above) need nothing extra — without a registered empty value, a new record seeds the field with `null`, unless the field declares its own `default`, which wins over both paths.

```ts
registerFieldEmpty('gallery', () => ({ items: [] }))
```

The empty-value function takes no arguments and returns whatever shape the widget and `validator` expect — an array, an object, or anything JSON-serializable.

## Per-instance override

Every built-in reference-bearing type (`media`, `link`, `relation`, `richtext`) already populates on read — resolving ids into usable data before the record reaches the render or the editor preview. Most fields need nothing beyond that default. A field's definition may carry an inline `populate` function that runs instead of the type's default populator for that one field — for example a relation that should project only a couple of columns on read. It is server-only: a function, so it is never serialized to the admin. It replaces the type populator wholesale, so an override that expands a reference owns the `ctx.publicOnly` check too — the type populator would otherwise have applied that read-scoping itself. (`publicOnly` reaches the override at runtime but is absent from the inline `populate` type on `FieldDef` — widen it locally or cast if it doesn't type-check yet.)

Nothing server-side is auto-imported — import `defineCollection` and `getFieldPopulator` from `@kestrel/core` explicitly, the same as `defineFieldType` from `@kestrel/fields` above.

```ts
import { defineCollection } from '@kestrel/core'

defineCollection({
  name: 'posts', mode: 'multi', translatable: false,
  fields: {
    author: {
      type: 'relation', relation: { collection: 'authors' },
      populate: (bag, key, field, ctx) => { bag['$' + key] = /* custom projection */ },
    },
  },
})
```

`bag` is the value slice being populated (the record's own fields at top level, or a block's props / a repeater entry when nested). Writing the resolved value to `bag['$' + key]` is the convention the `media` and `relation` populators use; the other option is to overwrite `bag[key]` in place, the way the `link` and `richtext` populators do.

**To narrow a relation, delegate first — do not re-read the table.** Run the registered populator, then trim what it attached:

```ts
import { getFieldPopulator } from '@kestrel/core'

populate: (bag, key, field, ctx, keyMode) => {
  getFieldPopulator('relation')?.(bag, key, field, ctx, keyMode)
  const rel = bag['$' + key] as { id: number; name: string } | null
  if (rel) bag['$' + key] = { id: rel.id, name: rel.name }
},
```

`keyMode` is the one argument to pass through rather than invent: a single relation or media field is keyed `${name}Id` in top-level columns but bare `name` inside block props or a repeater entry, and the registered populator needs the caller's `keyMode` to read the right key.

Narrow *after* delegating, not instead of it: an override that fetches the record itself rather than calling the registered populator first drops it out of the publisher's dependency index, so the page silently stops re-publishing when the related record changes. See [../internals/populate.md](../internals/populate.md) for the population mechanism in full — the registries, the field-tree walker, and how the dependency index is built from what a populator touches.

This pattern is also how a private column is kept out of the static bake — the renderer populates in full, so shaping the payload here is what keeps the column out, not an access check. A depth-0 read of the collection itself still returns the column to anyone the access layer admits.

## Custom editor bodies

The editor's frame (header, save, unsaved-guard, locale bar, preview) is generic; the body between them is pluggable per collection. A collection picks its body with the `editor` option:

```ts
export default defineCollection({ name: 'flows', mode: 'multi', editor: 'node-graph', fields: { /* … */ } })
```

`editor` defaults to `'blocks'` when `blocks.enabled`, else `'fields'` (both built-in). Register your own body from a client plugin. A body takes no props — `CollectionEditor` renders it as `<component :is="bodyComponent" />` — and instead injects the editor form context via `useEditorFormContext()`, which throws if used outside `CollectionEditor`. The handful of members a body actually needs: `values` and `errors` (reactive), `setField` (route every mutation through it, for dirty tracking, undo history, and block-error reconciliation), `locale`, `saving`, and `registerRevealError` (called by the shell on a failed save):

```vue
<!-- app/components/editor/NodeGraphBody.vue -->
<script setup lang="ts">
const { values, errors, setField, locale, saving, registerRevealError } = useEditorFormContext()
</script>
```

```ts
// app/plugins/editors.client.ts
import NodeGraphBody from '~/components/editor/NodeGraphBody.vue'
export default defineNuxtPlugin(() => {
  registerCollectionEditor('node-graph', NodeGraphBody)
})
```

An `editor` type with no registered body renders a clear "no editor is registered" placeholder (localized) rather than a blank pane. This is the same mechanism a gallery extension or a node-graph extension uses to swap out the whole editing surface for a collection, without touching the generic frame around it.

## See also

- [./field-types.md](./field-types.md) — the built-in field types and the flags every type accepts.
- [./collections.md](./collections.md) — `defineCollection` and the `editor` option in context.
- [../internals/populate.md](../internals/populate.md) — the population mechanism: registries, the field-tree walker, and relation semantics.
- [./blocks.md](./blocks.md) — fields inside block props, where custom field types and per-instance `populate` also apply.
