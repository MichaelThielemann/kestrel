# Admin editor internals

This page documents the client half of the admin editor: the block-tree state model, error resolution, the live-preview protocol, and the locale/list plumbing that `docs/guide/blocks.md` and `docs/guide/multilingual.md` only summarize.

## Design system

`layers/admin/` owns the client-only editor SPA — collection list, record editor, multilingual UI, auth chrome, theming — mounted under `/admin` with SSR off, so the admin renders client-side. It sits on the `ui` layer's schema-driven widgets: `app/utils/field-registry.ts` (the `FieldType → Component` seam plus `registerFieldComponent`) → `app/components/field/Renderer.vue` (`FieldRenderer`, the dispatcher) → `app/utils/field-component.ts` (`FieldComponentProps`, the prop contract every `Field*` widget honours) → `app/components/field/Text.vue` (a canonical widget) → `app/assets/scss/_tokens.scss` (design tokens). `_tokens.scss`'s `:root` colors also drive the public SSG site, so admin-only styling goes under `:root[data-theme]` instead of retuning the root palette.

Portaled overlays (Reka's combobox/datepicker content, teleported to `<body>`) need global, unscoped styles — a scoped `<style>` loses its `data-v` attribute once teleported. Adding a field type means a `Field*.vue` plus a registration; adding an icon means extending the `IconName` union and the `icons` map that backs `UiIcon` (lucide icons, no emoji or ASCII glyphs).

### Testing surface

happy-dom doesn't render teleported widgets, so Reka's combobox and datepicker content are smoke-tested only, with their load-bearing logic covered in pure utils instead. Richtext and `UiDialog` are deliberately **not** treated that way: `UiDialog` renders in place rather than teleporting, and while ProseMirror's editing surface resists happy-dom, the TipTap document behind it — schema, marks, `setLink`, the `getHTML` round-trip — is fully driveable through the exposed `editor` object, which is the only tier that can catch content being silently dropped.

Two TipTap gotchas the tests guard against:

- TipTap emits `update` for non-content changes too — `setEditable`/`setOptions` emit directly, bypassing the transaction pipeline's `docChanged` guard. `UiRichtext` gates every emit on the document having actually changed, because an unguarded echo would reach the edit form as a user edit and re-dirty a record that was just saved.
- TipTap's Link mark keeps its own scheme allowlist, independent of the sanitizer's: a scheme missing from `protocols` is rejected on parse (the anchor is unwrapped, its text kept) and makes `setLink` a silent no-op that still returns `true`. A custom scheme has to be allowed in both places.

The 3-pane editor layout itself — block tree, contextual fields, live preview, and the add-block picker — is a UX concern already covered in [../guide/blocks.md](../guide/blocks.md); this page starts at the state model and protocols underneath it.

## Block-tree state model

The 3-pane block editor (`CollectionEditor.vue`: hierarchy tree · live preview · contextual fields) exposes each block type's field schema via `GET /api/blocks` (`SerializedField`, the same shape collection fields use, admin-only, optionally filtered by `?allowed=a,b`), so the editor needs no per-type code — a new block type just shows up.

```bash
GET /api/blocks?allowed=hero,richtext
# { "data": [{ "name": "hero", "fields": [{ "name": "heading", "type": "text", ... }] }, ...] }
```

Tree state is driven by `useBlockTree(model, schemas, genId = crypto.randomUUID, setContent?)` (`layers/admin/app/composables/useBlockTree.ts`), which holds the nested block tree plus a single shared **selection** — the stable `block.id`, or `null` for the page root. `schemas` is the map `GET /api/blocks` resolves into, keyed by block type name, so tree operations can look up a block's own field schema without a second round trip per node. `BlocksBody.vue` supplies the fourth argument — `useBlockTree(content, byName, undefined, (v, coalesceAs) => setField('content', v, coalesceAs))` — so every structural op routes through that callback into `setField`, tagged with a per-op undo coalesce key; the writable `content` computed described below is only the fallback path taken when `setContent` is omitted.

All mutations are **id-addressed, immutable** tree operations in `layers/admin/app/utils/block-tree.ts`: `findInTree`, `updatePropById` (sets a single prop key, not a whole block), `removeById`, `removalRetarget` (computes the post-removal selection against the pre-removal tree), `moveById`, `duplicateById`, and `addBlock`, each rebuilding the path to a target id at any depth rather than indexing into a positional list. `BlockTree` itself recurses: a slot-declaring block renders a nested `BlockTree` per slot, restricted to the same `allowed` set the server validates slot children against, with the full add/move/duplicate/remove set available at every depth — a slot child is edited through the same id-addressed ops as a top-level block.

```ts
// layers/admin/app/utils/block-tree.ts
export function errorBearingIds(blocks: BlockRow[], directIds: Set<string>): Set<string>

// layers/admin/app/components/BlocksBody.vue
const errorIds = computed(() => errorBearingIds(tree.blocks.value, new Set(Object.keys(blockErrors.value))))
```

Mutation side effects on selection:

- `add` / `duplicate` select the newly created block; duplicating a slot-bearing block deep-clones the whole slot subtree with fresh ids.
- `remove` retargets the selection to a sibling or the parent.
- removing an **ancestor** of the current selection heals the selection against the new tree instead of leaving it dangling.

A block's type is chosen once, through the root/slot "+ Add block" modal picker, and is fixed thereafter — there is no in-row type switch, so a block's `props` stay valid against its own type's schema without a migration step. The Add-block picker is deliberately not teleported, so it stays reachable by the same tests that can't drive Reka's portaled overlays.

`content` round-trips through `useEditForm` (`layers/admin/app/composables/useEditForm.ts`) like any other field — load, dirty-tracking, submit — even though it is a synthesized column: `BlocksBody.vue`'s `setContent` callback routes every tree mutation through `setField('content', …)`, so block-error reconciliation runs on each change; `useBlockTree` falls back to a plain writable `content` computed only when no `setContent` is supplied. A watcher on the underlying model carries an echo-guard, so a programmatic write to `content` (e.g. resolving media for preview) doesn't get mistaken for a user edit and re-dirty a just-saved record.

### Undo/redo

`useEditForm` keeps a snapshot history over the *whole* form state, not just `content`: every `setField` call pushes a snapshot unless it coalesces into the previous one — same field, within a `COALESCE_MS` (600ms) window — so a typing burst collapses to one undo step. A structural block-tree op tags its own coalesce key via `setContent`'s `coalesceAs` argument, so a delete landing inside another field's coalesce window still gets its own undo step instead of merging into it. Both stacks reset on load and on save (no undo across a save). `undo`/`redo` are exposed through `editor-form-context.ts` and bound in `BlocksBody.vue` to Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (or Ctrl+Y) — skipped while an input, textarea, or contenteditable has focus, so a text field's own native undo keeps working.

### Field wire keys

`jsKey(name, field)` (`layers/admin/app/utils/field-keys.ts`) maps a field's declared name to the key the wire payload actually uses: a single `relation`/`media` field's name gets an `Id` suffix (`author` → `authorId`, `cover` → `coverId`), while every other field — including a multi relation/media field, or the same field inside a block's `props` — keeps its plain name. The editor uses this both when reading a loaded record into form state and when writing form state back into the payload it submits.

```ts
// layers/admin/app/utils/field-keys.ts
export function jsKey(name: string, field: SerializedField): string {
  return field.single ? `${name}Id` : name
}
```

`field.single` is a server-computed flag, not a client-side rule the editor re-derives — reading it instead of pattern-matching the field's declared type keeps the two sides from silently drifting if the wire convention ever changes for a field kind.

## Block error resolution

`BlockErrorMap` (`layers/admin/app/utils/edit-form.ts`) is a `Record<string, Record<string, string>>` keyed by a block's stable `id`, not by its position in `content`. The server reports a validation failure by position (`content[i].props.x`, or `content[i].slots.<name>[j]…props.<field>` at any nesting depth); `edit-form.ts` resolves that path to the block's `id` before it reaches the tree, so an error **stays on its block across a reorder** instead of sticking to a slot index.

Edit-form state (`layers/admin/app/composables/useEditForm.ts`) tracks `blockErrors: Ref<BlockErrorMap>`, kept in sync with tree mutations by `reconcileBlockErrors` (`layers/admin/app/utils/edit-form.ts`) — the behaviour (edit clears, remove drops, reorder keeps) is covered from a usage perspective in [../guide/blocks.md](../guide/blocks.md).

`errorBearingIds` (`layers/admin/app/utils/block-tree.ts`) rolls a set of directly-erroring block ids up through their ancestors, so a nested error also lights up the error badge on every containing block in the tree — `BlocksBody.vue` feeds it both live validation errors and dead-reference ids through the same roll-up. The auto-select-first-invalid-block behaviour on a failed save is a `ctx.registerRevealError` callback (`editor-form-context.ts`) that the shell invokes: `BlocksBody.vue` selects the first block id in `blockErrors`, or — when none remain — deselects back to the page root so the fields pane remounts there instead of showing a stale block.

`layers/admin/app/utils/dead-refs.ts` shapes the per-record dead-reference payload (a relation/media id that no longer resolves, or resolves to something unpublished) into the same two lookups the block-error path uses: `deadBlockIds` for the tree roll-up, `deadFieldsAt(refs, blockId)` for which field keys are stale at a given location — `blockId: null` means the record/page root rather than a block. It's a pure, Vue-free module by the same design as the rest of the block-tree utilities: happy-dom can't render the teleported field widgets that would otherwise be needed to exercise this logic.

### Selection-aware preview

`BlockPreview`, the centre pane, is selection-aware in both directions: clicking a block in the frame selects it in the tree and fields pane, the selected block is highlighted in the frame, and selecting a block from the tree or the fields pane scrolls the frame to it. This is layered on top of the protocol below, not a separate channel — the frame's `preview:select` and the editor's own selection change both post immediately and uncoalesced (see below); the next coalesced `preview:content` also carries `selectedId`, but only as an authoritative backstop, not the primary path.

## Live-preview protocol

The editor's centre pane is an iframe onto the real public page, kept live over a same-origin `postMessage` bridge — the pure protocol lives in `layers/public/app/utils/preview-protocol.ts`.

Message names:

- editor → frame: `preview:content` (the populated live block tree plus selection), `preview:selected`.
- frame → editor: `preview:ready` (handshake, re-fired on every load/reload, which triggers a full state resend), `preview:select` (block click).

Every message carries a `kestrel: 'preview:*'` discriminant, and parsing is direction-specific: `parseEditorMessage` only recognizes the two editor→frame types, `parseFrameMessage` only the two frame→editor types, so a reflected/echoed message (the frame's own send looping back, say) parses to `null` on both sides rather than being acted on twice. Shape-checking alone isn't trust, though — **both sides additionally verify `event.origin` and `event.source`** before acting on a message:

```ts
// layers/admin/app/utils/preview-channel.ts
export function acceptsFrameEvent(event: MessageEvent, frameWindow: Window | null, origin: string): boolean {
  return frameWindow !== null && event.origin === origin && event.source === frameWindow
}
```

so a foreign page that embeds the site, or is embedded by it, can never inject into or read preview traffic — same-origin `postMessage` alone doesn't guarantee the *sender* is the expected window, only that its data isn't forged from a different origin.

Content pushes are coalesced to one message per animation frame (`createPreviewSender`, `layers/admin/app/utils/preview-channel.ts`) — a typing burst arrives as the latest tree, at most one frame behind, with no debounce delay. Selection posts immediately, uncoalesced. Before posting, the sender round-trips the tree through `JSON.parse(JSON.stringify(...))`: Vue's reactive proxies don't survive `structuredClone`, and the round-trip also guarantees the payload matches the same JSON-safe shape the database round-trips — block trees are small, so one clone per frame stays well under a millisecond.

**In the frame:** `KestrelPreviewBridge` (`layers/public/app/components/KestrelPreviewBridge.vue`) swaps the received tree into `BlockRenderer` via a scoped slot, provides the edit context so the renderer emits clickable/highlightable markers, scrolls an externally-selected block into view, and swallows link navigation with a capture-phase `preventDefault` so the preview canvas never navigates away. It mounts at two sites: unconditionally on the dedicated fallback page (`__kestrel/preview.vue`, itself preview-only), and lazily (`<LazyKestrelPreviewBridge v-if="previewActive">`) on the catch-all `[...slug].vue`, so a normal page view never pays for the bridge's chunk.

The bridge activates only when a request carries `?kestrel-preview=1` **and** the visitor is an authenticated admin, checked during SSR so hydration agrees; an anonymous visitor with the flag gets the plain page. The normal render path, and the static-generated output, are untouched by any of this.

**Frame URL:** a saved page-like record previews at its real URL plus `?kestrel-preview=1`. A record with no public URL yet — new/unsaved, a blank slug, or a blocks-enabled collection that isn't page-like — falls back to `/__kestrel/preview`: same layout and CSS, admin-gated server-side via `GET /api/session`, `noindex`, never linked or published. The fallback URL also carries `&locale=` (`previewSrc`, `layers/public/app/utils/preview-protocol.ts`), which `__kestrel/preview.vue` reads to set `<html lang>` to the record's content locale, since the page has no record of its own to derive it from. `/__kestrel/preview` is excluded from prerendering via `nitro.prerender.ignore`, registered by `layers/public/modules/prerender-routes/index.ts` unconditionally, ahead of its `output.auto` early-return, so the exclusion holds for both publishing models — since `nuxt generate` would otherwise auto-seed and 404 on it.

**Ticket preview (separate tab):** opening the preview outside the editor frame — no parent window, so no bridge to listen to — instead carries `?kestrel-preview-token=…`, an admin-only, session-bound ticket resolved server-side via `GET /api/preview?token=`. The ticket is minted by `POST /api/createPreview` (`packages/kestrel-publishing/src/server/pipelines/preview.ts`, `mintTicket`): the editor posts its current, *unsaved* form values, which are stored session-bound under a token — nothing is written to the DB, so previewing never doubles as a save. The payload is capped at 2 MB and sanitized. `__kestrel/preview.vue` and the catch-all both read it back the same way, via the `preview` pipeline, which re-populates the ticket's raw ids through `populateRow` so media and internal links render as on a real page; an expired, foreign, or unknown token resolves to `null` and the page falls back to the bridge (or the saved record) as if no token were present, so a stale link degrades instead of erroring.

The read side is `previewPage` (`layers/public/app/utils/preview-protocol.ts`): a shallow, column-keyed override of the saved row by the ticket's unsaved values, with one deliberate exception — clearing a single relation/media field to `null` also deletes the populated sidecar sitting alongside its id (`$<name>` for a relation, `$media.<name>` for media), since `values` is never itself populated and a plain spread would leave a removed author/cover still rendering.

**Media/link shim:** the editor resolves media ids and internal links client-side before posting the tree, so the frame renders `$media`/`href` exactly as the static build would. `BlockPreview.vue` drives the pure `layers/admin/app/utils/populate-blocks.ts`: it gathers every id or link reference up front with `collectMediaIds`/`collectLinkRefs`, awaits `useMediaResolver`'s (`layers/media/app/composables/useMediaResolver.ts`) and `useLinkResolver`'s `ensure` to fetch them in one batch, then passes their `resolve` functions into `populateBlocksMedia`/`populateBlocksLinks`, which write the resolved values back into the tree. That resolve round is awaited before the ready-handshake push, so the frame's first paint isn't stripped of images/hrefs while the caches are still warming. The shim walks slots and repeater entries, mirroring the server's field-tree populator, so media and links nested inside a repeater preview correctly too; the media cache is keyed per content locale.

### Viewport toolbar

The device presets, the automatic two-axis scale-to-fit, the persisted `W × H` inputs, and the `kestrel-preview-viewport` cookie are consumer-facing preview UX, covered in [../guide/blocks.md](../guide/blocks.md). Internally, the geometry is a pure, Vue-free module — `PRESETS`, `fitScale`, `matchPreset`, `resolveDim` in `layers/admin/app/utils/preview-viewport.ts` — that `BlockPreview.vue` only wires refs to; the cookie itself is read/written by `usePreviewViewport` (`layers/admin/app/composables/usePreviewViewport.ts`). The desktop preset's reference width is config-driven — `kestrel.config.ts` → `preview: { desktopWidth: 1440 }` (or `KESTREL_PREVIEW_DESKTOP_WIDTH`) — surfaced to the client as `runtimeConfig.public.previewDesktopWidth`.

## Admin locale and list plumbing

For a translatable collection, the collection editor shows a **`LocaleBar`**; its states, icons and locale-switching UX are covered from a usage perspective in [../guide/multilingual.md](../guide/multilingual.md) § "Editor — the LocaleBar". Internally, the active locale drives which record variant's fields and blocks load, and the preview's media resolver follows the same locale.

The collection list filters to the browsing locale (`?locale`, default primary) and adds a small locale switcher; *New* carries the locale so a new record opens in it — see the same guide section for the list-locale UX.

Each list row's translation sidecar — locale → sibling row id, or `null` when that locale is missing — is computed once per page by `attachTranslationStatus` (`packages/kestrel-core/src/server/pipeline/steps/read-attach-meta.ts`), not per row, and attached inline as `$translations`; `CollectionListTable.vue` reads `row.$translations` directly rather than fetching it per row:

```bash
# GET /api/pages (list) — one row's sidecar
{ "id": 5, "$translations": { "en": 5, "de": null }, ... }
```

It drives a per-record translation badge ("EN ✓ · DE —"): present locales link to their sibling, missing ones offer create-and-link, carrying the translation group along. The sibling lookup honours `publishedOnly`, so a published-scope read never reveals a draft translation.

The editor's own LocaleBar (above) instead looks a single record up on demand via `GET /api/<collection>/translations/<id>` (`resolveTranslationsStep`, `packages/kestrel-core/src/server/pipeline/steps/read-tooling.ts`), also reachable as `?group=<translationGroup>` for a record that doesn't exist yet — the entry point the LocaleBar's "+" flow uses:

```bash
GET /api/pages/translations/<id>
# { "en": 5, "de": null }
```

The admin **chrome** language (en/de) is independent of content locale: a cookie-backed, SSR-safe preference set from the account menu, translating the dashboard itself rather than the content being edited.

## Design-system composables

Beyond the field widgets, the `ui` layer exposes the shared composables the admin app builds on: `useT` (admin i18n, distinct from the content-locale machinery above), `useToast`, and `useRepeater` (the repeater field's add/move/remove state, the same id-addressed shape as the block tree but scoped to one field). Generic primitives (`components/ui/*` → `Ui*`) and the inline-SVG icon registry live alongside them, so a new admin surface composes from the same building blocks as the field widgets rather than reaching for ad hoc markup.

`useEchoGuard` is the one composable worth calling out by name: it's the same primitive behind both the block-tree content watcher's echo guard (above) and `useRepeater`'s own model watcher, so "a programmatic write shouldn't re-dirty the form" is one tested piece of logic, not two hand-rolled ones that could drift apart.

## Failure handling

`catch` blocks across the editor (`useAuth.ts`, `useListBatchActions.ts`, `useEditForm.ts`, `CollectionEditor.vue`, `BlockPreview.vue`, among others) are fail-soft by design, but each one carries an explicit recovery, not a swallow: `useAuth.ts`'s `checkSession` resets local state to unauthenticated on a transient `/api/session` failure so the route guard redirects instead of throwing; `useEditForm.ts` falls back supplementary lookups (translations, dead references) to an empty map/array so a failed side lookup never blocks editing the record itself; `CollectionEditor.vue`'s locale-copy handler sets a user-visible `f.formError` on failure; `BlockPreview.vue`'s `onFrameLoad`/`refresh` read `contentWindow.location` to detect a frame that navigated away, and fall back to `el.src = frameSrc.value` when that read throws (which it does whenever the frame has gone cross-origin) — the catch body IS the recovery, not an empty stub.

`useListBatchActions.ts`'s delete-preview lookup is the sharpest case: on failure it does not report zero references as if the check had succeeded — that would look identical to a verified-safe delete — it instead sets `checked: false` so the confirmation dialog tells the user the referrer check couldn't run. Read the surrounding code before adding logging or a rethrow to any of these; the recovery is usually the point.

None of this is a blanket "swallow and move on" convention — it's a per-callsite judgment about what the *caller* can still do when a supplementary lookup fails versus when the primary action itself must surface the failure. `useEditForm.ts`'s own `save` draws that line explicitly: its `catch (e)` calls `handleError(e)` and returns `{ ok: false }` rather than falling back to anything, because a failed save has nothing safe to degrade to. Only the side lookups that exist to enrich an otherwise-workable form — translations, dead references, the delete-referrer preview — degrade silently; the primary action always surfaces its failure.

## See also

- [../guide/blocks.md](../guide/blocks.md) — the block model, authoring a block type, and the consumer-facing preview CSS hooks.
- [../guide/multilingual.md](../guide/multilingual.md) — the locale model, translation groups, and the editor's LocaleBar from a usage perspective.
- [./layer-guide.md](./layer-guide.md) — the `ui` and `admin` layer entries in the full per-layer guide.
- [./architecture.md](./architecture.md) — cross-layer seams such as jsKey ↔ dbName and the component namespace.
- [./pipeline-engine.md](./pipeline-engine.md) — how `GET /api/blocks` and the read pipelines the list/translation sidecar rely on are structured.
