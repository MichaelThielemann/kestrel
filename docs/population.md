# Read-time population

When a record is read at `depth > 0`, Kestrel **populates** reference-bearing fields — resolving media ids
to URLs, internal links to localized hrefs, and relations to the related records — so the public render and
the editor preview get ready-to-use data instead of raw ids. This is Pruvious-style, per-field-type, and
recursive.

## The seam

`layers/core/server/utils/populate.ts` owns two registries:

- **`registerPopulator(fn)`** — whole-row populators, run in turn by `populateRow(row, ctx)`
  (`ctx = { depth, locale, def }`), bailing at `depth <= 0`. There is exactly **one** today: the field-tree
  walker.
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
- **Output shape** — the raw id column is untouched; the resolved record(s) live under the `$<name>` sibling.

## Per-instance override

A `FieldDef` may carry an inline `populate` (Pruvious `additional.population`) that the walker runs instead of
the type default for that one field — e.g. a relation projecting only a couple of columns. Server-only; a
function, so it is never serialized to the admin.

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
