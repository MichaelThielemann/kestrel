# Blocks and the page builder

Blocks are the ordered, nested content a collection with `blocks: { enabled: true }` stores in its `content` column, authored as Vue single-file components and edited in a live-preview page builder.

## Block model

A collection with `blocks: { enabled: true }` (e.g. `pages`) stores its body as a list of blocks:
`{ id, type, props, slots? }`. Each block **type** is authored as a single Vue SFC in `app/blocks/<Name>.vue`
— the SFC is both the schema source and the display component:

- **Schema** = its `defineProps({ … })` using the auto-imported field factories (`textField`, `mediaField`,
  `relationField`, `repeaterField`, …). Each factory returns a Vue prop descriptor that carries the same
  `FieldDef` a collection field would.
- **Metadata** = `defineBlock({ label?, slots?, icon? })`, imported from `@kestrel/fields/client` — unlike
  the field factories, it is not auto-imported. `label` is either a string or a per-locale map
  (`{ en: 'Hero', de: 'Held' }`), resolved against the admin interface language, not the content locale. A
  preview picture for the block picker (e.g. `/block-previews/hero.png`) can be set via `image` in the same
  object literal — the build-time extractor reads it statically, though the typed client helper's signature
  doesn't currently declare it, so it only type-checks in a plain `.vue` block without `lang="ts"`.
- **Name** = the filename (`Hero.vue` → `hero`; `BoxedContainer.vue` → `boxedContainer`).
- A preview picture for the block picker (e.g. `/block-previews/hero.png`) can be set via `image` in the
  same `defineBlock({ … })` object literal — the build-time extractor reads it statically, but the typed
  client helper's signature doesn't currently declare it, so a `lang="ts"` SFC needs a type assertion
  (`as const` or a cast) to pass it without an excess-property error.

A build-time step lifts those two macro arguments into the generated block registry, and the block's
folder is registered as the global `Blocks<Name>` component. No block types ship in the package — the
scaffolder emits one starter `Prose.vue` to build from. Page-like is orthogonal to blocks: it only
additionally gives the record a public URL, which the live preview and the layout control (below) depend on.

The server validates `content` as a discriminated union on `type`, checking each block's `props` against
that type's field schema (with depth/size guards), on create and update.

## Adding a block type

```ts
// app/blocks/Hero.vue
<script setup lang="ts">
import { defineBlock } from '@kestrel/fields/client'

defineBlock({ label: 'Hero', slots: ['default'] })

defineProps({
  heading: textField({ required: true }),
  image: mediaField(),
  cta: linkField(),
})
</script>
```

1. Create `app/blocks/<Name>.vue` — schema, metadata, and the display `<template>` in one file.
2. Allow it on a collection via `blocks: { enabled: true, allowed: ['<name>', …] }` (omit `allowed` to
   permit all block types).

The editor needs no changes — it is schema-driven off `GET /api/blocks` (admin-only, default-deny) — and a
new block type renders in the live preview automatically.

Authoring constraints, because the schema is lifted statically as plain JS:

- Use the runtime `defineProps({ … })` form, not `defineProps<T>()` — the type-only form carries no runtime
  schema.
- Field arguments must be self-contained literals and factory calls — no imported constants, computed
  values, or TS type-args inside a factory call.
- A display-only prop is a plain Vue prop, skipped by the extractor — e.g. the server-resolved media bag:
  declare `media: Object` alongside the field props and read `props.media.<fieldName>` for a field's
  resolved image, matching `$media.<field>` on a record (see [field-types.md](./field-types.md)).
- Field defaults must be JSON-serializable — a function `default` is rejected at build time.
- A custom field type (`defineFieldType`) has no dedicated factory — use `field('<type>', { … })`, e.g.
  `gallery: field('secureGallery')`.

