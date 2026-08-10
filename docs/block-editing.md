# Block-content editing

Page-like collections (`blocks: { enabled: true }`, e.g. `pages`) store their body as an ordered
list of **blocks** in the `content` column. The admin record editor edits that list with a
structured, schema-driven editor — not a freeform visual canvas (the block model has no geometry).

## Block model

A block is `{ id, type, props, slots? }`. Each block **type** is authored as a **single Vue SFC** in
`app/blocks/<Name>.vue` — the SFC is BOTH the schema source AND the display component (Pruvious-style):

- **Schema** = its `defineProps({ heading: textField({ required: true }), image: mediaField(), … })`
  using the auto-imported **field factories** (`textField`/`mediaField`/`relationField`/`repeaterField`/…,
  `layers/fields/app/utils/field-factories.ts`). Each factory returns a Vue prop descriptor that also
  carries a Kestrel `FieldDef` — the *same* field definitions collections use.
- **Metadata** = `defineBlock({ label?, slots?, icon? })` (auto-imported no-op at runtime; read at build).
- **Name** = the filename (`Hero.vue` → `hero`; `BoxedContainer.vue` → `boxedContainer`).

A build-time extractor (`layers/core/modules/auto-discovery/extract-block.ts`) statically evaluates those
two macro arguments and lifts the schema into the `#kestrel/blocks` registry; the auto-discovery module
registers `app/blocks/` as the global `Blocks<Name>` components. **No block types ship in the package** —
the scaffolder emits one starter `Prose.vue` to build from, and the `hero` (heading, image, cta) / `prose`
(body) pair in this repo is demo content.

The server validates `content` as a discriminated union on `type`, validating each block's `props`
against that type's field schema (with depth/size guards). This runs on create and update.

## The editor

For block-enabled collections the editor is a **3-pane, Pruvious-style layout** (`CollectionEditor`):
**hierarchy tree · live preview · contextual fields**. Flat (non-block) collections keep the plain
single-column field form.

- **`GET /api/blocks`** exposes each block type's field schema (as `SerializedField`, identical to
  collection fields), optionally filtered by `?allowed=a,b`. Admin-only (default-deny).
- **`BlockTree`** (left) is the hierarchy only — a selectable **“Page” root** plus a node per block
  (label · error badge, with move / duplicate / remove revealed on hover or selection), recursing into
  each declared slot. A block's **type is fixed at creation** (not switchable in-row); the *add* control
  — a **“+ Add block”** button that opens a **centered modal type picker** (tiled block types with
  preview images) — sits at the root and inside each slot, restricted to the collection's `blocks.allowed`.
- **`BlockFields`** (right) is **contextual**: with the page root selected it shows the collection's
  own fields (`PageFields`); with a block selected it shows that block's fields through the shared
  `FieldRenderer`. Edits are id-addressed (`setProp(id, …)`), so a block at any depth is editable from
  this one pane.
- **`BlockPreview`** (centre) is the live preview (below) — and is **selection-aware**: clicking a
  block selects it, the selected block is highlighted, and a tree/preview selection scrolls it into view.
- **State:** `useBlockTree(content, byName)` holds the nested tree + a single shared **selection**
  (the stable `block.id`, or `null` for the page root). All mutations are **id-addressed, immutable**
  tree ops (`utils/block-tree.ts`: find / update / move / remove / duplicate / add at any depth) — the
  positional indices the old recursive list buried are gone. `add`/`duplicate` select the new block;
  `remove` retargets to a sibling/parent; removing an *ancestor* of the selection heals it
  against the new tree.
- **`content` round-trips through `useEditForm`** like any field (load, dirty-tracking, submit), even
  though it is a synthesized column: a writable `content` computed routes every tree mutation through
  `setField('content', …)`, so block-error reconciliation still runs on each change.

### Validation

Block field errors from a `400` are keyed by the block's stable `id` (`BlockErrorMap`) and surfaced in
the **fields pane** of the offending block, with a form-level banner as a summary; a failed save
**auto-selects the first invalid block** so its fields are in view. In the tree, any block that has an
error — or an ancestor of one (roll-up via `errorBearingIds`) — shows an **error badge**. The server
reports a block by its *position* (`content[i].props.x`); the editor resolves that to the block's stable
`id` so an error **stays on its block across a reorder** rather than sticking to a slot index. Editing a
block clears its stale errors; a removed block drops them; a pure reorder keeps them. This holds **at any
depth**: a `content[i].slots.<name>[j]…props.<field>` path resolves to the nested block's id, so a
slot-nested error survives a reorder of its slot or an ancestor and clears on that block's own edit or removal.

