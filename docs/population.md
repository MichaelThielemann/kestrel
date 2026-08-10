# Read-time population

When a record is read at `depth > 0`, Kestrel **populates** reference-bearing fields — resolving media ids
to URLs, internal links to localized hrefs, and relations to the related records — so the public render and
the editor preview get ready-to-use data instead of raw ids. This is Pruvious-style, per-field-type, and
recursive.

## The seam

`layers/core/server/utils/populate.ts` owns two registries:

- **`registerPopulator(fn)`** — whole-row populators, run in turn by `populateRow(row, ctx)`
  (`ctx = { depth, locale, def, publicOnly }`), bailing at `depth <= 0`. There is exactly **one** today: the
  field-tree walker.
- **`registerFieldPopulator(type, fn)`** — one **per-field-type** populator, keyed by type name (last-wins).
  A `FieldPopulator(bag, key, field, ctx, keyMode)` reads its value out of `bag` and mutates `bag` in place
  (attach `$media`, a `$<name>` relation sibling, resolve a link value). The owning layer registers its own,
  so no layer bakes another's read logic into a lower-layer field-type descriptor:

  | type | populator | layer |
  |---|---|---|
  | `media` | `buildMediaFieldPopulator` → `$media.<field>` | `media` |
  | `link` / `richtext` | `buildLinkFieldPopulators` → resolves hrefs in place (status-gated: a missing or draft target stays `#`) | `public` |
  | `relation` | `buildRelationFieldPopulator` → `$<field>` | `collections` |

## The walker

`layers/fields/server/utils/field-populate.ts` — `buildFieldTreePopulator()` is the single global populator.
It walks a record's top-level fields (COLUMNS key-mode) and, when blocks are enabled, its block tree (each
node's props in PROPS key-mode + every slot), and for each field dispatches to `field.populate` (a
per-instance override, below) or the registered per-type populator. It **recurses repeater entries** (PROPS
mode) at every level — so media / links / relations nested inside a repeater (top-level or in block props)
resolve, not just top-level fields. This generalises the recursion already proven in `extract-refs.ts`
(`bagRefs`).

**Key-mode** captures the storage asymmetry: a single relation/media is `${name}Id` in top-level columns but
bare `name` in block props / repeater entries; everything else is bare-keyed in both.

Population is **non-destructive**: the walker clones the row, block nodes/props, and repeater entries; raw id
columns are left intact (so write round-trips and the admin pickers keep working).

## Relations

`getOne(db, coll, id, depth, locale, publishedOnly=true)` per related id, attached under `$<name>` (single →
the record or `null`; many → an array with stale ids filtered out). Because it reuses `getOne`, the related
record is itself populated — so `lineup.$speakers[i].$media.photo` resolves in one read. Semantics:

- **Depth** — the related read runs at `ctx.depth - 1`; `populateRow` bails at 0, so a `depth: 2` read gives
  `related → its media`, a `depth: 1` read gives the related record **raw** (its own refs unresolved), and a
  relation cycle always terminates.
- **Published-only** — a draft/missing/deleted target is skipped (single → `null`, many → dropped), never
  leaked to a public read and never 404-ing the whole record.
- **Public set** — the generic `/api/<collection>` read routes set `ctx.publicOnly` for an **anonymous**
  principal (and for a missing one, which is a guard regression and fails closed onto it), and a relation
  whose target collection is outside the registry-driven public set (`publicReadableResources()`) is then
  left unexpanded — raw id only, no `$<name>` at all — at every hop. Population must not reach a record the
  caller could not have requested directly. It follows the **role**, not the read scope: the renderer is
  published-only too, but it builds the static site and keeps full population. Where the bound stops:
  the set is not the guard's whole decision (it omits `registeredGrants()`, so the populator is if anything
  stricter than the route that serves the same collection), and `/api/route` — the public render entry,
  which every principal may call — never sets the flag at all, so a live render populates in full for
  anyone. `?depth` on the generic routes is bounded; the render entry is not.

  **The flag bounds an API, not the data's reach.** The render entry has to populate in full — the flag
  would strip every non-page-like relation out of the static site — and what it populates is serialised
  into each generated page's hydration payload, so it is published regardless. The authoritative exposure
  boundary is therefore the bake, not the guard: treat any collection reachable from a page-like record's
  relations as public, and project it here if it holds columns that must not ship. See
  [static-output.md](./static-output.md).
- **Output shape** — the raw id column is untouched; the resolved record(s) live under the `$<name>` sibling.

## Per-instance override

A `FieldDef` may carry an inline `populate` (Pruvious `additional.population`) that the walker runs instead of
the type default for that one field — e.g. a relation projecting only a couple of columns. Server-only; a
function, so it is never serialized to the admin. It replaces the type populator wholesale, so an override
that expands a reference owns the `ctx.publicOnly` check too.

```ts
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

**To narrow a relation, delegate first — do not re-read the table.** The type populator is what calls
`captureRead` on the target, so an override that fetches the record itself drops the read-tag: the page
would then never re-publish when the related record changes, silently and only in the incremental
publisher. Run the registered populator, then trim what it attached:

```ts
populate: (bag, key, field, ctx, keyMode) => {
  getFieldPopulator('relation')?.(bag, key, field, ctx, keyMode)
  const rel = bag['$' + key] as { id: number; name: string } | null
  if (rel) bag['$' + key] = { id: rel.id, name: rel.name }
},
```

This is also how a private column is kept out of the static bake, since the renderer populates in full —
and it is payload shaping, not access control: a depth-0 read of the collection itself still returns the
column to anyone the access layer admits.