> **Dev HMR caveat:** editing a block's `defineProps` schema (or adding a new `app/blocks/*.vue`) is picked
> up on the next dev-server start — the display template hot-reloads, but the extracted schema does not yet
> invalidate on watch.

## The editor

For block-enabled collections the record editor is a 3-pane layout: **hierarchy tree · live preview ·
contextual fields**. Flat (non-block) collections keep the plain single-column field form.

- The **tree** (left) is the hierarchy only — a selectable "Page" root plus a node per block (label, error
  badge, move/duplicate/remove on hover or selection), recursing into each declared slot. A block's type is
  fixed at creation, not switchable in-row — to use a different type, remove the block and add the intended
  one; **"+ Add block"** opens a centered modal type picker, tiled with each type's `image`/label, restricted
  to the collection's `blocks.allowed`.
- The **fields pane** (right) is contextual: the page root selected shows the collection's own fields; a
  block selected shows that block's fields through the shared field renderer. Edits are id-addressed, so a
  block at any depth is editable from this one pane.
- The **preview** (centre) is selection-aware — clicking a block selects it, and a tree/preview selection
  scrolls it into view.

A failed save reports block errors by position (`content[i].props.x`, or nested inside a slot); the editor
resolves each to the offending block's stable id before it reaches the tree, and surfaces it in the fields
pane of that block, with a form-level banner as a summary — a failed save auto-selects the first invalid
block. In the tree, a block with an error — or an ancestor of one — shows an error badge. Editing a block
clears its stale errors; a removed block drops them; a pure reorder keeps them, at any depth including
inside slots, because resolution is by id rather than by position.

Cmd/Ctrl+Z undoes the last block edit or structural change, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes it. The
history is per editing session and resets on load and save. While the cursor is in a text field, the
browser's own undo applies instead.

## Live preview

The centre pane is an iframe onto the real public page, kept keystroke-live over a same-origin `postMessage`
bridge. Because the preview document *is* the public app, it renders with the consumer's real CSS/fonts/
`rem` base and honours real media-query breakpoints. Drafts render through the admin session (same-origin
iframe → cookies), and the draft badge is suppressed in preview mode.

A saved page-like record previews at its real URL plus `?kestrel-preview=1` — the flag that puts the page
into live-preview mode for an authenticated admin, so the bridge below can drive it. Records without a
public URL (new/unsaved, a blank slug, a blocks-enabled non-page-like collection) fall back to a dedicated
`/__kestrel/preview` page — same layout/CSS, admin-gated, `noindex`, never linked or published. Preview
routes are never prerendered; see [../internals/admin-ui.md](../internals/admin-ui.md) for the gating and
prerender details.

The toolbar can also open the record in a full browser tab, unsaved changes included, via a session-bound
preview ticket (`?kestrel-preview-token=…`) — a different mechanism, carrying *unsaved* form values into a
standalone tab; see [publishing.md](./publishing.md) for that flow.

### Viewport toolbar

The frame renders at a real target resolution, decoupled from the (narrow, panel-crowded) pane width, so a
desktop layout is shown faithfully rather than clipped:

- **Device presets** — Desktop / Tablet / Mobile, each seeding a reference resolution: Desktop is
  `preview.desktopWidth` wide with an auto height that fills the pane vertically (only the iframe's own
  document scrolls), Tablet is 768×1024, Mobile is 390×844.
- **Scale** is always automatic, on both axes, capped at 1× so a mobile/tablet preview narrower than the
  pane stays crisp — the percentage shown is a read-only indicator, not a control. The iframe keeps its true
  target px (the page fires its real breakpoints); the transform is purely visual.
- **Custom `W × H` inputs** (px) — test any specific resolution; the presets quick-fill these. Committed on
  blur/Enter, clamped to sane bounds. Clearing either input switches that axis to Auto instead — it fills
  the pane, which is what the Desktop preset does for height.

The choice persists per user via a cookie. The Desktop reference width is config-driven:
`kestrel.config.ts` → `preview: { desktopWidth: 1440 }` (or `KESTREL_PREVIEW_DESKTOP_WIDTH`).