### Block type

A block's type is **chosen once, when it is added** (via the “+ Add block” type picker), and is **fixed
thereafter** — there is no in-row type switch. To use a different type, remove the block and add the
intended one. This keeps a block's `props` always valid against its own type's schema.

## Adding a block type

1. Create `app/blocks/<Name>.vue` — one file with the schema (`defineProps({ … field factories … })`),
   metadata (`defineBlock({ label?, slots?, icon? })`), and the display `<template>`. That's it: the SFC
   is both extracted into the block registry AND registered as the global `Blocks<Name>` component.
2. Allow it on a collection via `blocks: { enabled: true, allowed: ['<name>', …] }` (omit `allowed` to permit all).

The editor needs no changes — it is fully schema-driven off `GET /api/blocks` — and a new block type
renders in the **live preview** automatically.

**Authoring constraints** (the extractor evaluates the macro arguments statically, as plain JS):

- Use the runtime **`defineProps({ … })`** form, not `defineProps<T>()` — the type-only form carries no
  runtime schema.
- Field arguments must be **self-contained literals + factory calls** — no imported constants, computed
  values, or TS type-args inside a factory call (they'd fail the build with a clear error).
- A **display-only prop** (e.g. `media: Object`, the server-resolved `$media` bag BlockRenderer passes in)
  is a plain Vue prop — it is skipped by the extractor and is not part of the schema. Keep TS casts in
  computeds, out of the `defineProps` argument.
- Field **defaults must be JSON-serializable** (the registry is inlined as JSON) — a function `default`
  is rejected with a build error.
- A **custom field type** (registered via `defineFieldType`) has no dedicated factory — use the generic
  `field('<type>', { … })` escape hatch, e.g. `gallery: field('secureGallery')`.

> **Known limitation (dev HMR):** editing a block's `defineProps` **schema** (or adding a new
> `app/blocks/*.vue`) is picked up on the next dev-server start — the display template hot-reloads, but the
> extracted schema virtual does not yet invalidate on watch. Restart `dev` after a schema change.

## Live preview

The editor's centre pane is an **iframe onto the real public page**, kept **keystroke-live** over a
same-origin `postMessage` bridge. Because the preview document IS the public app, it renders with the
consumer's real CSS/fonts/`rem` base and honours real media-query breakpoints — the **viewport toolbar**
(below) sits above the frame. Drafts render in the frame through the admin session (same-origin iframe →
cookie flows; the draft badge is suppressed in preview mode).

### Viewport toolbar

The frame renders at a **real target resolution** and is decoupled from the (narrow, panel-crowded) pane
width, so a desktop layout is shown faithfully rather than clipped. Above the frame:

- **Device presets** (quick-select) — Desktop / Tablet / Mobile, each seeding a reference resolution
  (Desktop `preview.desktopWidth`×900 · Tablet 768×1024 · Mobile 390×844), shown in the button tooltip.
- **Scale-to-fit** toggle (`scan` icon, on by default) — CSS-`scale()`s the frame so its width fills the
  available pane; the live **% badge** shows the factor. It only shrinks (caps at 1×), so a mobile/tablet
  narrower than the pane stays crisp at 1:1. The iframe keeps its true target px (the page fires its real
  breakpoints); the transform is purely visual, so the postMessage bridge and click-to-select are
  unaffected.
- **Custom `W × H` inputs** (px) — test any specific resolution; the presets simply quick-fill these.
  Committed on change (blur/Enter), clamped to sane bounds.

The choice (device/W×H/fit) persists per user via the `kestrel-preview-viewport` cookie
(`usePreviewViewport`). Geometry helpers are the pure, node-tested `utils/preview-viewport.ts`; the
Desktop reference width is config-driven — `kestrel.config.ts` → `preview: { desktopWidth: 1440 }` (or
`KESTREL_PREVIEW_DESKTOP_WIDTH`), surfaced to the client via `runtimeConfig.public.previewDesktopWidth`.

- **Frame URL:** a saved pageLike record previews at its **real URL** + `?kestrel-preview=1`
  (server-populated first paint, then live swaps). Records **without** a public URL — new/unsaved, a
  blank slug, a blocks-enabled non-pageLike collection — fall back to the dedicated
  **`/__kestrel/preview`** page (same layout/CSS, admin-gated server-side via `/api/auth/session`,
  `noindex`, never linked or published; explicitly excluded from prerendering via
  `nitro.prerender.ignore` — the classic `nuxt generate` auto-seeds static page paths and would
  otherwise 404 on it). URL building is the pure `previewSrc` (`preview-protocol.ts`).
