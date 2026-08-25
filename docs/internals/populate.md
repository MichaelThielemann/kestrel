# Read-time population

When a record is read at `depth > 0`, Kestrel **populates** reference-bearing fields — resolving media ids to
URLs, internal links to localized hrefs, and relations to the related records, per-field-type and recursively —
so the public render and the editor preview get ready-to-use data instead of raw ids.

## The seam

`packages/kestrel-core/src/server/utils/populate.ts` owns two registries:

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

A `FieldDef` may also carry an inline `populate` override that wins over the type default for that one
field — see [custom-field-types.md](../guide/custom-field-types.md) for how to write one and how to narrow a
relation without dropping its read-tag.

## The walker

`packages/kestrel-fields/src/server/utils/field-populate.ts` — `buildFieldTreePopulator()` is the single
global populator. It walks a record's top-level fields (COLUMNS key-mode), its `seo` system column when the
collection has one (PROPS mode, so the social-image media id resolves under `seo.$media.image`), and — when
blocks are enabled — the block tree (each node's props in PROPS mode + every slot), dispatching each field to
its registered per-type populator. It **recurses repeater entries** (PROPS mode) at every level, so media /
links / relations nested inside a repeater — top-level or in block props — resolve too, not just top-level
fields.

**Key-mode** captures the storage asymmetry: a single relation/media is `${name}Id` in top-level columns but
bare `name` in block props / repeater entries; everything else is bare-keyed in both.

Population is **non-destructive**: the walker clones the row, block nodes/props, and repeater entries; raw id
columns are left intact, so write round-trips and the admin pickers keep working.

```ts
export function buildFieldTreePopulator(lookup: PopulatorLookup = getFieldPopulator): Populator {
  return (row, ctx) => {
    const out: Record<string, unknown> = { ...row }
    applyFieldPopulators(out, ctx.def.fields, 'columns', ctx, lookup)
    if (ctx.def.seo && out.seo && typeof out.seo === 'object') {
      const seoBag = { ...(out.seo as Record<string, unknown>) }
      applyFieldPopulators(seoBag, seoPopulateFields, 'props', ctx, lookup)
      out.seo = seoBag
    }
    if (ctx.def.blocks?.enabled && Array.isArray(out.content)) {
      const walk = buildBlockPopulator((props, fields) => applyFieldPopulators(props, fields, 'props', ctx, lookup))
      out.content = walk(out.content)
    }
    return out
  }
}
```

## Relations

`buildRelationFieldPopulator` resolves each relation id through an injected `ResolveRecord` (the plugin wires
the real `getOne`), attaching the result under `$<name>` (single → the record or `null`; many → an array with
stale ids filtered out). Because the related read is itself populated, `lineup.$speakers[i].$media.photo`
resolves in one read. Semantics:

- **Depth** — the related read runs at `ctx.depth - 1`; `populateRow` bails at 0, so a `depth: 2` read gives
  `related → its media`, a `depth: 1` read gives the related record **raw** (its own refs unresolved), and a
  relation cycle always terminates.
- **Published-only** — the related read is always published-only: the relation-populate plugin calls
  `getOne(db, built, id, depth, locale, true, publicOnly)` with `publishedOnly` hard-coded to `true`,
  regardless of the outer read's own scope, so a draft relation target 404s and is skipped even on an
  authenticated admin read at scope `'all'` (including the `/api/route` draft preview). Only that
  not-found (via `skipMissing`) is skipped this way, mapped to `null` (single) or dropped (many); any other
  error — a DB fault, a downstream populator throwing on malformed stored data — propagates instead of being
  swallowed, so a relation lost to a DB fault or a throwing populator never quietly disappears from a page
  that still renders and records success. The resolve-scope budget below is the one case where a reference
  IS dropped silently instead of erroring.
- **Public set** — `publicOnlyOf` (`read-shared.ts`) resolves `ctx.publicOnly` from `ctx.work.publicOnly`:
  the CRUD facade's `list`/`getOne`/`getSingleton` all take a `publicOnly` parameter (default `false`) and
  always thread it into `work`, so a programmatic read always pins the flag (the relation populator's own
  recursive read pins it explicitly too), falling back to the **role** — not the read scope — only when
  unset: the generic
  `/api/<collection>` pipelines leave `work.publicOnly` unset for an HTTP request, so it resolves from the
  principal's role (fail-closed to `true` for a missing principal too). Keying on role rather than scope is
  why the static-site renderer, whose principal carries role `renderer` and reads published-only, still
  resolves `publicOnly` to `false` and sees every relation the output embeds. Under it, a relation whose target collection is
  outside the registry-driven public set (`publicReadableResources()`) is left unexpanded — raw id only, no
  `$<name>` at all — at every hop; the set is not the guard's whole decision either — it omits
  `registeredGrants()`, so the populator is if anything stricter than the route serving the same collection.
- **Output shape** — the raw id column is untouched; the resolved record(s) live under the `$<name>` sibling.

`?depth` is clamped to `MAX_DEPTH = 10` (`read-shared.ts`, applied for the list route in
`read-parse-query.ts` and the detail route in `read-populate.ts`) — an attacker-controlled query param
would otherwise drive unbounded synchronous DB reads; see "Cost and the resolve scope" below for the rest
of what bounds a populate run. `/api/route`, the public render entry every principal may call, is not
attacker-controlled at all: `resolvePage` (`page-resolve.ts`) and the site singleton (`route.ts`) both read
at a fixed `depth: 1` through the CRUD facade, which pins `publicOnly` to its `false` default — so the
public-set restriction is off for every caller of `/api/route`, renderer and anonymous alike, without the
role fallback ever running. What "in full" means here is that restriction lifted, not unbounded depth. What
it resolves is serialised into each generated page's hydration payload and shipped regardless. The
authoritative exposure boundary is therefore the bake, not the guard — see [publishing.md](./publishing.md).

## Cost and the resolve scope

Every populate call — the generic `readMany`/`readOne` pipelines, `/api/route`, and the editor preview
ticket (which populates the ticket's *unsaved* values, not a stored row, at a fixed `depth: 1` with
`ctx.publicOnly` left unset so it resolves unrestricted, like the render path) — runs inside a
`withResolveScope` from `packages/kestrel-core/src/server/utils/resolve-scope.ts`. Where `MAX_DEPTH` bounds
recursion depth, the resolve scope bounds the fan-out at each depth:

- **Per-scope dedup** — one shared cache for the whole request/run, so each distinct target
  (`media:<id>:<locale>`, `link:<collection>:<id>`, `rel:<collection>:<id>:<depth>:<locale>:<publicOnly>`)
  resolves once no matter how many rows or fields reference it.
- **Distinct-resolve budget** — `REQUEST_RESOLVE_BUDGET = 20_000`, scaled by `resolveBudgetFor(perPage)`
  (`perPage * 200`) so a full legitimate page still populates. Past it, a NEW target degrades to `null` —
  the same shape as a stale reference — with one `console.warn` per scope and the request still answering
  `200`. This is the one place a reference is dropped silently, unlike the error path in the
  Published-only bullet above, which always propagates.
- **Nested scopes reuse the outermost one** — the relation populator's recursive `getOne` inherits the
  enclosing request's scope rather than opening its own, so the dedup and the budget are per top-level
  call, not per hop.
- **Composition order** — all three populators wrap their resolver as
  `memoResolver(memoDuringPrerender(fn, key), key)` with `memoResolver` outermost, so a budget-skip `null`
  is scoped to the live request/run and never cached into the build-wide prerender memo.
- **Read capture** — each populator calls `captureRead(collection, id)` around the memoized resolve (media,
  relations) or before resolving (links/richtext, which also tag a *draft* target, so publishing it
  re-renders the referrer); a memo hit still replays the tags captured on the miss. This is what ties a
  rendered route to the records it embedded, and why a `populate` override must delegate to the registered
  populator rather than re-read the table — see [custom-field-types.md](../guide/custom-field-types.md).

## See also

- [custom-field-types.md](../guide/custom-field-types.md) — writing a per-field `populate` override and
  narrowing a relation projection.
- [publishing.md](./publishing.md) — snapshots, delivery, and why the bake bounds what actually ships.
- [pipeline-engine.md](./pipeline-engine.md) — where `depth`, `publicOnly`, and the read pipelines that call
  into population are defined.
- [data-model.md](./data-model.md) — the record shape population reads and mutates.