### Marker CSS

Inside the frame, the block renderer wraps each block in a clickable/highlightable marker so the preview
can show hover and selection state. The marker is `display: contents`, so it generates no box of its own —
the block root stays the parent's real flex/grid item exactly as on the published site, so preview layout
matches production. The marker chrome is themeable from the consumer's CSS with concrete fallback colors,
overridable via `--kestrel-preview-hover` (hover outline) and `--kestrel-preview-accent` (selected outline).

The editor also resolves media ids and internal links client-side before posting the tree to the frame, so
the preview renders `$media`/`href` exactly like the published site — including media and links nested
inside a repeater.

## Slots (nested blocks)

A block type declares named `slots` in `defineBlock({ slots: ['default'] })`; the stored block then carries
`slots: Record<string, Block[]>` of child blocks. They are validated recursively (depth/size guarded), and
the server media populator walks them, so nested-block media resolves like top-level.

On the public side, the block renderer renders each declared slot by recursing into the block SFC's
matching outlet — the default `<slot />` for `'default'`, `<slot name="…">` otherwise. A block opts in by
adding that outlet (e.g. `Hero.vue` renders its `default` slot after the heading/image); a block type with
no outlet simply ignores any slot children. The live preview reuses the same renderer, so this works for
free there too.

In the editor, a slot-declaring block renders a nested tree per slot, restricted to the same `allowed` set
the server validates slot children against, with the full add/move/duplicate/remove set at every depth (a
block's type is still fixed at creation). Duplicating deep-clones the slot subtree with fresh ids. Selecting
any block, top-level or nested, shows its fields in the right pane; errors roll up to ancestor tree badges
at any depth.

## Multilingual

Block content is edited per content locale via the editor's locale switcher: the active locale drives which
variant's blocks load, and the preview's per-locale media resolver follows it. See
[multilingual.md](./multilingual.md) for the locale model and the editor flow.

## Per-page layouts

Ship more than one layout in `app/layouts/` and an editor can pick which one renders a page — the
page-fields pane (the pane shown when the "Page" root is selected) grows a **Layout** control, listing the
layouts your project actually has. The control appears only on page-like collections. Nothing to register:
layouts are discovered from Nuxt's own layout resolution.

```
app/layouts/
  default.vue            ← every page unless it says otherwise
  landing.vue            ← offered in the editor as "landing"
  legal.vue              ← offered as "legal"
```

- A single-layout project sees no control — with only `default.vue` there is nothing to choose, so the
  select stays out of the pane. The `admin` layout is never offerable.
- Leaving it unset is the normal case and stores `NULL`, which renders `default`; the select shows that as
  one entry ("Standard (default)").
- Deleting a layout file does not break pages that referenced it — they fall back to `default` rather than
  blanking. Nothing warns you, though, so check your data for the name before deleting a layout file a page
  depends on.
- The choice is per row, not per translation group — each locale's page is set independently.
- Your layout can read the record it is rendering via `const { page, collection } = usePublicPageState().value`
  — `page` is the resolved record, `collection` its collection name; both are `null` outside a
  Kestrel-rendered page. The state holds during SSR and static generation.

## See also

- [field-types.md](./field-types.md) — the field factories used inside a block's `defineProps`.
- [publishing.md](./publishing.md) — the preview ticket behind "open in new tab", and how save/publish/preview differ.
- [multilingual.md](./multilingual.md) — how block content varies per locale.
- [publishing.md](./publishing.md) — the ticket-based full-tab preview.
- [../internals/admin-ui.md](../internals/admin-ui.md) — the block tree's id-addressed tree ops, the
  position→id error-resolution algorithm, and the live preview's postMessage protocol.
- [custom-field-types.md](./custom-field-types.md) — writing a `defineFieldType` for use in a block.