- **Protocol** (`layers/public/app/utils/preview-protocol.ts`, pure + unit-tested): editor → frame
  `preview:content` (the populated live tree + selection) and `preview:selected`; frame → editor
  `preview:ready` (handshake, re-fired on every load/reload → full state resend) and `preview:select`
  (block click). Every message carries a `kestrel` discriminant; **both sides verify `event.origin`
  and `event.source`**, so foreign pages/frames can never inject or read preview traffic.
- **Latency:** content pushes are coalesced to **one message per animation frame**
  (`createPreviewSender`, admin `utils/preview-channel.ts`) — a typing burst arrives as the latest
  tree, ≤ one frame behind; there is no debounce. Selection posts immediately.
- **In the frame** (`KestrelPreviewBridge`, public layer, **lazy-loaded** only in preview mode): swaps
  the received tree into `BlockRenderer` via a scoped slot, `provide`s the edit context
  (`block-edit-context.ts`) so the renderer emits clickable/highlightable markers, scrolls an
  externally-selected block into view, and **swallows link navigation** (capture-phase
  `preventDefault`) so the preview canvas never navigates away. The catch-all activates the bridge
  only for `?kestrel-preview=1` **plus an authenticated admin** (checked during SSR so hydration
  agrees); anonymous visitors with the flag get the plain page, and the normal render path — and the
  SSG output — are untouched.
  Caveat (unchanged): the marker is a real box, so layout-sensitive block CSS (`>` combinators /
  flex-item props on a block root) can render slightly differently than on the published site.
  The marker chrome is **themeable from the consumer's CSS** — it uses concrete fallback colors (the
  frame has no admin design tokens) overridable via `--kestrel-preview-hover` (hover outline),
  `--kestrel-preview-accent` (selected outline) and `--kestrel-preview-halo` (selected halo, keeps the
  selection visible on dark sites).
- **Media/link shim:** the editor still resolves media ids + internal links client-side
  (`useMediaResolver` / `useLinkResolver` → the pure `populateBlocks*` in admin
  `utils/populate-blocks.ts`) — the tree is **populated before it is posted**, so the frame renders
  `$media`/`href` exactly like the SSG path. The shim walks slots **and repeater entries** (mirroring the
  server field-tree populator), so media/links nested in a repeater preview too; the media cache is per
  content locale.

## Slots (nested blocks)

A block type declares named `slots` in its SFC's `defineBlock({ slots: ['default'] })`; the stored block
then carries `slots: Record<string, Block[]>` of child blocks. They are validated recursively (depth/size
guarded) and the server media populator walks them, so nested-block media resolves like top-level.

**Public rendering:** `BlockRenderer` renders each declared slot by recursing through itself into the
block SFC's matching outlet — the `default` slot for `'default'`, `<slot name="…">` otherwise. A block
`app/blocks/<Name>.vue` opts in by adding a `<slot />` outlet (e.g. `Hero.vue` renders its `default`
slot after the heading/image). Block types with no outlet simply ignore any slot children. The live
preview inherits this for free since it reuses the same renderer.

**Editing:** `BlockTree` is recursive — a slot-declaring block renders a nested `BlockTree` per slot,
restricted to the same `allowed` set (the server validates slot children against the collection's
allowed block union), with the full add / move / duplicate / remove set at every depth (a block's
**type is fixed at creation** — there is no in-place type change). All of these are **id-addressed**
ops on the single shared tree (`utils/block-tree.ts`): they walk the whole tree by id and rebuild the
path immutably — adding into a slot, removing, or moving a nested block needs no per-level component
state. Duplicating deep-clones the slot subtree with fresh ids. Selecting any block — top-level or
nested — shows its fields in the right pane. Slot
media resolves in the preview because `populateBlocksMedia`/`collectMediaIds` walk slots too; errors
roll up to ancestor tree badges at any depth (see *Validation*).

## Multilingual

Block content is edited **per content locale** via the editor's **`LocaleBar`** (translatable
collections): the active locale drives which variant's blocks load, and the preview's per-locale media
resolver follows it. See [multilingual.md](./multilingual.md) for the locale model and the editor flow.
